import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import * as fs from 'fs'
import { writeFileSync, mkdirSync } from 'fs'
import * as path from 'path'
import { join } from 'path'
import { randomUUID } from 'crypto'

/**
 * Persist a base64 image returned by a provider (b64_json path) to
 * public/uploads/ and return its `/uploads/<uuid>.<ext>` URL. The
 * client must never see raw `data:image/png;base64,…` URLs — they end
 * up in Zustand stores, balloon the IDB snapshot past the 5 MB cap in
 * idb-storage.ts, and the silent write-refusal makes new items vanish
 * on refresh.
 */
function saveBase64ImageToUploads(b64: string, mime = 'image/png'): string {
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg'
    : mime.includes('webp') ? '.webp'
    : '.png'
  const uploadsDir = join(process.cwd(), 'public', 'uploads')
  mkdirSync(uploadsDir, { recursive: true })
  const filename = `${randomUUID()}${ext}`
  writeFileSync(join(uploadsDir, filename), Buffer.from(b64, 'base64'))
  return `/uploads/${filename}`
}

interface Req {
  provider: string;
  model: string;
  prompt: string;
  refImages?: string[];
  aspect?: string;
  duration?: number;
  negativePrompt?: string;
  seed?: number;
  guidanceScale?: number;
  resolution?: string;
  generateAudio?: boolean;
  numImages?: number;
  fps?: number;
}

async function readJson(req: IncomingMessage): Promise<Req> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : ({} as Req)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** Poll a URL until it returns a terminal state (used for async queue APIs). */
async function poll<T>(
  fn: () => Promise<{ done: boolean; result?: T; error?: string }>,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.intervalMs))
    const r = await fn()
    if (r.error) throw new Error(r.error)
    if (r.done && r.result != null) return r.result
  }
  throw new Error('timeout')
}

