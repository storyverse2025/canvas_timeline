/**
 * Bragi Router — provider-agnostic generation endpoint.
 *
 * Sits next to vite-capabilities-plugin (which serves the web app's
 * /capabilities/run path) and exposes a clean /api/router/* surface that Obsidian
 * (bragi-canvas plugin) can target instead of calling each provider
 * directly. The web app is NOT touched; this is purely additive.
 *
 * V1a scope:
 *   POST /api/router/run         — image (Seedream, sync) + video (Seedance, async)
 *   GET  /api/router/tasks/:id   — long-poll for async task state
 *   POST /api/router/assets      — multipart upload, returns hosted URL
 *   GET  /api/router/models      — model catalog (hardcoded for V1a; grows in 1b)
 *   POST /api/router/test-key    — connection test for Settings → Test buttons
 *
 * Auth: optional Bearer token. If ROUTER_TOKEN env is set, every request
 * needs `Authorization: Bearer <token>`. If not set, requests pass — the
 * nginx IP allowlist already serves as the perimeter in V1.
 */
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID, randomBytes } from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────

type InputKind = 'text' | 'image' | 'video' | 'audio'
type OutputKind = InputKind

interface RouterInput {
  kind: InputKind
  url?: string
  text?: string
}

interface RunRequest {
  capability: string
  model?: string
  provider?: string
  prompt?: string
  inputs?: RouterInput[]
  params?: Record<string, unknown>
}

interface RouterOutput {
  kind: OutputKind
  url?: string
  text?: string
}

interface TaskState {
  routerTaskId: string
  status: 'pending' | 'done' | 'failed'
  capability: string
  model: string
  provider: string
  providerTaskId?: string
  createdAt: number
  updatedAt: number
  outputs?: RouterOutput[]
  error?: string
  errorCode?: string
}

// ─── In-memory task registry ──────────────────────────────────────────
// V1: Map; lost on vite reload. Acceptable for testing. PR 1b adds disk.

const tasks = new Map<string, TaskState>()
const TASK_TTL_MS = 24 * 60 * 60 * 1000 // 24h

function gcTasks(): void {
  const cutoff = Date.now() - TASK_TTL_MS
  for (const [id, t] of tasks) {
    if (t.updatedAt < cutoff) tasks.delete(id)
  }
}

setInterval(gcTasks, 10 * 60 * 1000).unref?.()

// ─── HTTP helpers ─────────────────────────────────────────────────────

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {} as T
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Provider-Keys')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.end(JSON.stringify(body))
}

function authOk(req: IncomingMessage): boolean {
  const expected = process.env.ROUTER_TOKEN
  if (!expected) return true
  const got = req.headers.authorization
  return typeof got === 'string' && got === `Bearer ${expected}`
}

function getProviderKeyOverride(req: IncomingMessage, providerId: string): string | null {
  const header = req.headers['x-provider-keys']
  if (typeof header !== 'string') return null
  try {
    const parsed = JSON.parse(header) as Record<string, string>
    return parsed[providerId] ?? null
  } catch {
    return null
  }
}

// ─── Asset storage (reuses public/uploads, same as /uploads/save) ─────

function uploadsDir(): string {
  const d = join(process.cwd(), 'public', 'uploads')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function newAssetName(ext: string): string {
  const stamp = Date.now().toString(36)
  const rand = randomBytes(4).toString('hex')
  return `router_${stamp}_${rand}.${ext}`
}

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  return 'bin'
}

function saveBytesToUploads(bytes: Buffer, mime: string): string {
  const ext = extFromMime(mime)
  const name = newAssetName(ext)
  writeFileSync(join(uploadsDir(), name), bytes)
  return `/uploads/${name}`
}

async function fetchRemoteToBuffer(url: string): Promise<{ buf: Buffer; mime: string }> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`)
  const ab = await r.arrayBuffer()
  const mime = r.headers.get('content-type') ?? 'application/octet-stream'
  return { buf: Buffer.from(ab), mime }
}

/**
 * Hosting policy for V1a: if it's a remote https URL, download it and
 * re-host under /uploads/ so bragi-canvas's downloader sees a stable,
 * same-origin URL. BytePlus pre-signed URLs expire in 24h; mirroring also
 * isolates clients from provider URL semantics.
 */
async function hostOutput(remoteUrl: string): Promise<string> {
  const { buf, mime } = await fetchRemoteToBuffer(remoteUrl)
  return saveBytesToUploads(buf, mime)
}

// ─── Bragi relay (for ref images that need a public URL) ─────────────
//
// Providers like Luma and fal require a fetchable HTTP URL for reference
// images — passing a data: URL inline either explodes the request body or
// is rejected outright. The plugin in bragi-canvas already uploads such
// refs through https://temp.bragi.now (Cloudflare Worker, public token).
// We mirror that here so the router does the same plumbing internally —
// callers just hand us a data URL and we swap in a fetchable URL.
//
// Token is the same public one bundled in bragi-canvas/src/providers/bragi-relay.ts;
// it's rate-limited per-IP by the Worker and not a secret.

const BRAGI_RELAY_ENDPOINT = process.env.BRAGI_RELAY_ENDPOINT || 'https://temp.bragi.now'
const BRAGI_RELAY_TOKEN = process.env.BRAGI_RELAY_TOKEN || 'eca59a4c6895d6c31a63db967e2c704264517f69f1ab35043976fe72fcf618d4'

async function uploadToBragiRelay(bytes: Buffer, mime: string): Promise<string> {
  const ext = extFromMime(mime)
  const r = await fetch(`${BRAGI_RELAY_ENDPOINT}/upload?ext=${encodeURIComponent(ext)}`, {
    method: 'POST',
    headers: {
      'Content-Type': mime,
      'Authorization': `Bearer ${BRAGI_RELAY_TOKEN}`,
    },
    body: bytes,
  })
  const data = (await r.json()) as { url?: string; error?: string }
  if (!data.url) throw new Error(`Bragi relay: ${data.error ?? `no url (HTTP ${r.status})`}`)
  return data.url
}

/**
 * Normalize any reference URL (http(s), data:, or asset://) to a fetchable
 * https URL by uploading data: refs to the Bragi relay. Caller decides
 * whether a given provider needs this (Seedance accepts inline data URLs;
 * Luma and fal do not).
 */
async function refToPublicUrl(ref: string): Promise<string> {
  if (/^https?:/i.test(ref)) return ref
  if (ref.startsWith('asset://')) return ref
  const m = ref.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) throw new Error(`unsupported ref format: ${ref.slice(0, 40)}…`)
  return uploadToBragiRelay(Buffer.from(m[2], 'base64'), m[1])
}

// ─── Provider: Seedream (sync image via BytePlus海外) ────────────────

const SEEDREAM_SIZE_MAP: Record<string, Record<string, string>> = {
  '1K': { '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152', '16:9': '1280x720', '9:16': '720x1280', '3:2': '1248x832', '2:3': '832x1248', '21:9': '1512x648' },
  '2K': { '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304', '16:9': '2848x1600', '9:16': '1600x2848', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344' },
  '3K': { '1:1': '3072x3072', '4:3': '3456x2592', '3:4': '2592x3456', '16:9': '4096x2304', '9:16': '2304x4096', '3:2': '3744x2496', '2:3': '2496x3744', '21:9': '4704x2016' },
  '4K': { '1:1': '4096x4096', '4:3': '4704x3520', '3:4': '3520x4704', '16:9': '5504x3040', '9:16': '3040x5504', '3:2': '4992x3328', '2:3': '3328x4992', '21:9': '6240x2656' },
}

function arkBaseUrl(): string {
  const raw = process.env.ARK_BASE_URL || process.env.ARK_API_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3'
  return raw.replace(/\/+$/, '')
}

function arkKey(override: string | null): string {
  const key = override || process.env.BYTEPLUS_ARK_API_KEY || process.env.ARK_API_KEY
  if (!key) throw new Error('BYTEPLUS_ARK_API_KEY (or legacy ARK_API_KEY) not set')
  return key
}

async function runSeedream(opts: {
  model: string
  prompt: string
  refs: string[]
  aspectRatio: string
  resolution: string
  keyOverride: string | null
}): Promise<RouterOutput[]> {
  const size = SEEDREAM_SIZE_MAP[opts.resolution]?.[opts.aspectRatio] ?? '2048x2048'
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    size,
    response_format: 'b64_json',
    watermark: false,
    sequential_image_generation: 'disabled',
  }
  if (opts.refs.length > 0) body.image = opts.refs

  const res = await fetch(`${arkBaseUrl()}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${arkKey(opts.keyOverride)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  type SeedreamResponse = { data?: Array<{ b64_json?: string; url?: string }>; error?: { code?: string; message?: string } }
  const text = await res.text()
  let data: SeedreamResponse
  try { data = JSON.parse(text) as SeedreamResponse } catch {
    throw new Error(`Seedream non-JSON response (${res.status}): ${text.slice(0, 200)}`)
  }

  if (data.error) throw new Error(`Seedream: ${data.error.code ?? ''} — ${data.error.message ?? ''}`)
  if (!res.ok) throw new Error(`Seedream HTTP ${res.status}: ${text.slice(0, 200)}`)

  const first = data.data?.[0]
  if (!first) throw new Error('Seedream: empty data array')

  let hostedUrl: string
  if (first.b64_json) {
    const buf = Buffer.from(first.b64_json, 'base64')
    hostedUrl = saveBytesToUploads(buf, 'image/png')
  } else if (first.url) {
    hostedUrl = await hostOutput(first.url)
  } else {
    throw new Error('Seedream: no b64_json or url in response')
  }
  return [{ kind: 'image', url: hostedUrl }]
}