// ─── FAL ──────────────────────────────────────────────────────────────
async function runFal(req: Req): Promise<{ url: string; kind: 'image' | 'video'; urls?: string[] }> {
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const isVideo = /video|wan|kling|minimax|hunyuan/i.test(req.model)
  const body: Record<string, unknown> = { prompt: req.prompt }
  if (isVideo) {
    // Video model params
    if (req.refImages?.length) body.image_url = req.refImages[0]
    if (req.duration) body.duration = `${req.duration}s`
    if (req.aspect) body.aspect_ratio = req.aspect
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt
    if (req.seed != null) body.seed = req.seed
  } else {
    // Image model params
    body.image_size = req.aspect === '1:1' ? 'square_hd' : req.aspect === '9:16' ? 'portrait_hd' : 'landscape_16_9'
    body.num_images = req.numImages ?? 1
    if (req.refImages?.length) body.image_url = req.refImages[0]
    if (req.negativePrompt) body.negative_prompt = req.negativePrompt
    if (req.seed != null) body.seed = req.seed
    if (req.guidanceScale != null) body.guidance_scale = req.guidanceScale
  }
  const res = await fetch(`https://fal.run/${req.model}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`FAL ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { images?: { url: string }[]; video?: { url: string } }
  if (data.video?.url) {
    return { url: data.video.url, kind: 'video' }
  }
  const urls = data.images?.map((i) => i.url) ?? []
  if (urls.length === 0) throw new Error('FAL: no media in response')
  return { url: urls[0], kind: 'image', urls: urls.length > 1 ? urls : undefined }
}

// ─── BytePlus Ark (Dreamina — Seedance / Seedream) ────────────────────
// Routed through ark.ap-southeast.bytepluses.com (BytePlus海外侧).
// The legacy cn-beijing.volces.com (火山方舟国内) endpoints were removed —
// they bill against a different account that ran out of balance.
//
// Bearer token: BYTEPLUS_ARK_API_KEY (海外侧 ark-*); ARK_API_KEY is
// honored as a legacy fallback for envs that haven't been migrated.
// Base URL: ARK_BASE_URL / ARK_API_BASE_URL; defaults to海外侧.
function bytePlusApiKey(): string {
  const k = process.env.BYTEPLUS_ARK_API_KEY || process.env.ARK_API_KEY
  if (!k) throw new Error('BYTEPLUS_ARK_API_KEY (or legacy ARK_API_KEY) not set')
  return k
}
function bytePlusBaseUrl(): string {
  const raw = process.env.ARK_BASE_URL || process.env.ARK_API_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3'
  return raw.replace(/\/+$/, '')
}

/**
 * Map the universal Seedance model id passed by the UI to the account-specific
 * endpoint id BytePlus海外 requires for video task creation. Mirror of the
 * resolver in vite-capabilities-plugin.ts — kept duplicated to avoid coupling
 * the two Vite plugin files (they run as independent middleware modules).
 */
function resolveSeedanceModel(model: string): string {
  if (/^ep-/.test(model)) return model
  const envSlug = `SEEDANCE_ENDPOINT_${model.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`
  const perModelEnv = process.env[envSlug]
  if (perModelEnv) return perModelEnv
  const table: Record<string, string> = {
    'dreamina-seedance-2-0-fast-260128': 'ep-20260423151341-p2zm9',
  }
  if (table[model]) return table[model]!
  return process.env.SEEDANCE_ENDPOINT || process.env.ARK_SEEDANCE_ENDPOINT || model
}

async function runBytePlusImage(req: Req): Promise<{ url: string; kind: 'image' }> {
  const key = bytePlusApiKey()
  // Seedream 5.0+ requires ≥ 3,686,400 pixels (2K). Older models accept 1K.
  const needs2K = /seedream-[5-9]|seedream-\d{2,}/i.test(req.model)
  const size2K: Record<string, string> = {
    '1:1': '2048x2048', '16:9': '2560x1440', '9:16': '1440x2560',
    '4:3': '2240x1680', '3:4': '1680x2240', '21:9': '3024x1296',
  }
  const size1K: Record<string, string> = {
    '1:1': '1024x1024', '16:9': '1920x1088', '9:16': '1088x1920',
    '4:3': '1408x1056', '3:4': '1056x1408', '21:9': '2016x864',
  }
  const sizeMap = needs2K ? size2K : size1K
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    size: sizeMap[req.aspect ?? '16:9'] ?? (needs2K ? '2560x1440' : '1920x1088'),
    response_format: 'url',
    n: req.numImages ?? 1,
  }
  if (req.seed != null && req.seed >= 0) body.seed = req.seed
  if (req.guidanceScale != null) body.guidance_scale = req.guidanceScale
  if (req.negativePrompt) body.negative_prompt = req.negativePrompt
  // Reference images: Seedream supports image-to-image via `image` param (string or array)
  const validRefs = (req.refImages ?? []).filter((u) => u && (u.startsWith('http') || u.startsWith('data:')))
  if (validRefs.length > 0) {
    body.image = validRefs.length === 1 ? validRefs[0] : validRefs.slice(0, 10)
  }
  const res = await fetch(`${bytePlusBaseUrl()}/images/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`BytePlus ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { data?: { url: string }[] }
  const url = data.data?.[0]?.url
  if (!url) throw new Error('BytePlus: no image in response')
  return { url, kind: 'image' }
}

async function runBytePlusVideo(req: Req): Promise<{ url: string; kind: 'video' }> {
  const key = bytePlusApiKey()
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
  const base = bytePlusBaseUrl()

  // Create async task using Seedance 2.0 API format
  const contentParts: Array<Record<string, unknown>> = [
    { type: 'text', text: req.prompt },
  ]
  const validRefs = (req.refImages ?? []).filter((u) => u && u.length > 10 && /^https?:\/\//i.test(u))
  if (validRefs.length === 1) {
    contentParts.push({ type: 'image_url', image_url: { url: validRefs[0] }, role: 'first_frame' })
  } else if (validRefs.length > 1) {
    for (const u of validRefs.slice(0, 9)) {
      contentParts.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' })
    }
  }

  const body: Record<string, unknown> = {
    model: resolveSeedanceModel(req.model),
    content: contentParts,
    resolution: req.resolution ?? '480p',
    ratio: req.aspect ?? '16:9',
    duration: Math.max(4, Math.min(15, Math.round(req.duration ?? 5))),
    generate_audio: req.generateAudio ?? true,
  }
  if (req.seed != null && req.seed >= 0) body.seed = req.seed
  const createRes = await fetch(`${base}/contents/generations/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!createRes.ok) throw new Error(`BytePlus video create ${createRes.status}: ${await createRes.text()}`)
  const createData = (await createRes.json()) as { id?: string }
  const taskId = createData.id
  if (!taskId) throw new Error('BytePlus: no task id')

  const extractVideoUrl = (d: Record<string, unknown>): string | null => {
    const candidates = [
      (d.content as { video_url?: string } | undefined)?.video_url,
      ((d.output as Record<string, unknown> | undefined)?.video as { url?: string } | undefined)?.url,
      (d as { video_url?: string }).video_url,
    ]
    return candidates.find((u): u is string => typeof u === 'string' && u.length > 0) ?? null
  }

  const url = await poll<string>(
    async () => {
      const r = await fetch(`${base}/contents/generations/tasks/${taskId}`, { headers })
      if (!r.ok) return { done: false, error: `status ${r.status}: ${await r.text()}` }
      const d = (await r.json()) as Record<string, unknown>
      const status = d.status as string | undefined
      const video = extractVideoUrl(d)
      if ((status === 'succeeded' || video) && video) return { done: true, result: video }
      if (status === 'failed' || status === 'cancelled') {
        return { done: false, error: `task ${status}: ${JSON.stringify(d.error ?? d).slice(0, 300)}` }
      }
      return { done: false }
    },
    { intervalMs: 4000, timeoutMs: 6 * 60 * 1000 },
  )
  return { url, kind: 'video' }
}

// ─── OpenAI image ─────────────────────────────────────────────────────
async function runOpenAI(req: Req): Promise<{ url: string; kind: 'image' }> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      prompt: req.prompt,
      size: req.aspect === '1:1' ? '1024x1024' : '1792x1024',
      n: 1,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { data?: { url?: string; b64_json?: string }[] }
  const item = data.data?.[0]
  const url = item?.url ?? (item?.b64_json ? saveBase64ImageToUploads(item.b64_json) : undefined)
  if (!url) throw new Error('OpenAI: no image')
  return { url, kind: 'image' }
}

// ─── Apimart (OpenAI-compatible) ─────────────────────────────────
//
// 2026-05-23: Apimart migrated to api.apimart.ai + a task-based image
// API. See the matching comment in vite-capabilities-plugin.ts for the
// full rationale; this plugin handles the /providers/generate path
// (GenerateDialog and direct provider calls) — same shape, separate
// codebase by design.
const APIMART_BASE_URL = 'https://api.apimart.ai/v1'
const APIMART_TEXT_MODEL = 'gemini-3-flash-preview'

function normalizeApimartImageModel(model: string): string {
  const aliases: Record<string, string> = {
    'openai/gpt-5.4-image-2': 'gpt-image-2',
    'openai/gpt-5.4-image': 'gpt-image-2',
    'openai/gpt-image-2': 'gpt-image-2',
    'google/gemini-3-flash-preview-image': 'gemini-3-flash-preview-image-preview-official',
    'google/gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image-preview-official',
    'google/gemini-3-pro-image-preview': 'gemini-3-pro-image-preview',
  }
  if (aliases[model]) return aliases[model]!
  const slash = model.indexOf('/')
  if (slash > 0) return model.slice(slash + 1)
  return model
}

function apimartBaseUrl(): string {
  return (process.env.APIMART_BASE_URL || APIMART_BASE_URL).replace(/\/$/, '')
}

async function apimartChat(systemPrompt: string, userText: string, temperature?: number): Promise<string> {
  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY not set')
  const res = await fetch(`${apimartBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.APIMART_TEXT_MODEL || APIMART_TEXT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      ...(temperature != null ? { temperature } : {}),
    }),
  })
  if (!res.ok) throw new Error(`Apimart chat ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('Apimart: empty response')
  return text
}

// ─── Apimart image (covers gemini provider + tokenrouter provider) ─────
//
// Reference images for gpt-image-2 / openai/gpt-5.4-image-2 must go
// through /v1/images/edits (multipart, `image[]` repeated) — the
// /generations endpoint does NOT accept refs in OpenAI's API. The old
// `body.image = refs` JSON shape returned 4xx and the refs were
// silently dropped, which is why every canvas generate-with-reference
// produced an output that didn't resemble the reference asset.
/**
 * Same-origin URL → local public/ path, else null. Browser converts
 * `/uploads/x.png` → `http://35.168.148.47/uploads/x.png` before sending
 * to /providers/generate; server-side fetch of its own URL hits nginx
 * which returns 403 for server-to-server. Read from disk instead.
 */
function maybeLocalPathFor(url: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url
  if (!/^https?:\/\//i.test(url)) return null
  try {
    const u = new URL(url)
    if (u.pathname.startsWith('/uploads/') || u.pathname.startsWith('/voices/') || u.pathname.startsWith('/samples/')) {
      return u.pathname
    }
  } catch { /* malformed url */ }
  return null
}

const REF_MAX_EDGE = 1280
const REF_JPEG_QUALITY = 85

/**
 * Safety cap for the total multipart body shipped to Apimart /images/edits.
 * See vite-capabilities-plugin.ts for the full rationale — keep the two
 * values in sync (intentionally duplicated; the plugins target different
 * code paths and don't share helpers).
 */
const APIMART_MULTIPART_BUDGET_BYTES = 18 * 1024 * 1024

async function compressRefForUpload(
  buf: Buffer,
): Promise<{ buf: Buffer; mime: string; ext: string }> {
  try {
    const sharpMod = await import('sharp')
    const sharp = sharpMod.default
    const out = await sharp(buf, { failOn: 'none' })
      .rotate() // honor EXIF orientation before resize
      .resize({
        width: REF_MAX_EDGE,
        height: REF_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: REF_JPEG_QUALITY, mozjpeg: true })
      .toBuffer()
    return { buf: out, mime: 'image/jpeg', ext: 'jpg' }
  } catch (e) {
    console.warn(`[providers] sharp compress failed (${(e as Error).message}); using raw buffer`)
    return { buf, mime: 'image/png', ext: 'png' }
  }
}

/**
 * Resolve a ref URL for the api.apimart.ai `image: [...]` body field.
 * - data: URLs → passthrough.
 * - same-origin /uploads/ → read from disk, compress, return as data URL
 *   (nginx 403s server-to-server fetches of /uploads/ on the public IP).
 * - public http(s):// → passthrough.
 */
async function refToApimartImageRef(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  let buf: Buffer | null = null
  if (/^https?:\/\//i.test(url)) {
    const local = maybeLocalPathFor(url)
    if (!local) return url
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const decoded = decodeURIComponent(local.split('?')[0] ?? local)
    buf = readFileSync(join(process.cwd(), 'public', decoded))
  } else {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const decoded = decodeURIComponent(url.split('?')[0] ?? url)
    buf = readFileSync(join(process.cwd(), 'public', decoded))
  }
  const compressed = await compressRefForUpload(buf!)
  return `data:${compressed.mime};base64,${compressed.buf.toString('base64')}`
}

interface ApimartTaskResult {
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string
  progress?: number
  result?: { images?: Array<{ url?: string | string[]; expires_at?: number }> }
  error?: { code?: string; message?: string }
}

async function pollApimartTask(taskId: string, opts: { timeoutMs?: number } = {}): Promise<string[]> {
  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY missing')
  const timeoutMs = opts.timeoutMs ?? 180_000
  const deadline = Date.now() + timeoutMs
  let interval = 2000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    const r = await fetch(`${apimartBaseUrl()}/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${key}` },
    })
    if (!r.ok) {
      const errText = (await r.text()).slice(0, 400)
      throw new Error(`Apimart task poll ${r.status}: ${errText}`)
    }
    const wrapper = (await r.json()) as { code?: number; data?: ApimartTaskResult; error?: { message?: string } }
    const task = wrapper.data
    if (!task) throw new Error(`Apimart task poll: no data in response (${JSON.stringify(wrapper).slice(0, 200)})`)
    if (task.status === 'completed') {
      const images = task.result?.images ?? []
      const urls = images.flatMap((img) => (Array.isArray(img.url) ? img.url : (img.url ? [img.url] : [])))
        .filter((u): u is string => Boolean(u))
      if (urls.length === 0) throw new Error(`Apimart task ${taskId} completed but returned no image URLs`)
      return urls
    }
    if (task.status === 'failed') {
      throw new Error(`Apimart task ${taskId} failed: ${task.error?.message ?? 'unknown error'}`)
    }
    interval = Math.min(5000, interval + 500)
  }
  throw new Error(`Apimart task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s`)
}