// ─── Provider: OpenAI (sync image, gpt-image-2) ──────────────────────

const OPENAI_SIZE_MAP: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
  '3:2': { '1K': '1536x1024', '2K': '2048x1360', '4K': '3520x2336' },
  '2:3': { '1K': '1024x1536', '2K': '1360x2048', '4K': '2336x3520' },
  '4:3': { '1K': '1024x768', '2K': '2048x1536', '4K': '3312x2480' },
  '3:4': { '1K': '768x1024', '2K': '1536x2048', '4K': '2480x3312' },
  '5:4': { '1K': '1280x1024', '2K': '2560x2048', '4K': '3216x2576' },
  '4:5': { '1K': '1024x1280', '2K': '2048x2560', '4K': '2576x3216' },
  '16:9': { '1K': '1536x864', '2K': '2048x1152', '4K': '3840x2160' },
  '9:16': { '1K': '864x1536', '2K': '1152x2048', '4K': '2160x3840' },
  '2:1': { '1K': '2048x1024', '2K': '2688x1344', '4K': '3840x1920' },
  '1:2': { '1K': '1024x2048', '2K': '1344x2688', '4K': '1920x3840' },
  '3:1': { '1K': '1536x512', '2K': '3072x1024', '4K': '3840x1280' },
  '1:3': { '1K': '512x1536', '2K': '1024x3072', '4K': '1280x3840' },
  '21:9': { '1K': '2016x864', '2K': '2688x1152', '4K': '3840x1648' },
  '9:21': { '1K': '864x2016', '2K': '1152x2688', '4K': '1648x3840' },
}

function resolveOpenAISize(params: Record<string, unknown>): string {
  const explicit = typeof params.size === 'string' ? params.size : undefined
  if (explicit) return explicit
  const aspectRatio = (params.aspectRatio as string) || '1:1'
  if (aspectRatio.toLowerCase() === 'auto') return 'auto'
  const imageSize = ((params.imageSize as string) || '2K').toUpperCase()
  if (imageSize.toLowerCase() === 'auto') return 'auto'
  return OPENAI_SIZE_MAP[aspectRatio]?.[imageSize] ?? OPENAI_SIZE_MAP['1:1']['2K']
}

async function runOpenAIImage(opts: {
  model: string
  prompt: string
  refs: string[]
  size: string
  quality: string
  keyOverride: string | null
}): Promise<RouterOutput[]> {
  const key = opts.keyOverride || process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')

  let b64: string
  if (opts.refs.length > 0) {
    // /images/edits — multipart with image[] fields
    const form = new FormData()
    form.append('model', opts.model)
    form.append('prompt', opts.prompt)
    form.append('size', opts.size)
    form.append('quality', opts.quality)
    form.append('n', '1')
    for (let i = 0; i < opts.refs.length; i++) {
      const ref = opts.refs[i]
      let mime = 'image/png'
      let buf: Buffer
      const m = ref.match(/^data:([^;]+);base64,(.+)$/)
      if (m) {
        mime = m[1]
        buf = Buffer.from(m[2], 'base64')
      } else {
        const r = await fetchRemoteToBuffer(ref)
        mime = r.mime
        buf = r.buf
      }
      const ext = extFromMime(mime)
      form.append('image[]', new Blob([buf], { type: mime }), `ref${i}.${ext}`)
    }
    const r = await fetch(`${base}/images/edits`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: form,
    })
    const text = await r.text()
    let data: { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } }
    try { data = JSON.parse(text) } catch {
      throw new Error(`OpenAI edits non-JSON (${r.status}): ${text.slice(0, 200)}`)
    }
    if (data.error) throw new Error(`OpenAI: ${data.error.message ?? 'unknown'}`)
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${text.slice(0, 200)}`)
    const got = data.data?.[0]?.b64_json
    if (!got) {
      if (data.data?.[0]?.url) return [{ kind: 'image', url: await hostOutput(data.data[0].url!) }]
      throw new Error(`OpenAI: no b64_json in edit response`)
    }
    b64 = got
  } else {
    // /images/generations — JSON
    const r = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        size: opts.size,
        quality: opts.quality,
        n: 1,
      }),
    })
    const text = await r.text()
    let data: { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } }
    try { data = JSON.parse(text) } catch {
      throw new Error(`OpenAI gen non-JSON (${r.status}): ${text.slice(0, 200)}`)
    }
    if (data.error) throw new Error(`OpenAI: ${data.error.message ?? 'unknown'}`)
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${text.slice(0, 200)}`)
    const got = data.data?.[0]?.b64_json
    if (!got) {
      if (data.data?.[0]?.url) return [{ kind: 'image', url: await hostOutput(data.data[0].url!) }]
      throw new Error(`OpenAI: no b64_json in gen response`)
    }
    b64 = got
  }

  const hosted = saveBytesToUploads(Buffer.from(b64, 'base64'), 'image/png')
  return [{ kind: 'image', url: hosted }]
}

// ─── Provider: Gemini (sync image, nano-banana via parts API) ────────

async function runGeminiImage(opts: {
  model: string
  prompt: string
  refs: string[]
  aspectRatio: string
  imageSize: string
  keyOverride: string | null
}): Promise<RouterOutput[]> {
  const key = opts.keyOverride || process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const base = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')

  type Part = { text?: string; inlineData?: { mimeType: string; data: string } }
  const parts: Part[] = []
  for (const ref of opts.refs) {
    const m = ref.match(/^data:([^;]+);base64,(.+)$/)
    if (m) {
      parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
    } else if (/^https?:/.test(ref)) {
      const fetched = await fetchRemoteToBuffer(ref)
      parts.push({ inlineData: { mimeType: fetched.mime, data: fetched.buf.toString('base64') } })
    }
  }
  parts.push({ text: opts.prompt })

  const r = await fetch(`${base}/models/${opts.model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: opts.aspectRatio,
          imageSize: opts.imageSize,
        },
      },
    }),
  })
  const text = await r.text()
  type GeminiResp = {
    candidates?: Array<{
      finishReason?: string
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }> }
    }>
    error?: { message?: string; status?: string }
    promptFeedback?: { blockReason?: string }
  }
  let data: GeminiResp
  try { data = JSON.parse(text) } catch {
    throw new Error(`Gemini non-JSON (${r.status}): ${text.slice(0, 200)}`)
  }
  if (data.error) throw new Error(`Gemini: ${data.error.message ?? data.error.status ?? 'unknown'}`)
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${text.slice(0, 200)}`)
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked: ${data.promptFeedback.blockReason}`)

  let b64: string | undefined
  let mime = 'image/png'
  for (const cand of data.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      const inline = (part.inlineData ?? part.inline_data) as { data?: string; mimeType?: string; mime_type?: string } | undefined
      if (inline?.data) {
        b64 = inline.data
        mime = inline.mimeType ?? inline.mime_type ?? mime
        break
      }
    }
    if (b64) break
  }
  if (!b64) {
    const finishReason = data.candidates?.[0]?.finishReason ?? 'none'
    throw new Error(`Gemini: no image in response (finishReason=${finishReason})`)
  }
  return [{ kind: 'image', url: saveBytesToUploads(Buffer.from(b64, 'base64'), mime) }]
}

// ─── Provider: xAI (sync image, grok-imagine) ────────────────────────

async function runXaiImage(opts: {
  model: string
  prompt: string
  refs: string[]
  aspectRatio: string
  keyOverride: string | null
}): Promise<RouterOutput[]> {
  const key = opts.keyOverride || process.env.XAI_API_KEY
  if (!key) throw new Error('XAI_API_KEY not set')
  const base = (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/+$/, '')

  const isEdit = opts.refs.length > 0
  const url = `${base}/${isEdit ? 'images/edits' : 'images/generations'}`

  // xAI rejects bare ref strings; wrap each as {url:...}. Data URLs need
  // to be hosted first since the server can't deref them.
  const refUrls: string[] = []
  for (const ref of opts.refs) refUrls.push(await refToPublicUrl(ref))

  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    n: 1,
    aspect_ratio: opts.aspectRatio,
    response_format: 'url',
  }
  if (isEdit) {
    if (refUrls.length === 1) body.image = { url: refUrls[0] }
    else body.images = refUrls.slice(0, 5).map((u) => ({ url: u }))
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  type XaiResp = { data?: Array<{ url?: string }>; error?: { message?: string } | string }
  let data: XaiResp
  try { data = JSON.parse(text) } catch {
    throw new Error(`xAI non-JSON (${r.status}): ${text.slice(0, 200)}`)
  }
  if (data.error) {
    const m = typeof data.error === 'string' ? data.error : data.error.message
    throw new Error(`xAI: ${m ?? 'unknown'}`)
  }
  if (!r.ok) throw new Error(`xAI HTTP ${r.status}: ${text.slice(0, 200)}`)
  const imgUrl = data.data?.[0]?.url
  if (!imgUrl) throw new Error(`xAI: no image url in response`)
  return [{ kind: 'image', url: await hostOutput(imgUrl) }]
}

// ─── Provider: Luma (sync image, uni-1 via luma.bragi.now) ───────────

const LUMA_ENDPOINT = process.env.LUMA_ENDPOINT || 'https://luma.bragi.now'

async function runLumaImage(opts: {
  prompt: string
  refs: string[]
  aspectRatio: string
  keyOverride: string | null
}): Promise<RouterOutput[]> {
  const token = opts.keyOverride || process.env.LUMA_TOKEN
  if (!token) throw new Error('LUMA_TOKEN not set')

  const body: Record<string, unknown> = { prompt: opts.prompt, aspect_ratio: opts.aspectRatio }
  let url = `${LUMA_ENDPOINT}/v1/images/generate`
  if (opts.refs.length > 0) {
    body.image_url = await refToPublicUrl(opts.refs[0])
    url = `${LUMA_ENDPOINT}/v1/images/img2img`
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (r.status === 401) throw new Error('Luma: invalid API key')
  if (r.status === 413) throw new Error('Luma: ref image too large')
  if (r.status === 503) throw new Error('Luma: no healthy upstream')
  if (r.status === 504) throw new Error('Luma: generation timed out')
  let data: { image_url?: string; message?: string; error?: string }
  try { data = JSON.parse(text) } catch {
    throw new Error(`Luma non-JSON (${r.status}): ${text.slice(0, 200)}`)
  }
  if (r.status >= 400) throw new Error(`Luma: ${data.message ?? data.error ?? `HTTP ${r.status}`}`)
  if (!data.image_url) throw new Error(`Luma: no image_url in response`)
  return [{ kind: 'image', url: await hostOutput(data.image_url) }]
}

// ─── Provider: Seedance (async video via BytePlus海外) ───────────────

function defaultSeedanceModel(): string {
  return process.env.SEEDANCE_MODEL || process.env.SEEDANCE_ENDPOINT || process.env.ARK_SEEDANCE_ENDPOINT || 'dreamina-seedance-2-0-fast-260128'
}

type SeedanceContentPart = Record<string, unknown>

function buildSeedanceContent(prompt: string, inputs: RouterInput[], mode?: string): SeedanceContentPart[] {
  const parts: SeedanceContentPart[] = [{ type: 'text', text: prompt || 'cinematic video' }]
  const images = inputs.filter((i) => i.kind === 'image' && i.url).map((i) => i.url!)
  const videos = inputs.filter((i) => i.kind === 'video' && i.url).map((i) => i.url!)
  const audios = inputs.filter((i) => i.kind === 'audio' && i.url).map((i) => i.url!)

  // Mode inference: bragi-canvas-style genMode strings take precedence.
  // Without an explicit mode, fall back to shape-based detection like the
  // capabilities plugin does.
  const effective = mode ?? (
    videos.length || audios.length ? 'video-ref' :
    images.length === 0 ? 'text-to-video' :
    images.length === 1 ? 'first-frame' :
    images.length === 2 ? 'first-last-frame' :
    'image-ref'
  )

  if (effective === 'first-frame' && images[0]) {
    parts.push({ type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' })
  } else if (effective === 'first-last-frame' && images[0] && images[1]) {
    parts.push({ type: 'image_url', image_url: { url: images[0] }, role: 'first_frame' })
    parts.push({ type: 'image_url', image_url: { url: images[1] }, role: 'last_frame' })
  } else if (effective === 'image-ref') {
    for (const u of images.slice(0, 9)) parts.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' })
  } else if (effective === 'video-ref' || effective === 'video-extend' || effective === 'video-edit') {
    for (const u of images.slice(0, 9)) parts.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' })
    for (const u of videos.slice(0, 3)) parts.push({ type: 'video_url', video_url: { url: u }, role: 'reference_video' })
    for (const u of audios.slice(0, 3)) parts.push({ type: 'audio_url', audio_url: { url: u }, role: 'reference_audio' })
  }
  return parts
}

interface SeedanceSubmitOpts {
  model: string
  contentParts: SeedanceContentPart[]
  duration: number
  ratio: string
  resolution: string
  generateAudio: boolean
  keyOverride: string | null
}

async function submitSeedanceTask(opts: SeedanceSubmitOpts): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    content: opts.contentParts,
    duration: opts.duration,
    ratio: opts.ratio,
    resolution: opts.resolution,
    generate_audio: opts.generateAudio,
    watermark: false,
  }
  const res = await fetch(`${arkBaseUrl()}/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${arkKey(opts.keyOverride)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  type CreateResponse = { id?: string; error?: { code?: string; message?: string } }
  const text = await res.text()
  let data: CreateResponse
  try { data = JSON.parse(text) as CreateResponse } catch {
    throw new Error(`Seedance non-JSON (${res.status}): ${text.slice(0, 200)}`)
  }
  if (data.error) throw new Error(`Seedance: ${data.error.code ?? ''} — ${data.error.message ?? ''}`)
  if (!res.ok) throw new Error(`Seedance HTTP ${res.status}: ${text.slice(0, 200)}`)
  if (!data.id) throw new Error('Seedance: no task id in submit response')
  return data.id
}

interface SeedanceStatus {
  status: 'pending' | 'done' | 'failed'
  videoUrl?: string
  error?: string
}

async function pollSeedanceTask(providerTaskId: string, keyOverride: string | null): Promise<SeedanceStatus> {
  const res = await fetch(`${arkBaseUrl()}/contents/generations/tasks/${providerTaskId}`, {
    headers: { 'Authorization': `Bearer ${arkKey(keyOverride)}` },
  })
  type TaskResponse = { status?: string; content?: { video_url?: string }; error?: { message?: string } }
  const data = (await res.json()) as TaskResponse
  if (data.status === 'succeeded') {
    if (!data.content?.video_url) return { status: 'failed', error: 'no video_url on succeeded task' }
    return { status: 'done', videoUrl: data.content.video_url }
  }
  if (data.status === 'failed') return { status: 'failed', error: data.error?.message ?? 'task failed' }
  return { status: 'pending' }
}

/**
 * Background poll loop for a Seedance task. Updates the task registry
 * when state changes. Stops on done/failed or after the global timeout.
 * Uses setTimeout (not setInterval) so we never overlap fetches.
 */
function startSeedancePollLoop(routerTaskId: string, providerTaskId: string, keyOverride: string | null): void {
  const deadline = Date.now() + 15 * 60 * 1000 // 15 min
  const tick = async (): Promise<void> => {
    const state = tasks.get(routerTaskId)
    if (!state || state.status !== 'pending') return
    if (Date.now() > deadline) {
      tasks.set(routerTaskId, { ...state, status: 'failed', error: 'router timeout (15m)', updatedAt: Date.now() })
      return
    }
    try {
      const r = await pollSeedanceTask(providerTaskId, keyOverride)
      if (r.status === 'done' && r.videoUrl) {
        try {
          const hosted = await hostOutput(r.videoUrl)
          tasks.set(routerTaskId, {
            ...state,
            status: 'done',
            outputs: [{ kind: 'video', url: hosted }],
            updatedAt: Date.now(),
          })
        } catch (e) {
          tasks.set(routerTaskId, {
            ...state,
            status: 'failed',
            error: `download failed: ${(e as Error).message}`,
            updatedAt: Date.now(),
          })
        }
        return
      }
      if (r.status === 'failed') {
        tasks.set(routerTaskId, { ...state, status: 'failed', error: r.error ?? 'unknown', updatedAt: Date.now() })
        return
      }
    } catch (e) {
      // Transient: keep polling. Only set failed after deadline.
      const msg = (e as Error).message
      console.warn(`[router] Seedance poll error (will retry): ${msg}`)
    }
    setTimeout(() => { void tick() }, 5000)
  }
  setTimeout(() => { void tick() }, 3000)
}

// ─── Provider: fal (async video via queue.fal.run) ───────────────────

const FAL_QUEUE = process.env.FAL_QUEUE_URL || 'https://queue.fal.run'

function falKey(override: string | null): string {
  const key = override || process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  return key
}

/**
 * Resolve fal sub-endpoint by mode + ref shape. Mirrors bragi-canvas's
 * fal.ts so the same modelIds produce identical routing on this side.
 *
 * Grok-Imagine video sub-endpoints (under xai/grok-imagine-video/):
 *   /text-to-video        no refs
 *   /image-to-video       genMode=first-frame + 1 ref
 *   /reference-to-video   genMode=image-ref + N refs (Grok-specific)
 *   /extend-video         genMode=video-extend + video URL
 *
 * Other-vendor video on fal (Seedance etc.) use base endpoint with image_urls.
 */
function resolveFalEndpoint(modelId: string, genMode: string, refImageCount: number): string {
  const modelBase = modelId.split('/text-to-video')[0].split('/image-to-video')[0]
    .split('/reference-to-video')[0].split('/extend-video')[0]
  if (genMode === 'first-frame' && refImageCount >= 1) return `${modelBase}/image-to-video`
  if (genMode === 'image-ref' && refImageCount >= 1) {
    return modelBase.includes('grok') ? `${modelBase}/reference-to-video` : modelBase
  }
  if (genMode === 'video-extend') return `${modelBase}/extend-video`
  return `${modelBase}/text-to-video`
}

function falPollBase(modelEndpoint: string): string {
  return modelEndpoint.split('/text-to-video')[0].split('/image-to-video')[0]
    .split('/reference-to-video')[0].split('/extend-video')[0]
}

async function submitFalVideoTask(opts: {
  model: string
  prompt: string
  genMode: string
  refImages: string[]
  refVideos: string[]
  params: Record<string, unknown>
  keyOverride: string | null
}): Promise<{ endpoint: string; requestId: string }> {
  const endpoint = resolveFalEndpoint(opts.model, opts.genMode, opts.refImages.length)
  const input: Record<string, unknown> = { prompt: opts.prompt }
  if (opts.params.duration) input.duration = Number.parseInt(opts.params.duration as string, 10)
  if (opts.params.durationSeconds) input.duration = Number.parseInt(opts.params.durationSeconds as string, 10)
  if (opts.params.aspectRatio) input.aspect_ratio = opts.params.aspectRatio
  if (opts.params.aspect_ratio) input.aspect_ratio = opts.params.aspect_ratio
  if (opts.params.ratio) input.aspect_ratio = opts.params.ratio
  if (opts.params.resolution) input.resolution = opts.params.resolution

  if (opts.refImages.length > 0) {
    const uploaded = await Promise.all(opts.refImages.map(refToPublicUrl))
    if (opts.genMode === 'first-frame') input.image_url = uploaded[0]
    else if (opts.genMode === 'image-ref') input.image_urls = uploaded
    else input.image_urls = uploaded // base endpoint + image_urls for non-Grok image-ref shape
  }
  if (opts.genMode === 'video-extend') {
    if (opts.refVideos.length === 0) throw new Error('fal video-extend needs an upstream video URL')
    input.video_url = opts.refVideos[0]
  }

  const r = await fetch(`${FAL_QUEUE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${falKey(opts.keyOverride)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const text = await r.text()
  let data: { request_id?: string; detail?: string; message?: string }
  try { data = JSON.parse(text) } catch {
    throw new Error(`fal submit non-JSON (${r.status}): ${text.slice(0, 200)}`)
  }
  if (!data.request_id) throw new Error(`fal: ${data.detail ?? data.message ?? `HTTP ${r.status}: ${text.slice(0, 200)}`}`)
  return { endpoint, requestId: data.request_id }
}

interface FalStatus {
  status: 'pending' | 'done' | 'failed'
  videoUrl?: string
  error?: string
}

async function pollFalTask(modelEndpoint: string, requestId: string, keyOverride: string | null): Promise<FalStatus> {
  const base = falPollBase(modelEndpoint)
  const headers = { 'Authorization': `Key ${falKey(keyOverride)}` }
  const sr = await fetch(`${FAL_QUEUE}/${base}/requests/${requestId}/status`, { headers })
  const s = (await sr.json()) as { status?: string }
  if (s.status === 'COMPLETED') {
    const rr = await fetch(`${FAL_QUEUE}/${base}/requests/${requestId}`, { headers })
    const r = (await rr.json()) as { video?: { url?: string }; output?: { video?: { url?: string }; url?: string } }
    const videoUrl = r.video?.url ?? r.output?.video?.url ?? r.output?.url
    if (!videoUrl) return { status: 'failed', error: 'fal: COMPLETED but no video URL in result' }
    return { status: 'done', videoUrl }
  }
  if (s.status === 'FAILED') return { status: 'failed', error: 'fal: task FAILED' }
  return { status: 'pending' }
}

function startFalPollLoop(routerTaskId: string, modelEndpoint: string, requestId: string, keyOverride: string | null): void {
  const deadline = Date.now() + 15 * 60 * 1000
  const tick = async (): Promise<void> => {
    const state = tasks.get(routerTaskId)
    if (!state || state.status !== 'pending') return
    if (Date.now() > deadline) {
      tasks.set(routerTaskId, { ...state, status: 'failed', error: 'router timeout (15m)', updatedAt: Date.now() })
      return
    }
    try {
      const r = await pollFalTask(modelEndpoint, requestId, keyOverride)
      if (r.status === 'done' && r.videoUrl) {
        try {
          const hosted = await hostOutput(r.videoUrl)
          tasks.set(routerTaskId, { ...state, status: 'done', outputs: [{ kind: 'video', url: hosted }], updatedAt: Date.now() })
        } catch (e) {
          tasks.set(routerTaskId, { ...state, status: 'failed', error: `download failed: ${(e as Error).message}`, updatedAt: Date.now() })
        }
        return
      }
      if (r.status === 'failed') {
        tasks.set(routerTaskId, { ...state, status: 'failed', error: r.error ?? 'unknown', updatedAt: Date.now() })
        return
      }
    } catch (e) {
      console.warn(`[router] fal poll error (will retry): ${(e as Error).message}`)
    }
    setTimeout(() => { void tick() }, 5000)
  }
  setTimeout(() => { void tick() }, 3000)
}

// ─── Capability dispatch ──────────────────────────────────────────────

const SYNC_IMAGE_CAPABILITIES = new Set(['text-to-image', 'image-edit'])
const ASYNC_VIDEO_CAPABILITIES = new Set(['text-to-video', 'image-to-video', 'video-edit'])

/**
 * Map a (capability, modelId) pair to the (provider, apiModelId) pair that
 * actually services it. Mirrors bragi-canvas's src/models/*.ts so the same
 * plugin-side modelId resolves consistently here.
 *
 * Returning `null` from match means "I don't claim this modelId" — try the
 * next entry. The first match wins.
 */
type RouteEntry = {
  matches: (modelId: string) => boolean
  provider: string
  apiModelId: (modelId: string, params: Record<string, unknown>) => string
}

const IMAGE_ROUTES: RouteEntry[] = [
  // OpenAI gpt-image-2 (direct)
  {
    matches: (m) => m === 'gpt-image-2' || m === 'gpt-image-1' || m.startsWith('gpt-image'),
    provider: 'openai',
    apiModelId: (m) => m === 'gpt-image-1' ? 'gpt-image-1' : 'gpt-image-2',
  },
  // Gemini nano-banana
  {
    matches: (m) => m === 'nano-banana-pro' || m === 'gemini-3-pro-image-preview',
    provider: 'gemini',
    apiModelId: () => 'gemini-3-pro-image-preview',
  },
  {
    matches: (m) => m === 'nano-banana-2' || m === 'gemini-3.1-flash-image-preview' || m === 'gemini-2.5-flash-image',
    provider: 'gemini',
    apiModelId: (m) => m === 'gemini-2.5-flash-image' ? 'gemini-2.5-flash-image' : 'gemini-3.1-flash-image-preview',
  },
  // xAI grok-imagine
  {
    matches: (m) => m === 'grok-imagine' || m.startsWith('grok-imagine-image'),
    provider: 'xai',
    apiModelId: (_m, params) => params.quality === 'normal' ? 'grok-imagine-image' : 'grok-imagine-image-quality',
  },
  // Luma uni-1
  {
    matches: (m) => m === 'luma-uni-1' || m === 'uni-1',
    provider: 'luma',
    apiModelId: () => 'uni-1',
  },
  // Seedream — bragi-canvas-style ids (seedream-5.0 / seedream-4.5) get
  // translated to the BytePlus apiModelIds; everything else passes through.
  {
    matches: (m) => /^(dreamina-|doubao-)?seedream/.test(m) || m === 'seedream-5.0' || m === 'seedream-4.5',
    provider: 'bytedance',
    apiModelId: (m) => {
      if (m === 'seedream-5.0') return process.env.SEEDREAM_MODEL || 'seedream-5-0-260128'
      if (m === 'seedream-4.5') return 'seedream-4-5-251128'
      return m
    },
  },
]

const VIDEO_ROUTES: RouteEntry[] = [
  // Seedance via BytePlus海外 (default).
  //
  // SEEDANCE_MODEL / SEEDANCE_ENDPOINT / ARK_SEEDANCE_ENDPOINT env vars take
  // precedence over the bragi-canvas model id when present — operators pin
  // an account-specific endpoint id like ep-20260423151341-p2zm9 in .env and
  // expect both 'seedance-2.0' and 'seedance-2.0-fast' to route there.
  // Without the override we'd hit AccessDenied on accounts that aren't
  // provisioned for the public dreamina-* model ids.
  {
    matches: (m) => /^(dreamina-|doubao-)?seedance/.test(m) || m === 'seedance-2.0' || m === 'seedance-2.0-fast' || m.startsWith('ep-'),
    provider: 'bytedance',
    apiModelId: (m) => {
      const envOverride = process.env.SEEDANCE_MODEL || process.env.SEEDANCE_ENDPOINT || process.env.ARK_SEEDANCE_ENDPOINT
      if (envOverride) return envOverride
      if (m === 'seedance-2.0') return 'dreamina-seedance-2-0-260128'
      if (m === 'seedance-2.0-fast') return 'dreamina-seedance-2-0-fast-260128'
      return m
    },
  },
  // fal: Kling-3 + grok-video go through queue.fal.run
  {
    matches: (m) => m === 'kling-3.0' || m.startsWith('fal-ai/kling-video') || m === 'fal-ai/kling-video/v3/pro',
    provider: 'fal',
    apiModelId: (m) => m === 'kling-3.0' ? 'fal-ai/kling-video/v3/pro' : m,
  },
  {
    matches: (m) => m === 'grok-video' || m.startsWith('xai/grok-imagine-video'),
    provider: 'fal',
    apiModelId: () => 'xai/grok-imagine-video',
  },
]

function pickRoute(capability: string, modelId: string): RouteEntry | null {
  const table = SYNC_IMAGE_CAPABILITIES.has(capability) ? IMAGE_ROUTES
              : ASYNC_VIDEO_CAPABILITIES.has(capability) ? VIDEO_ROUTES
              : null
  if (!table) return null
  return table.find((r) => r.matches(modelId)) ?? null
}

function pickProvider(req: RunRequest): string {
  if (req.provider) return req.provider
  const route = pickRoute(req.capability, req.model ?? '')
  if (route) return route.provider
  // Fallbacks when modelId is omitted entirely.
  if (SYNC_IMAGE_CAPABILITIES.has(req.capability)) return 'openai'
  if (ASYNC_VIDEO_CAPABILITIES.has(req.capability)) return 'bytedance'
  throw new Error(`router: no default provider for capability=${req.capability} model=${req.model ?? '<none>'}`)
}

function pickModel(req: RunRequest, provider: string): string {
  if (req.model) {
    const route = pickRoute(req.capability, req.model)
    if (route) return route.apiModelId(req.model, req.params ?? {})
    // Unknown modelId, but a provider was forced — pass through verbatim.
    return req.model
  }
  // No model specified → use provider's default for the capability.
  if (provider === 'openai' && SYNC_IMAGE_CAPABILITIES.has(req.capability)) return 'gpt-image-2'
  if (provider === 'gemini' && SYNC_IMAGE_CAPABILITIES.has(req.capability)) return 'gemini-3-pro-image-preview'
  if (provider === 'xai' && SYNC_IMAGE_CAPABILITIES.has(req.capability)) return 'grok-imagine-image-quality'
  if (provider === 'luma' && SYNC_IMAGE_CAPABILITIES.has(req.capability)) return 'uni-1'
  if (provider === 'bytedance' && SYNC_IMAGE_CAPABILITIES.has(req.capability)) return process.env.SEEDREAM_MODEL || 'seedream-5-0-260128'
  if (provider === 'bytedance' && ASYNC_VIDEO_CAPABILITIES.has(req.capability)) return defaultSeedanceModel()
  if (provider === 'fal' && ASYNC_VIDEO_CAPABILITIES.has(req.capability)) return 'fal-ai/kling-video/v3/pro'
  throw new Error(`router: no default model for provider=${provider} capability=${req.capability}`)
}

async function dispatchSync(req: RunRequest, provider: string, apiModelId: string, keyOverride: string | null): Promise<RouterOutput[]> {
  const inputs = req.inputs ?? []
  const refs = inputs.filter((i) => i.kind === 'image' && i.url).map((i) => i.url!)
  const params = req.params ?? {}
  const prompt = req.prompt ?? ''
  const aspectRatio = (params.aspectRatio as string) || (params.aspect_ratio as string) || '1:1'

  if (provider === 'bytedance') {
    return runSeedream({ model: apiModelId, prompt, refs, aspectRatio, resolution: (params.resolution as string) || '2K', keyOverride })
  }
  if (provider === 'openai') {
    return runOpenAIImage({
      model: apiModelId,
      prompt,
      refs,
      size: resolveOpenAISize(params),
      quality: (params.quality as string) || 'auto',
      keyOverride,
    })
  }
  if (provider === 'gemini') {
    return runGeminiImage({
      model: apiModelId,
      prompt,
      refs,
      aspectRatio,
      imageSize: (params.imageSize as string) || '1K',
      keyOverride,
    })
  }
  if (provider === 'xai') {
    return runXaiImage({ model: apiModelId, prompt, refs, aspectRatio, keyOverride })
  }
  if (provider === 'luma') {
    return runLumaImage({ prompt, refs, aspectRatio, keyOverride })
  }
  throw new Error(`router: no sync handler for provider=${provider} capability=${req.capability}`)
}

async function dispatchAsync(req: RunRequest, provider: string, apiModelId: string, routerTaskId: string, keyOverride: string | null): Promise<void> {
  const inputs = req.inputs ?? []
  const params = req.params ?? {}
  const mode = (params.genMode as string) || undefined
  const prompt = req.prompt ?? ''
  const refImages = inputs.filter((i) => i.kind === 'image' && i.url).map((i) => i.url!)
  const refVideos = inputs.filter((i) => i.kind === 'video' && i.url).map((i) => i.url!)

  if (provider === 'bytedance' || provider === 'byteplus') {
    const content = buildSeedanceContent(prompt, inputs, mode)
    const providerTaskId = await submitSeedanceTask({
      model: apiModelId,
      contentParts: content,
      duration: Number.parseInt((params.duration as string) ?? '5', 10) || 5,
      ratio: (params.ratio as string) || '16:9',
      resolution: (params.resolution as string) || '720p',
      generateAudio: (params.generate_audio as string) !== 'false',
      keyOverride,
    })
    const state = tasks.get(routerTaskId)
    if (state) tasks.set(routerTaskId, { ...state, providerTaskId, updatedAt: Date.now() })
    startSeedancePollLoop(routerTaskId, providerTaskId, keyOverride)
    return
  }
  if (provider === 'fal') {
    const { endpoint, requestId } = await submitFalVideoTask({
      model: apiModelId,
      prompt,
      genMode: mode ?? (refImages.length === 1 ? 'first-frame' : refImages.length > 1 ? 'image-ref' : 'text-to-video'),
      refImages,
      refVideos,
      params,
      keyOverride,
    })
    const state = tasks.get(routerTaskId)
    if (state) tasks.set(routerTaskId, { ...state, providerTaskId: `${endpoint}::${requestId}`, updatedAt: Date.now() })
    startFalPollLoop(routerTaskId, endpoint, requestId, keyOverride)
    return
  }
  throw new Error(`router: no async handler for provider=${provider} capability=${req.capability}`)
}

// ─── Endpoint: POST /api/router/run ───────────────────────────────────────────

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: RunRequest
  try {
    body = await readJson<RunRequest>(req)
  } catch (e) {
    return sendJson(res, 400, { error: `bad json: ${(e as Error).message}` })
  }
  if (!body.capability) return sendJson(res, 400, { error: 'capability is required' })

  let provider: string
  let model: string
  try {
    provider = pickProvider(body)
    model = pickModel(body, provider)
  } catch (e) {
    return sendJson(res, 400, { error: (e as Error).message })
  }
  const keyOverride = getProviderKeyOverride(req, provider)

  // Async (video)
  if (ASYNC_VIDEO_CAPABILITIES.has(body.capability)) {
    const routerTaskId = `tr_${randomUUID()}`
    const now = Date.now()
    tasks.set(routerTaskId, {
      routerTaskId,
      status: 'pending',
      capability: body.capability,
      model,
      provider,
      createdAt: now,
      updatedAt: now,
    })
    try {
      await dispatchAsync(body, provider, model, routerTaskId, keyOverride)
      return sendJson(res, 202, { taskId: routerTaskId, status: 'pending' })
    } catch (e) {
      const msg = (e as Error).message
      tasks.set(routerTaskId, {
        ...tasks.get(routerTaskId)!,
        status: 'failed',
        error: msg,
        updatedAt: Date.now(),
      })
      return sendJson(res, 502, { error: msg, taskId: routerTaskId })
    }
  }

  // Sync (image)
  try {
    const outputs = await dispatchSync(body, provider, model, keyOverride)
    return sendJson(res, 200, { outputs })
  } catch (e) {
    return sendJson(res, 502, { error: (e as Error).message })
  }
}

// ─── Endpoint: GET /api/router/tasks/:id?wait=20 ─────────────────────────────

async function handleTaskGet(req: IncomingMessage, res: ServerResponse, taskId: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const wait = Math.min(Math.max(Number.parseInt(url.searchParams.get('wait') ?? '0', 10) || 0, 0), 25)
  const deadline = Date.now() + wait * 1000

  const respond = (state: TaskState) => sendJson(res, 200, {
    taskId: state.routerTaskId,
    status: state.status,
    outputs: state.outputs,
    error: state.error,
    provider: state.provider,
    model: state.model,
    capability: state.capability,
  })

  let state = tasks.get(taskId)
  if (!state) return sendJson(res, 404, { error: 'unknown taskId' })
  if (state.status !== 'pending' || wait === 0) return respond(state)

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    state = tasks.get(taskId)
    if (!state) return sendJson(res, 404, { error: 'task evicted' })
    if (state.status !== 'pending') return respond(state)
  }
  return respond(state)
}

// ─── Endpoint: POST /api/router/assets ────────────────────────────────────────
//
// Two body shapes supported for V1a:
//   1. application/json { dataUrl: "data:image/png;base64,..." }
//   2. raw octet-stream + ?contentType= query
// Both return { assetId, url }. Multipart can be added in 1b — bragi-canvas
// will use shape 1 (data URL) since it already has bytes in hand.

async function handleAssetUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const ct = req.headers['content-type'] ?? ''

  let buf: Buffer
  let mime: string

  if (ct.includes('application/json')) {
    let body: { dataUrl?: string }
    try { body = await readJson<{ dataUrl?: string }>(req) } catch { return sendJson(res, 400, { error: 'bad json' }) }
    if (!body.dataUrl) return sendJson(res, 400, { error: 'dataUrl is required' })
    const m = body.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!m) return sendJson(res, 400, { error: 'malformed dataUrl' })
    mime = m[1]
    buf = Buffer.from(m[2], 'base64')
  } else {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    buf = Buffer.concat(chunks)
    mime = url.searchParams.get('contentType') || ct || 'application/octet-stream'
  }
  if (buf.length === 0) return sendJson(res, 400, { error: 'empty body' })
  const hosted = saveBytesToUploads(buf, mime)
  const assetId = hosted.replace(/^\/uploads\//, '')
  return sendJson(res, 200, { assetId, url: hosted })
}

// ─── Endpoint: GET /api/router/models ─────────────────────────────────────────

interface ModelEntry {
  id: string
  apiModelId: string
  label: string
  type: 'image' | 'video'
  provider: string
  capabilities: string[]
  params: Array<{ id: string; label: string; type: string; options?: Array<{ label: string; value: string }>; default: string | number }>
}

// Aspect-ratio option sets reused across model entries.
const ASPECT_BASIC = [
  { label: '1:1', value: '1:1' }, { label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' },
  { label: '4:3', value: '4:3' }, { label: '3:4', value: '3:4' }, { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' }, { label: '21:9', value: '21:9' },
]
const ASPECT_FULL = [
  ...ASPECT_BASIC,
  { label: '4:5', value: '4:5' }, { label: '5:4', value: '5:4' },
  { label: '1:4', value: '1:4' }, { label: '4:1', value: '4:1' },
  { label: '1:8', value: '1:8' }, { label: '8:1', value: '8:1' },
]
const GPT_IMAGE_ASPECTS = [
  { label: 'Auto', value: 'auto' },
  ...ASPECT_FULL.filter((a) => !['1:8', '8:1', '1:4', '4:1'].includes(a.value)),
  { label: '2:1', value: '2:1' }, { label: '1:2', value: '1:2' },
  { label: '3:1', value: '3:1' }, { label: '1:3', value: '1:3' }, { label: '9:21', value: '9:21' },
]
const SIZE_TIERS_1_2_4K = [{ label: '1K', value: '1K' }, { label: '2K', value: '2K' }, { label: '4K', value: '4K' }]
const SEEDANCE_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((d) => ({ label: `${d}s`, value: String(d) }))

const V1A_MODELS: ModelEntry[] = [
  // ── Image: user's enabled set, ordered by api_key.json modelOrder ──
  {
    id: 'gpt-image-2', apiModelId: 'gpt-image-2', label: 'GPT Image 2', type: 'image',
    provider: 'openai', capabilities: ['text-to-image', 'image-edit'],
    params: [
      { id: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: GPT_IMAGE_ASPECTS, default: '1:1' },
      { id: 'imageSize', label: 'Size', type: 'select', options: SIZE_TIERS_1_2_4K, default: '2K' },
      { id: 'quality', label: 'Quality', type: 'select',
        options: [{ label: 'Auto', value: 'auto' }, { label: 'High', value: 'high' }, { label: 'Medium', value: 'medium' }, { label: 'Low', value: 'low' }],
        default: 'auto' },
    ],
  },
  {
    id: 'nano-banana-pro', apiModelId: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro', type: 'image',
    provider: 'gemini', capabilities: ['text-to-image', 'image-edit'],
    params: [
      { id: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: ASPECT_FULL.filter((a) => !['1:4', '4:1', '1:8', '8:1'].includes(a.value)), default: '1:1' },
      { id: 'imageSize', label: 'Size', type: 'select', options: SIZE_TIERS_1_2_4K, default: '1K' },
    ],
  },
  {
    id: 'nano-banana-2', apiModelId: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2', type: 'image',
    provider: 'gemini', capabilities: ['text-to-image', 'image-edit'],
    params: [
      { id: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: ASPECT_FULL, default: '1:1' },
      { id: 'imageSize', label: 'Size', type: 'select', options: SIZE_TIERS_1_2_4K, default: '1K' },
    ],
  },
  {
    id: 'grok-imagine', apiModelId: 'grok-imagine-image-quality', label: 'Grok Imagine', type: 'image',
    provider: 'xai', capabilities: ['text-to-image', 'image-edit'],
    params: [
      { id: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: ASPECT_BASIC, default: '1:1' },
      { id: 'quality', label: 'Quality', type: 'select',
        options: [{ label: 'Quality', value: 'quality' }, { label: 'Normal', value: 'normal' }],
        default: 'quality' },
    ],
  },
  {
    id: 'luma-uni-1', apiModelId: 'uni-1', label: 'Luma Uni-1', type: 'image',
    provider: 'luma', capabilities: ['text-to-image', 'image-edit'],
    params: [
      { id: 'aspectRatio', label: 'Aspect ratio', type: 'select',
        options: [{ label: '1:1', value: '1:1' }, { label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' }, { label: '4:3', value: '4:3' }, { label: '3:4', value: '3:4' }],
        default: '16:9' },
    ],
  },
  {
    id: 'seedream-5.0', apiModelId: 'seedream-5-0-260128', label: 'Seedream 5.0', type: 'image',
    provider: 'bytedance', capabilities: ['text-to-image', 'image-edit'],
    params: [
      { id: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: ASPECT_BASIC, default: '1:1' },
      { id: 'resolution', label: 'Resolution', type: 'select',
        options: [{ label: '1K', value: '1K' }, { label: '2K', value: '2K' }, { label: '3K', value: '3K' }, { label: '4K', value: '4K' }],
        default: '2K' },
    ],
  },
  // ── Video: user's enabled set, ordered by api_key.json modelOrder ──
  {
    id: 'seedance-2.0', apiModelId: 'dreamina-seedance-2-0-260128', label: 'Seedance 2.0', type: 'video',
    provider: 'bytedance', capabilities: ['text-to-video', 'image-to-video'],
    params: [
      { id: 'duration', label: 'Duration', type: 'select', options: SEEDANCE_DURATIONS, default: '5' },
      { id: 'ratio', label: 'Ratio', type: 'select',
        options: [{ label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' }, { label: '1:1', value: '1:1' }, { label: '4:3', value: '4:3' }, { label: '3:4', value: '3:4' }],
        default: '16:9' },
      { id: 'resolution', label: 'Resolution', type: 'select',
        options: [{ label: '480p', value: '480p' }, { label: '720p', value: '720p' }, { label: '1080p', value: '1080p' }],
        default: '720p' },
      { id: 'generate_audio', label: 'Audio', type: 'select',
        options: [{ label: 'On', value: 'true' }, { label: 'Off', value: 'false' }],
        default: 'true' },
    ],
  },
  {
    id: 'seedance-2.0-fast', apiModelId: 'dreamina-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast', type: 'video',
    provider: 'bytedance', capabilities: ['text-to-video', 'image-to-video'],
    params: [
      { id: 'duration', label: 'Duration', type: 'select', options: SEEDANCE_DURATIONS.slice(0, 9), default: '5' },
      { id: 'ratio', label: 'Ratio', type: 'select',
        options: [{ label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' }, { label: '1:1', value: '1:1' }],
        default: '16:9' },
      { id: 'resolution', label: 'Resolution', type: 'select',
        options: [{ label: '480p', value: '480p' }, { label: '720p', value: '720p' }],
        default: '720p' },
      { id: 'generate_audio', label: 'Audio', type: 'select',
        options: [{ label: 'On', value: 'true' }, { label: 'Off', value: 'false' }],
        default: 'true' },
    ],
  },
  {
    id: 'kling-3.0', apiModelId: 'fal-ai/kling-video/v3/pro', label: 'Kling 3', type: 'video',
    provider: 'fal', capabilities: ['text-to-video', 'image-to-video'],
    params: [
      { id: 'duration', label: 'Duration', type: 'select',
        options: [{ label: '5s', value: '5' }, { label: '10s', value: '10' }],
        default: '5' },
      { id: 'aspectRatio', label: 'Ratio', type: 'select',
        options: [{ label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' }, { label: '1:1', value: '1:1' }],
        default: '16:9' },
    ],
  },
  {
    id: 'grok-video', apiModelId: 'xai/grok-imagine-video', label: 'Grok Video', type: 'video',
    provider: 'fal', capabilities: ['text-to-video', 'image-to-video'],
    params: [
      { id: 'duration', label: 'Duration', type: 'select',
        options: [{ label: '5s', value: '5' }, { label: '10s', value: '10' }, { label: '15s', value: '15' }],
        default: '5' },
      { id: 'aspect_ratio', label: 'Ratio', type: 'select',
        options: [{ label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' }, { label: '1:1', value: '1:1' }],
        default: '16:9' },
    ],
  },
]

function handleModels(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { models: V1A_MODELS })
}

// ─── Endpoint: POST /api/router/test-key ──────────────────────────────────────
//
// Body: { provider: 'bytedance' | ..., key: 'sk-...' }
// Result: { ok: boolean, message: string }
// Mirrors the bragi-canvas registry.testConnection contract so the
// plugin's Settings → Test button can be a pure pass-through call.

async function handleTestKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { provider?: string; key?: string }
  try { body = await readJson<{ provider?: string; key?: string }>(req) } catch {
    return sendJson(res, 400, { error: 'bad json' })
  }
  if (!body.provider) return sendJson(res, 400, { error: 'provider is required' })
  const key = body.key ?? ''
  if (!key) return sendJson(res, 200, { ok: false, message: 'API key is empty.' })

  // Mirror the bragi-canvas testConnection contract per provider. Each path
  // picks the cheapest endpoint that distinguishes "bad key" from "valid
  // but rate-limited / missing scope". All return {ok, message} so the
  // plugin Settings button needs no per-provider client logic.
  try {
    if (body.provider === 'bytedance' || body.provider === 'byteplus') {
      const r = await fetch(`${arkBaseUrl()}/models`, { headers: { 'Authorization': `Bearer ${key}` } })
      if (r.status === 200) return sendJson(res, 200, { ok: true, message: 'Connected.' })
      if (r.status === 401 || r.status === 403) return sendJson(res, 200, { ok: false, message: 'Invalid API key.' })
      return sendJson(res, 200, { ok: false, message: `Unexpected status ${r.status}.` })
    }
    if (body.provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': `Bearer ${key}` } })
      if (r.status === 200) return sendJson(res, 200, { ok: true, message: 'Connected.' })
      if (r.status === 401 || r.status === 403) return sendJson(res, 200, { ok: false, message: 'Invalid API key.' })
      return sendJson(res, 200, { ok: false, message: `Unexpected status ${r.status}.` })
    }
    if (body.provider === 'gemini') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`)
      if (r.status === 200) return sendJson(res, 200, { ok: true, message: 'Connected.' })
      if (r.status === 401 || r.status === 403 || r.status === 400) return sendJson(res, 200, { ok: false, message: 'Invalid API key.' })
      return sendJson(res, 200, { ok: false, message: `Unexpected status ${r.status}.` })
    }
    if (body.provider === 'xai') {
      const r = await fetch('https://api.x.ai/v1/models', { headers: { 'Authorization': `Bearer ${key}` } })
      if (r.status === 200) return sendJson(res, 200, { ok: true, message: 'Connected.' })
      if (r.status === 401 || r.status === 403) return sendJson(res, 200, { ok: false, message: 'Invalid API key.' })
      return sendJson(res, 200, { ok: false, message: `Unexpected status ${r.status}.` })
    }
    if (body.provider === 'fal') {
      const r = await fetch('https://queue.fal.run/fal-ai/fast-sdxl/requests/ping-test/status', { headers: { 'Authorization': `Key ${key}` } })
      if (r.status === 401 || r.status === 403) return sendJson(res, 200, { ok: false, message: 'Invalid API key.' })
      return sendJson(res, 200, { ok: true, message: 'Connected.' })
    }
    if (body.provider === 'luma') {
      // Same trick bragi-canvas's testConnection uses: POST with empty body —
      // 401 = bad token, 400 = token good (missing prompt), 200 = unexpected.
      const r = await fetch(`${LUMA_ENDPOINT}/v1/images/generate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (r.status === 401) return sendJson(res, 200, { ok: false, message: 'Invalid API key.' })
      if (r.status === 400 || r.status === 200) return sendJson(res, 200, { ok: true, message: 'Connected.' })
      return sendJson(res, 200, { ok: false, message: `Unexpected status ${r.status}.` })
    }
    return sendJson(res, 200, { ok: false, message: `Provider ${body.provider} not supported.` })
  } catch (e) {
    return sendJson(res, 200, { ok: false, message: `Network error: ${(e as Error).message}` })
  }
}

// ─── Vite plugin entrypoint ───────────────────────────────────────────

export function routerPlugin(): Plugin {
  return {
    name: 'bragi-router-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url ?? ''
        if (!path.startsWith('/api/router/')) return next()

        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Provider-Keys')
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
          res.statusCode = 204
          res.end()
          return
        }

        if (!authOk(req)) return sendJson(res, 401, { error: 'invalid or missing bearer token' })

        try {
          // Strip query string for routing
          const cleanPath = path.split('?')[0]

          if (cleanPath === '/api/router/run' && req.method === 'POST') return handleRun(req, res)
          if (cleanPath === '/api/router/models' && req.method === 'GET') return handleModels(req, res)
          if (cleanPath === '/api/router/test-key' && req.method === 'POST') return handleTestKey(req, res)
          if (cleanPath === '/api/router/assets' && req.method === 'POST') return handleAssetUpload(req, res)

          const taskMatch = cleanPath.match(/^\/api\/router\/tasks\/([^/]+)$/)
          if (taskMatch && req.method === 'GET') return handleTaskGet(req, res, taskMatch[1])

          return sendJson(res, 404, { error: `unknown route: ${req.method} ${cleanPath}` })
        } catch (e) {
          return sendJson(res, 500, { error: (e as Error).message })
        }
      })
    },
  }
}