async function runApimartImage(req: Req, providerPrefix?: string): Promise<{ url: string; kind: 'image' }> {
  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY not set')
  const rawModel = req.model.includes('/') ? req.model : `${providerPrefix ?? ''}${req.model}`
  const model = normalizeApimartImageModel(rawModel)
  const REF_CAP = 8
  const allRefs = (req.refImages ?? []).filter((u) => /^https?:\/\//i.test(u) || u.startsWith('data:') || u.startsWith('/'))
  if (allRefs.length > REF_CAP) {
    console.warn(`[providers] ref cap (${REF_CAP}) hit — dropping ${allRefs.length - REF_CAP} of ${allRefs.length} refs.`)
  }
  const refs = allRefs.slice(0, REF_CAP)

  const imageRefs: string[] = []
  const skipped: string[] = []
  let totalBodyBytes = 0
  for (let i = 0; i < refs.length; i++) {
    try {
      const v = await refToApimartImageRef(refs[i]!)
      const addBytes = v.length + 4
      if (imageRefs.length > 0 && totalBodyBytes + addBytes > APIMART_MULTIPART_BUDGET_BYTES) {
        console.warn(
          `[providers] body budget hit at ref ${i + 1}/${refs.length}: cumulative=${totalBodyBytes}B, would add=${addBytes}B, cap=${APIMART_MULTIPART_BUDGET_BYTES}B — dropping remaining ${refs.length - i} refs.`,
        )
        break
      }
      imageRefs.push(v)
      totalBodyBytes += addBytes
    } catch (e) {
      const msg = `ref ${i + 1} (${refs[i]?.slice(0, 60)}…): ${(e as Error).message}`
      skipped.push(msg)
      console.warn(`[providers] skipping ${msg}`)
    }
  }
  if (refs.length > 0 && imageRefs.length === 0) {
    throw new Error(`图片生成失败：${refs.length} 张参考图全部无法读取。详情：\n${skipped.join('\n')}`)
  }

  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    n: req.numImages ?? 1,
    aspect_ratio: req.aspect ?? '16:9',
  }
  if (imageRefs.length > 0) body.image = imageRefs

  console.log(`[providers] Apimart submit  model=${model}  refs=${imageRefs.length}/${refs.length}  aspect=${req.aspect ?? '16:9'}  bodyKB=${(totalBodyBytes / 1024).toFixed(0)}`)
  const submitRes = await fetch(`${apimartBaseUrl()}/images/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!submitRes.ok) {
    const err = (await submitRes.text()).slice(0, 600)
    throw new Error(`Apimart image submit ${submitRes.status}: ${err}`)
  }
  const submitJson = (await submitRes.json()) as {
    code?: number
    data?: Array<{ task_id?: string; url?: string; b64_json?: string }>
    images?: Array<{ url?: string; b64_json?: string }>
    error?: { message?: string }
  }

  // Tolerate a sync legacy response (some models or fallback paths
  // may still return {data:[{url|b64_json}]} immediately).
  const legacyArr: Array<{ url?: string; b64_json?: string }> = []
  for (const item of submitJson.data ?? []) {
    if ((item as { url?: string }).url) legacyArr.push({ url: (item as { url?: string }).url })
    if ((item as { b64_json?: string }).b64_json) legacyArr.push({ b64_json: (item as { b64_json?: string }).b64_json })
  }
  for (const item of submitJson.images ?? []) legacyArr.push(item)
  const legacyUrl =
    legacyArr.find((i) => i.url)?.url
    ?? (legacyArr.find((i) => i.b64_json)?.b64_json
      ? saveBase64ImageToUploads(legacyArr.find((i) => i.b64_json)!.b64_json!)
      : undefined)
  if (legacyUrl) return { url: legacyUrl, kind: 'image' }

  const taskId = submitJson.data?.[0]?.task_id
  if (!taskId) {
    throw new Error(`Apimart image: no task_id in submit response (${JSON.stringify(submitJson).slice(0, 400)})`)
  }
  const urls = await pollApimartTask(taskId)
  if (urls.length === 0) throw new Error('Apimart: no image URLs after task completion')
  return { url: urls[0]!, kind: 'image' }
}

// ─── Prompt optimizer (Gemini text) ───────────────────────────────────
interface OptimizeReq {
  prompt: string;
  kind: 'image' | 'video';
  aspect?: string;
  duration?: number;
  mode?: 'default' | 'seedance-universal';
  refImages?: string[];
}

async function optimizePrompt(req: OptimizeReq): Promise<{ prompt: string }> {
  const durLine = req.kind === 'video' && req.duration ? `- Total duration: ~${req.duration}s` : ''
  const ratioLine = req.aspect ? `- Aspect ratio: ${req.aspect}` : ''
  const refCount = req.refImages?.length ?? 0

  let sys: string
  if (req.mode === 'seedance-universal' && refCount > 0) {
    // Seedance 2.0 universal multi-reference prompt with @图片N syntax
    const refList = Array.from({ length: refCount }, (_, i) => `@图片 ${i + 1}`).join('、')
    sys = `You are a Seedance 2.0 video prompt specialist for multi-reference generation.
The user provides ${refCount} reference images (referenced as ${refList}) and a creative brief.
Rewrite the brief into a Seedance 2.0 universal-reference prompt that:
- Uses @图片 1, @图片 2, ... syntax to reference each image by number
- Explicitly describes WHAT each referenced image contributes (character? scene? prop? style?)
- Example format: "参考@图片 1 的男主角和@图片 2 的女主角，在@图片 3 的森林场景中漫步，镜头缓慢推进"
- Includes camera movement and shot composition
- Target duration: ~${req.duration ?? 5}s
- Write in Chinese (Seedance handles Chinese natively)

Return ONE cohesive prompt paragraph, no markdown, under 200 characters.`
  } else if (req.kind === 'video') {
    sys = `You are a cinematography director. Rewrite the user's brief into a rich video generation prompt.
Break the ${req.duration ?? 5}-second clip into 1-3 shots. For each shot include:
- Shot type (close-up / medium / wide / establishing)
- Camera movement (dolly / pan / tilt / zoom / static / handheld)
- Composition (rule of thirds / centered / leading lines)
- Lighting & mood (golden hour / soft overhead / dramatic rim light etc.)
- Duration in seconds (sum must equal total)

Return ONE cohesive prompt paragraph (no JSON, no numbered list, no markdown) in English, ending with --ratio ${req.aspect ?? '16:9'}. Keep it under 180 words.`
  } else {
    sys = `You are an image art director. Rewrite the user's brief into a rich still image prompt with:
- Subject & action
- Composition and framing (${req.aspect ?? '16:9'})
- Lens choice (e.g. 35mm, 85mm, wide angle)
- Lighting (direction, quality, color temperature)
- Mood & style references

Return ONE cohesive prompt paragraph in English, no markdown, under 120 words.`
  }

  const userMsg = [
    `Brief: ${req.prompt}`,
    ratioLine,
    durLine,
  ].filter(Boolean).join('\n')

  const text = await apimartChat(sys, userMsg, 0.8)
  return { prompt: text }
}

// ─── Voice revise (audio → revised image-gen prompt, frontend-only) ───
interface VoiceRevisePlan {
  new_prompt: string
  user_intent: string
  transcript: string
  key_changes?: string[]
  preserve?: string[]
  severity?: 'minor' | 'moderate' | 'major'
}

async function readMultipart(req: IncomingMessage): Promise<{ audio: Buffer; audioMime: string; fields: Record<string, string> }> {
  const ct = req.headers['content-type'] || ''
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/)
  if (!m) throw new Error('voice-revise: missing multipart boundary')
  const boundary = '--' + (m[1] ?? m[2]).trim()
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks)
  const parts: { name: string; filename?: string; contentType?: string; data: Buffer }[] = []
  let idx = raw.indexOf(boundary)
  while (idx >= 0) {
    const start = idx + boundary.length
    if (raw.slice(start, start + 2).toString() === '--') break
    const headerEnd = raw.indexOf('\r\n\r\n', start)
    if (headerEnd < 0) break
    const headers = raw.slice(start, headerEnd).toString('utf8')
    const next = raw.indexOf(boundary, headerEnd + 4)
    if (next < 0) break
    const data = raw.slice(headerEnd + 4, next - 2) // strip trailing \r\n
    const nameM = headers.match(/name="([^"]+)"/)
    const fileM = headers.match(/filename="([^"]*)"/)
    const ctM = headers.match(/Content-Type:\s*(\S+)/i)
    if (nameM) parts.push({ name: nameM[1], filename: fileM?.[1], contentType: ctM?.[1], data })
    idx = next
  }
  const audioPart = parts.find((p) => p.name === 'audio' && p.filename != null)
  if (!audioPart) throw new Error('voice-revise: no audio field')
  const fields: Record<string, string> = {}
  for (const p of parts) if (p.name !== 'audio') fields[p.name] = p.data.toString('utf8')
  return { audio: audioPart.data, audioMime: audioPart.contentType || 'audio/webm', fields }
}

function audioFormatFromMime(mime: string): string {
  // Apimart / OpenAI input_audio supports: wav, mp3. Gemini-3 also accepts webm/ogg in practice.
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

async function voiceRevise(req: IncomingMessage): Promise<VoiceRevisePlan> {
  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY not set')
  const { audio, audioMime, fields } = await readMultipart(req)
  const elementKind = fields.element_kind || 'image'
  const elementContext = fields.element_context ? JSON.parse(fields.element_context) : {}
  const audioB64 = audio.toString('base64')
  const format = audioFormatFromMime(audioMime)

  const sys = `You are a prompt-revision assistant for an AI image generator. The user has just recorded spoken feedback about a ${elementKind}. Listen to the audio, then output a JSON object describing how to revise the current generation prompt.

Current element context (the user is talking about this):
${JSON.stringify(elementContext, null, 2).slice(0, 1500)}

Return JSON ONLY, no markdown, with this shape:
{
  "transcript": "<verbatim transcript of the audio>",
  "user_intent": "<one sentence in the user's language summarising what they want changed>",
  "new_prompt": "<a complete revised image-generation prompt that incorporates the user's feedback. Preserve everything in the original that wasn't criticised. Use English unless the original context is Chinese-heavy.>",
  "key_changes": ["short bullet of what changed", ...],
  "preserve": ["what was kept", ...],
  "severity": "minor | moderate | major"
}`

  const res = await fetch(`${apimartBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.APIMART_TEXT_MODEL || APIMART_TEXT_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: [
          { type: 'text', text: 'Here is my spoken feedback. Listen and produce the revision JSON.' },
          { type: 'input_audio', input_audio: { data: audioB64, format } },
        ] },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Apimart voice-revise ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content?.trim() ?? ''
  const jsonM = text.match(/\{[\s\S]*\}/)
  if (!jsonM) throw new Error(`voice-revise: model did not return JSON. Got: ${text.slice(0, 200)}`)
  const plan = JSON.parse(jsonM[0]) as Partial<VoiceRevisePlan>
  if (!plan.new_prompt) throw new Error('voice-revise: missing new_prompt in model output')
  return {
    new_prompt: plan.new_prompt,
    user_intent: plan.user_intent ?? '',
    transcript: plan.transcript ?? '',
    key_changes: plan.key_changes,
    preserve: plan.preserve,
    severity: plan.severity,
  }
}

async function textRevise(req: IncomingMessage): Promise<VoiceRevisePlan> {
  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY not set')
  const body = (await readJson(req)) as {
    text?: string
    element_kind?: string
    element_context?: Record<string, unknown>
  }
  const text = (body.text ?? '').trim()
  if (!text) throw new Error('text-revise: missing text field')
  const elementKind = body.element_kind || 'image'
  const elementContext = body.element_context ?? {}

  const sys = `You are a prompt-revision assistant for an AI image generator. The user has just typed feedback about a ${elementKind}. Read the feedback, then output a JSON object describing how to revise the current generation prompt.

Current element context (the user is talking about this):
${JSON.stringify(elementContext, null, 2).slice(0, 1500)}

Return JSON ONLY, no markdown, with this shape:
{
  "user_intent": "<one sentence in the user's language summarising what they want changed>",
  "new_prompt": "<a complete revised image-generation prompt that incorporates the user's feedback. Preserve everything in the original that wasn't criticised. Use English unless the original context is Chinese-heavy.>",
  "key_changes": ["short bullet of what changed", ...],
  "preserve": ["what was kept", ...],
  "severity": "minor | moderate | major"
}`

  const res = await fetch(`${apimartBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.APIMART_TEXT_MODEL || APIMART_TEXT_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `User feedback: ${text}` },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Apimart text-revise ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const out = data.choices?.[0]?.message?.content?.trim() ?? ''
  const jsonM = out.match(/\{[\s\S]*\}/)
  if (!jsonM) throw new Error(`text-revise: model did not return JSON. Got: ${out.slice(0, 200)}`)
  const plan = JSON.parse(jsonM[0]) as Partial<VoiceRevisePlan>
  if (!plan.new_prompt) throw new Error('text-revise: missing new_prompt in model output')
  // Echo the user text back as transcript so the frontend's existing
  // voice-revise consumer shape works unchanged.
  return {
    new_prompt: plan.new_prompt,
    user_intent: plan.user_intent ?? '',
    transcript: text,
    key_changes: plan.key_changes,
    preserve: plan.preserve,
    severity: plan.severity,
  }
}

interface ArtRagSearchHit {
  id: string
  prompt: string
  similarity: number
  output_media_url: string
  output_media_type: string | null
  task_category: string
  task_type: string
  model_name: string
  source_name: string
  source_url: string
}

interface RagExample {
  id?: string
  prompt_text?: string
  output_media_url?: string
  output_media_type?: string | null
  task_category?: string
  task_type?: string
  model_name?: string
  source_name?: string
  source_url?: string
}

// In-process JSONL-backed RAG. Replaces the prior FastAPI-over-chromaDB
// proxy: ~/repos/prompt_rag/ now provides only the data files; this
// plugin reads them once at startup and scores in-memory. No Python
// service, no extra deps. Trade-off: text-overlap scoring instead of
// dense-vector semantic search — usually still useful at top-K=5 since
// the corpus is image-prompt-dense and queries are also prompt-like.
//
// Override the data file via PROMPT_RAG_JSONL=<absolute path>.
let cachedExamples: RagExample[] | null = null
let cachedTokens: Map<string, Set<string>> | null = null  // id → token set
let cachedDocFreq: Map<string, number> | null = null      // token → # docs

function ragJsonlPath(): string {
  if (process.env.PROMPT_RAG_JSONL) return process.env.PROMPT_RAG_JSONL
  // Default to the canonical files relative to ~/repos/prompt_rag/.
  // Tries data/examples.jsonl (the canonical location) first, then
  // examples.jsonl (the older/smaller scratch file).
  const home = process.env.HOME || ''
  const candidates = [
    path.join(home, 'repos/prompt_rag/data/examples.jsonl'),
    path.join(home, 'repos/prompt_rag/examples.jsonl'),
  ]
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.R_OK); return c } catch { /* try next */ }
  }
  return candidates[0]! // first one — caller surfaces the ENOENT
}

function tokenize(text: string): string[] {
  // Lowercase + split on whitespace / punctuation, keep CJK chars individually
  // so Chinese queries also match. Two char-classes — ASCII word and a single
  // CJK char — so we don't need word segmentation libraries.
  const out: string[] = []
  const re = /([a-z][a-z0-9_-]*|[一-鿿])/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tok = m[1]!.toLowerCase()
    if (tok.length >= 2 || /[一-鿿]/.test(tok)) out.push(tok)
  }
  return out
}

function loadExamples(): RagExample[] {
  if (cachedExamples) return cachedExamples
  const p = ragJsonlPath()
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (e) {
    throw new Error(
      `art-rag-search: could not read ${p}: ${(e as Error).message}. Set PROMPT_RAG_JSONL in .env to point at your prompt examples JSONL.`,
    )
  }
  const examples: RagExample[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { examples.push(JSON.parse(trimmed) as RagExample) } catch { /* skip malformed */ }
  }
  cachedExamples = examples
  // Precompute tokens + doc frequencies so per-request scoring is O(query
  // tokens × matching docs) instead of O(N × M).
  const tokens = new Map<string, Set<string>>()
  const docFreq = new Map<string, number>()
  for (const ex of examples) {
    const id = ex.id ?? `_${tokens.size}`
    const toks = new Set(tokenize(ex.prompt_text ?? ''))
    tokens.set(id, toks)
    for (const t of toks) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  }
  cachedTokens = tokens
  cachedDocFreq = docFreq
  return examples
}

async function artRagSearch(req: IncomingMessage): Promise<{ hits: ArtRagSearchHit[] }> {
  const body = (await readJson(req)) as {
    query?: string
    top_k?: number
    task_category?: string | null
    task_type?: string | null
    model_name?: string | null
  }
  const query = (body.query ?? '').trim()
  if (!query) throw new Error('art-rag-search: missing query field')

  const examples = loadExamples()
  if (examples.length === 0) {
    return { hits: [] }
  }
  const N = examples.length
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) {
    return { hits: [] }
  }

  // Score: sum of log(N / df) for each unique query token that appears in
  // the example's prompt tokens. This is IDF-weighted token overlap —
  // rare matching terms (e.g. "rooftop", "Tarkovsky") count more than
  // common ones (e.g. "the", "art"). Caps at the top_k requested.
  const taskType = body.task_type ?? null
  const taskCategory = body.task_category ?? null
  const modelName = body.model_name ?? null
  const seen = new Set<string>(queryTokens) // dedupe query terms
  const tokens = cachedTokens!
  const docFreq = cachedDocFreq!

  const scored: Array<{ ex: RagExample; score: number }> = []
  for (const ex of examples) {
    if (taskType && ex.task_type !== taskType) continue
    if (taskCategory && ex.task_category !== taskCategory) continue
    if (modelName && ex.model_name !== modelName) continue
    const exTokens = tokens.get(ex.id ?? '') ?? new Set<string>()
    if (exTokens.size === 0) continue
    let score = 0
    let matched = 0
    for (const t of seen) {
      if (exTokens.has(t)) {
        const df = docFreq.get(t) ?? 1
        score += Math.log(1 + N / df)
        matched += 1
      }
    }
    if (matched === 0) continue
    scored.push({ ex, score })
  }

  scored.sort((a, b) => b.score - a.score)
  const topK = Math.max(1, Math.min(20, body.top_k ?? 5))
  const top = scored.slice(0, topK)
  // Normalize score to (0, 1] for display so the UI can show a "similarity"
  // percentage that's consistent across queries. Best match in this batch
  // = 1.0; everything else scales down from there.
  const max = top[0]?.score ?? 1
  const hits: ArtRagSearchHit[] = top.map((s, i) => ({
    id: s.ex.id ?? `_${i}`,
    prompt: s.ex.prompt_text ?? '',
    similarity: max > 0 ? s.score / max : 0,
    output_media_url: s.ex.output_media_url ?? '',
    output_media_type: s.ex.output_media_type ?? null,
    task_category: s.ex.task_category ?? '',
    task_type: s.ex.task_type ?? '',
    model_name: s.ex.model_name ?? '',
    source_name: s.ex.source_name ?? '',
    source_url: s.ex.source_url ?? '',
  }))
  return { hits }
}

async function dispatch(req: Req): Promise<{ url: string; kind: 'image' | 'video' }> {
  if (!req.provider || !req.model) throw new Error('provider/model required')
  if (!req.prompt?.trim()) throw new Error('prompt required')
  switch (req.provider) {
    case 'fal':    return runFal(req)
    case 'doubao':
      // Provider id retained for IndexedDB compat with existing canvas elements;
      // all calls now route to BytePlus海外 (see runBytePlus* above).
      return /seedance/i.test(req.model) ? runBytePlusVideo(req) : runBytePlusImage(req)
    case 'openai': return runOpenAI(req)
    case 'gemini': return runApimartImage(req, 'google/')
    case 'tokenrouter': return runApimartImage(req)
    default: throw new Error(`unsupported provider: ${req.provider}`)
  }
}

export function providersPlugin(): Plugin {
  return {
    name: 'providers-api',
    configureServer(server) {
      server.middlewares.use('/providers/generate', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const body = await readJson(req)
          const r = await dispatch(body)
          sendJson(res, 200, r)
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })
      server.middlewares.use('/providers/optimize', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const body = (await readJson(req)) as unknown as OptimizeReq
          const r = await optimizePrompt(body)
          sendJson(res, 200, r)
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })
      server.middlewares.use('/providers/voice-revise', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const r = await voiceRevise(req)
          sendJson(res, 200, r)
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })
      server.middlewares.use('/providers/text-revise', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const r = await textRevise(req)
          sendJson(res, 200, r)
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })
      server.middlewares.use('/providers/art-rag-search', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const r = await artRagSearch(req)
          sendJson(res, 200, r)
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })
      server.middlewares.use('/providers/available', (_req, res) => {
        sendJson(res, 200, {
          libtv:  !!process.env.LIBTV_ACCESS_KEY,
          fal:    !!process.env.FAL_KEY,
          doubao: !!(process.env.BYTEPLUS_ARK_API_KEY || process.env.ARK_API_KEY),
          openai: !!process.env.OPENAI_API_KEY,
          gemini: !!process.env.APIMART_API_KEY,
          tokenrouter: !!process.env.APIMART_API_KEY,
        })
      })
    },
  }
}
