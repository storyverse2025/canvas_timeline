import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { writeFileSync, mkdirSync, existsSync, statSync, createReadStream } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import sharp from 'sharp'

interface CapInput { kind: string; url?: string; text?: string }
interface CapReq {
  capability: string
  inputs: CapInput[]
  params?: Record<string, unknown>
}
interface CapOut { kind: string; url?: string; text?: string }
interface CapRes { outputs: CapOut[] }

async function readJson(req: IncomingMessage): Promise<CapReq> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function getText(inputs: CapInput[]): string {
  return inputs.filter((i) => i.kind === 'text').map((i) => i.text ?? '').join('\n').trim()
}
function getImages(inputs: CapInput[]): string[] {
  return inputs.filter((i) => i.kind === 'image' && i.url).map((i) => i.url!)
}
function getVideos(inputs: CapInput[]): string[] {
  return inputs.filter((i) => i.kind === 'video' && i.url).map((i) => i.url!)
}
function getAudios(inputs: CapInput[]): string[] {
  return inputs.filter((i) => i.kind === 'audio' && i.url).map((i) => i.url!)
}

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

// ─── Apimart (OpenAI-compatible) ─────────────────────────────────
//
// 2026-05-23: Apimart rolled a breaking change. The marketing host
// `apimart.ai/v1` now returns a Next.js 404 page for every API path
// (the front-end was migrated to api.apimart.ai, the v1 routes on the
// old host were dropped). At the same time their image flow switched
// from synchronous /images/generations + /images/edits to a task-based
// async API: submit returns {data:[{task_id}]} and you poll
// /v1/tasks/{id} until status==='completed'. Ref images are now passed
// as `image: [url|dataUrl, …]` in the JSON body — the dedicated
// /images/edits endpoint was removed ("generic adaptor models should
// be routed through task submission flow"). The OpenAI provider-prefix
// ("openai/gpt-5.4-image-2") is no longer a valid model id; the closest
// analog on the new host is `gpt-image-2`. See normalizeApimartImageModel
// for the alias table that keeps existing callers working without a
// frontend touch.
const APIMART_BASE_URL = 'https://api.apimart.ai/v1'
const APIMART_TEXT_MODEL = 'gemini-3-flash-preview'
const APIMART_IMAGE_MODEL = 'gpt-image-2'

/**
 * Map legacy provider-prefixed model ids (openai/gpt-5.4-image-2,
 * google/gemini-3-flash-preview-image, …) to the bare ids the new
 * api.apimart.ai accepts. Returns the input unchanged for ids that
 * are already valid (or unknown — we let the server error rather than
 * silently rewriting strings we don't recognize).
 */
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
  // Strip a leading provider/ prefix as a generic fallback — the new
  // api.apimart.ai is one big flat namespace.
  const slash = model.indexOf('/')
  if (slash > 0) return model.slice(slash + 1)
  return model
}

async function apimartChat(systemPrompt: string, userText: string, imageUrl?: string, temperature?: number): Promise<string> {
  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY not set')
  const baseUrl = (process.env.APIMART_BASE_URL || APIMART_BASE_URL).replace(/\/$/, '')
  const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: userText }]
  if (imageUrl) userContent.push({ type: 'image_url', image_url: { url: imageUrl } })
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.APIMART_TEXT_MODEL || APIMART_TEXT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      ...(temperature != null ? { temperature } : {}),
    }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`Apimart chat ${res.status}: ${raw.slice(0, 500)}`)
  // Apimart's gemini-3-flash-preview route started returning SSE without
  // `stream: true` being requested (observed 2026-05-30 across element-
  // extraction / script-rewrite / consistency-check / etc.). parseOpenAIChatResponse
  // sniffs the body and accumulates `delta.content` so callers work
  // regardless of which format comes back.
  const text = parseOpenAIChatResponse(raw).trim()
  if (!text) throw new Error('Apimart: empty response')
  return text
}

/**
 * Parse an OpenAI-compatible /chat/completions response that may be either
 * a single JSON envelope or an SSE stream (`data: {chunk}\n\n…data: [DONE]`).
 *
 * Apimart sometimes returns SSE without `stream:true` being requested;
 * sniffing the body and accumulating `delta.content` keeps callers working
 * regardless of which format comes back.
 */
function parseOpenAIChatResponse(raw: string): string {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('data:')) {
    const data = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content ?? ''
  }
  let out = ''
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let event: { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> }
    try { event = JSON.parse(payload) } catch { continue }
    const choice = event.choices?.[0]
    const piece = choice?.delta?.content ?? choice?.message?.content
    if (piece) out += piece
  }
  return out
}

async function geminiText(systemPrompt: string, userText: string): Promise<string> {
  return apimartChat(systemPrompt, userText, undefined, 0.7)
}

async function geminiVision(systemPrompt: string, userText: string, imageUrl: string): Promise<string> {
  return apimartChat(systemPrompt, userText, imageUrl, 0.5)
}

// ─── Agent capabilities ──────────────────────────────────────────────
async function scriptRewrite(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  if (!text) throw new Error('需要输入剧本文本')
  const style = (req.params?.style as string) || 'cinematic'
  const result = await geminiText(
    `你是一个资深编剧。请将用户提供的剧本或故事大纲改写为 ${style} 风格的短片剧本。
保留核心剧情，但用目标风格重新构思对白、场景描写和节奏。
输出中文剧本，包含场景描述和对白。不要使用 markdown 格式。`,
    text,
  )
  return { outputs: [{ kind: 'text', text: result }] }
}

async function scriptBreakdown(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  if (!text) throw new Error('需要输入剧本文本')
  const result = await geminiText(
    `你是一个专业的副导演。将剧本拆分为结构化数据，提取：
- 场景列表（场景号、地点、时间、内外景）
- 角色列表（姓名、描述、出场场景）
- 道具列表（名称、出现场景）
- 服装列表（角色、服装描述、场景）
- 特效需求
输出为结构化的 JSON 格式。`,
    text,
  )
  return { outputs: [{ kind: 'text', text: result }] }
}

async function elementExtraction(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  let result: string
  if (images.length > 0) {
    result = await geminiVision(
      `分析图片和文本，提取所有关键元素：
- 角色（外貌、服装、表情、姿势）
- 场景（地点、时间、天气、氛围）
- 道具（关键物品及其状态）
- 情绪基调
- 色彩主题
- 构图方式
输出结构化的 JSON 格式。`,
      text || '请分析这张图片的关键元素',
      images[0],
    )
  } else {
    result = await geminiText(
      `分析文本，提取所有创作关键元素：角色、场景、道具、情绪、色彩、构图。输出 JSON 格式。`,
      text,
    )
  }
  return { outputs: [{ kind: 'text', text: result }] }
}

async function shotExtraction(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  if (!text) throw new Error('需要输入剧本文本')
  const result = await geminiText(
    `你是专业的分镜师。将剧本转换为分镜表，每个镜头包含：
- shot_number: 镜头编号
- duration: 时长(秒)
- shot_size: 景别（特写/近景/中景/全景/远景）
- visual_description: 画面描述
- camera_movement: 镜头运动
- character_actions: 角色动作
- dialogue: 对白
- emotion_mood: 情绪
- lighting: 灯光
输出为 JSON 数组格式，每个镜头一个对象。`,
    text,
  )
  return { outputs: [{ kind: 'text', text: result }] }
}

async function consistencyCheck(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  const sys = `你是视觉一致性审查专家。检查提供的多张分镜图和描述之间的一致性问题：
- 角色外貌一致性（发型、服装、体型）
- 场景连续性（道具位置、光线方向）
- 风格统一性（色调、画风）
- 时间逻辑（白天/夜晚、季节）
列出所有不一致的地方，并给出修正建议。`
  let result: string
  if (images.length > 0) {
    result = await geminiVision(sys, text || '检查这些分镜的一致性', images[0])
  } else {
    result = await geminiText(sys, text)
  }
  return { outputs: [{ kind: 'text', text: result }] }
}

async function storyboardQC(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  if (!images.length) throw new Error('需要至少 1 张关键帧图片')
  const sys = `你是专业的分镜质量检查员。请检查提供的关键帧图片是否符合分镜描述。
从以下维度评估：
1. 角色：图中人物是否匹配描述的角色特征（外貌、服装、表情）
2. 场景：背景、道具、环境是否符合描述
3. 情绪：画面情绪基调是否与描述一致
4. 构图：镜头角度、景别是否符合要求

输出格式（JSON）：
{
  "passed": true/false,
  "score": 0-100,
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"]
}`
  const results: string[] = []
  for (let i = 0; i < images.length; i++) {
    const desc = text || `第${i + 1}帧`
    const r = await geminiVision(sys, `分镜描述：${desc}`, images[i])
    results.push(`【第${i + 1}帧】\n${r}`)
  }
  return { outputs: [{ kind: 'text', text: results.join('\n\n---\n\n') }] }
}

/**
 * Make an image URL safe to pass to Apimart's chat/completions image_url
 * field. Apimart fetches the URL server-side; that fetch fails for two
 * common reasons:
 *
 *   1. URLs pointing back at our own dev server (`/uploads/...`,
 *      `http://localhost:8080/...`, `http://35.x.x.x/uploads/...`) are
 *      unreachable from Apimart's network — comes back as
 *      `error getting file base64 from url: failed to download file,
 *      status code: 404`.
 *   2. Signed remote URLs (BytePlus TOS, Apimart's own gpt-image-2
 *      outputs) expire ~24h after issue. Storyboard rows persist for
 *      days/weeks across sessions, so by the time the user clicks 补全
 *      缺失分镜 most keyframeUrls are dead links.
 *
 * Solution: download every URL server-side ourselves and inline as
 * data: URI. Our node fetch has no CORS issues, can hit most hosts, and
 * if the URL is dead we KNOW it (404 / timeout) so we can drop just
 * that one image rather than the whole judgement call. Apimart receives
 * raw bytes, never has to fetch anything.
 *
 * Returns the safe URL on success, undefined on failure.
 */
const APIMART_IMAGE_FETCH_TIMEOUT_MS = 10_000

async function urlToApimartImage(url: string): Promise<string | undefined> {
  if (!url) return undefined
  if (url.startsWith('data:')) return url

  // Local: read off disk (skips both the local network round-trip and
  // any nginx 403 on server-to-server /uploads/ requests).
  const local = maybeLocalPathFor(url)
  if (local) {
    try {
      const { buf, mime } = await readLocalRefBuffer(local)
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch (e) {
      console.warn(`[urlToApimartImage] local read failed for ${local}: ${(e as Error).message}`)
      return undefined
    }
  }

  // Remote: fetch ourselves, inline as data URI. Apimart sees bytes,
  // not a URL — sidesteps both signed-URL expiry and reachability.
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), APIMART_IMAGE_FETCH_TIMEOUT_MS)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) {
      console.warn(`[urlToApimartImage] remote fetch ${res.status} for ${url.slice(0, 100)}`)
      return undefined
    }
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]!.trim()
    if (!mime.startsWith('image/')) {
      console.warn(`[urlToApimartImage] remote URL returned non-image content-type ${mime} for ${url.slice(0, 100)}`)
      return undefined
    }
    const ab = await res.arrayBuffer()
    return `data:${mime};base64,${Buffer.from(ab).toString('base64')}`
  } catch (e) {
    const why = (e as Error).name === 'AbortError'
      ? `timeout after ${APIMART_IMAGE_FETCH_TIMEOUT_MS}ms`
      : (e as Error).message
    console.warn(`[urlToApimartImage] remote fetch failed (${why}) for ${url.slice(0, 100)}`)
    return undefined
  }
}

/**
 * bridge-row-judge: see two adjacent storyboard rows + their prev-last /
 * next-first frames, decide if a bridging row is needed, and (when yes)
 * return the proposed row's text fields.
 *
 * The director-agent client builds the full Chinese judgement prompt — we
 * just forward it verbatim as the user message and attach 0-2 image_url
 * parts. The model's raw text comes back unchanged so the client's
 * BridgeJudgeSchema can parse it.
 *
 * Multi-image is required (prev-last + next-first), which the single-image
 * geminiVision helper doesn't cover — so we inline a small OpenAI-format
 * multi-image chat call here rather than over-generalize that helper.
 *
 * Image inputs that can't be resolved (local file gone, remote 404) are
 * dropped from the request rather than failing the call. The judgement
 * verb degrades gracefully to text-only — the row text already describes
 * the frames, so a missing image just means the model can't sanity-check
 * the description against pixels.
 */
async function bridgeRowJudge(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  if (!text) throw new Error('bridge-row-judge: empty text input — client must send the built prompt')

  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY not set')
  const baseUrl = (process.env.APIMART_BASE_URL || APIMART_BASE_URL).replace(/\/$/, '')

  const userContent: Array<Record<string, unknown>> = [{ type: 'text', text }]
  let droppedCount = 0
  for (const url of images) {
    const safe = await urlToApimartImage(url)
    if (safe) {
      userContent.push({ type: 'image_url', image_url: { url: safe } })
    } else {
      droppedCount++
    }
  }
  if (droppedCount > 0) {
    console.warn(`[bridge-row-judge] dropped ${droppedCount}/${images.length} unresolvable image(s); falling back to text-only judgement for this pair`)
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.APIMART_TEXT_MODEL || APIMART_TEXT_MODEL,
      messages: [
        { role: 'system', content: '你是分镜导演。严格按用户给出的 JSON 格式输出，不要加 markdown 围栏，不要多余的解释。' },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
    }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`bridge-row-judge: Apimart ${res.status}: ${raw.slice(0, 500)}`)
  const out = parseOpenAIChatResponse(raw).trim()
  if (!out) throw new Error('bridge-row-judge: empty response from Apimart')
  return { outputs: [{ kind: 'text', text: out }] }
}

// ─── Image capabilities ─────────────────────────────────────────────
// (apimartImageSize removed 2026-05-23: the new api.apimart.ai image
// endpoint takes `aspect_ratio` strings directly; per-aspect pixel-size
// maps are no longer needed.)

/**
 * Multi-reference IMAGE GENERATION (not editing) for gpt-image-2 via
 * Apimart (`openai/gpt-5.4-image-2`).
 *
 * Routing (verified empirically against Apimart, 2026-05-19):
 *   - 0 refs → POST /v1/images/generations  (JSON, text-to-image)
 *   - N refs → POST /v1/images/edits        (multipart, `image` repeated)
 *
 * Why /edits for multi-ref GENERATION (not edit): OpenAI's gpt-image-2
 * exposes its multi-reference generation through the `/images/edits`
 * endpoint. When no mask is supplied, /edits treats the input images
 * as references and synthesises a NEW image — it does NOT modify any
 * of the inputs. The endpoint name is OpenAI legacy; the function for
 * mask-less multi-image is "text-to-image conditioned on references."
 *
 * Other paths that DON'T work (tested):
 *   - /generations + `reference_images: [url, …]` JSON
 *     Returns 200 but the field is silently dropped — output is
 *     identical to a no-refs call. Most routing providers and OpenAI
 *     itself ignore this field, so we don't bother trying.
 *   - /generations + image / image_url / images / input_images JSON
 *     All 4xx; OpenAI's /generations endpoint takes no ref input.
 *
 * REF_CAP = 8 covers char1 + char2 + scene + 2 props + prior + headroom
 * for three-view characters. OpenAI's per-image limit is ~4MB; the
 * client-side already pre-uploads data URLs > 256KB so refs are usually
 * compact hosted URLs.
 */
const REF_CAP = 8

/**
 * Safety cap for the total multipart body shipped to Apimart /images/edits.
 * Apimart's nginx returns 413 above its `client_max_body_size` (commonly
 * 20MB). 18MB leaves headroom for the prompt field + multipart boundaries +
 * occasional ref that compresses worse than expected. We compress refs to
 * 1280px JPEG q85 first (see compressRefForUpload), so this budget should
 * only ever clip in pathological cases (10MB photo that JPEG'd to 5MB plus
 * three siblings).
 */
const APIMART_MULTIPART_BUDGET_BYTES = 18 * 1024 * 1024

/**
 * Read any ref URL form (data:, /uploads/path, http(s)://) into a raw
 * Buffer + best-guess mime. Deliberately permissive: an unrecognised
 * content-type defaults to image/png rather than throwing — otherwise
 * a single header mismatch (e.g. `image/png; charset=utf-8`) would
 * drop the ref silently, the FormData would carry zero `image` parts,
 * and Apimart would 500 with "image is required". That bug was
 * exactly what produced repeated 500s after the multipart fix landed.
 */
/**
 * Try to resolve any URL to a local public/ filesystem path, returning
 * null when it doesn't look local. Used to short-circuit refs whose
 * URLs point back at our own server — e.g. browser converts
 * `/uploads/x.png` to `http://35.168.148.47/uploads/x.png` before
 * sending to /capabilities/run, and our server then fails to fetch
 * its own URL because nginx 403s server-to-server requests on
 * /uploads/. fs read is faster anyway and bypasses every reverse-proxy
 * auth/CORS/rate-limit pitfall.
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

function mimeForExt(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

async function readLocalRefBuffer(localPath: string): Promise<{ buf: Buffer; mime: string }> {
  const { readFileSync } = await import('fs')
  const { join } = await import('path')
  const decoded = decodeURIComponent(localPath.split('?')[0] ?? localPath)
  const buf = readFileSync(join(process.cwd(), 'public', decoded))
  return { buf, mime: mimeForExt(decoded) }
}

// loadRefAsBlob removed 2026-05-23: the new api.apimart.ai image
// endpoint takes data: URLs in a JSON body, not multipart Blobs. Refs
// now flow through refToApimartImageRef (in runApimartImage below),
// which still uses compressRefForUpload + readLocalRefBuffer.

const REF_MAX_EDGE = 1280
const REF_JPEG_QUALITY = 85

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
    // sharp refused (truly broken bytes / unsupported format) — ship
    // raw so we still attempt the call rather than dropping the ref.
    // The byte-budget guard below provides a final safety net.
    console.warn(`[image] sharp compress failed (${(e as Error).message}); using raw buffer`)
    return { buf, mime: 'image/png', ext: 'png' }
  }
}

/**
 * Resolve a ref URL (data:, /uploads/, http(s)://) into a value the
 * api.apimart.ai `image: [...]` body field will accept. Logic:
 *   - data: URL → passthrough (already inline).
 *   - same-origin /uploads/ etc. → read from disk, compress with sharp,
 *     return as data URL. nginx blocks server-to-server fetches of
 *     /uploads/ from the public IP, so we cannot pass the URL through.
 *   - public http(s):// → passthrough (Apimart fetches it).
 * Per-ref compression keeps the request body small even with several
 * 4K canvas keyframes feeding into one generation.
 */
async function refToApimartImageRef(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  if (/^https?:\/\//i.test(url)) {
    const local = maybeLocalPathFor(url)
    if (!local) return url // truly external — let Apimart fetch it
    const { buf } = await readLocalRefBuffer(local)
    const compressed = await compressRefForUpload(buf)
    return `data:${compressed.mime};base64,${compressed.buf.toString('base64')}`
  }
  // Root-relative local path (most common: /uploads/<uuid>.png)
  const { buf } = await readLocalRefBuffer(url)
  const compressed = await compressRefForUpload(buf)
  return `data:${compressed.mime};base64,${compressed.buf.toString('base64')}`
}

interface ApimartTaskResult {
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string
  progress?: number
  result?: { images?: Array<{ url?: string | string[]; expires_at?: number }> }
  error?: { code?: string; message?: string }
}

/**
 * Poll a submitted Apimart image task to completion and return the
 * resulting URLs. The image gen flow is now async on api.apimart.ai —
 * submit returns {task_id} immediately, results land in
 * `result.images[i].url` (often an array of one URL per output image).
 */
async function pollApimartTask(taskId: string, opts: { timeoutMs?: number } = {}): Promise<string[]> {
  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY missing')
  const baseUrl = (process.env.APIMART_BASE_URL || APIMART_BASE_URL).replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 180_000
  const deadline = Date.now() + timeoutMs
  // Apimart image tasks typically resolve in 5–40s; poll every 2s with
  // a small jitter so a single batch doesn't all wake up together.
  let interval = 2000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    const r = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
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
    // Back off slightly on later polls so a stuck task doesn't hammer
    // the endpoint, but cap at 5s so we don't add unnecessary latency
    // for tasks that finish in the 8-12s window typical of Gemini.
    interval = Math.min(5000, interval + 500)
  }
  throw new Error(`Apimart task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s`)
}

async function runApimartImage(
  prompt: string,
  aspect: string,
  numImages: number,
  refImages: string[] = [],
  model?: string,
  // sizeOverride is retained for callsite compatibility but ignored —
  // api.apimart.ai expects aspect_ratio strings (e.g. "16:9"), not
  // arbitrary pixel sizes. Panorama callers can request "2:1".
  _sizeOverride?: string,
): Promise<string[]> {
  const key = process.env.APIMART_API_KEY
  if (!key) throw new Error('APIMART_API_KEY 未配置 — 无法生成图片')

  const rawModel =
    model || process.env.APIMART_IMAGE_MODEL || APIMART_IMAGE_MODEL
  const resolvedModel = normalizeApimartImageModel(rawModel)
  const baseUrl = (process.env.APIMART_BASE_URL || APIMART_BASE_URL).replace(/\/$/, '')

  const validRefs = refImages.filter((url) => /^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('/'))
  if (validRefs.length > REF_CAP) {
    console.warn(
      `[image] ref cap (${REF_CAP}) hit — dropping ${validRefs.length - REF_CAP} of ${validRefs.length} refs.`,
    )
  }
  const refs = validRefs.slice(0, REF_CAP)

  // Resolve refs to body-ready strings (data: URLs for local files,
  // passthrough for public http(s)). One failed ref is tolerated; if
  // all fail and we had refs to begin with, surface the underlying
  // errors so the caller can fix bad URLs.
  const imageRefs: string[] = []
  const skipped: string[] = []
  let totalBodyBytes = 0
  for (let i = 0; i < refs.length; i++) {
    try {
      const v = await refToApimartImageRef(refs[i]!)
      // Approximate the JSON body size (data URL strings dominate).
      const addBytes = v.length + 4
      if (imageRefs.length > 0 && totalBodyBytes + addBytes > APIMART_MULTIPART_BUDGET_BYTES) {
        console.warn(
          `[image] body budget hit at ref ${i + 1}/${refs.length}: cumulative=${totalBodyBytes}B, would add=${addBytes}B, cap=${APIMART_MULTIPART_BUDGET_BYTES}B — dropping remaining ${refs.length - i} refs.`,
        )
        break
      }
      imageRefs.push(v)
      totalBodyBytes += addBytes
    } catch (e) {
      skipped.push(`ref ${i + 1} (${refs[i]?.slice(0, 60)}…): ${(e as Error).message}`)
      console.warn(`[image] skipping ref ${i + 1}: ${(e as Error).message}`)
    }
  }
  if (refs.length > 0 && imageRefs.length === 0) {
    throw new Error(
      `图片生成失败：${refs.length} 张参考图全部无法解析。详情：\n${skipped.join('\n')}`,
    )
  }

  const body: Record<string, unknown> = {
    model: resolvedModel,
    prompt,
    n: numImages,
    aspect_ratio: aspect || '16:9',
  }
  if (imageRefs.length > 0) body.image = imageRefs

  console.log(`[image] Apimart submit  model=${resolvedModel}  refs=${imageRefs.length}/${refs.length}  aspect=${aspect}  bodyKB=${(totalBodyBytes / 1024).toFixed(0)}`)
  const submitRes = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!submitRes.ok) {
    const errBody = (await submitRes.text()).slice(0, 600)
    throw new Error(`Apimart image submit ${submitRes.status}: ${errBody}`)
  }
  const submitJson = (await submitRes.json()) as {
    code?: number
    data?: Array<{ task_id?: string; status?: string }>
    // Defensive: some legacy models may still respond synchronously
    // with the old {data:[{url|b64_json}]} shape. We handle both.
    images?: Array<{ url?: string; b64_json?: string }>
    error?: { message?: string }
  }

  // Sync-shaped legacy response (rare on api.apimart.ai but cheap to handle).
  const legacyArr: Array<{ url?: string; b64_json?: string }> = []
  for (const item of submitJson.data ?? []) {
    if ((item as { url?: string }).url) legacyArr.push({ url: (item as { url?: string }).url })
    if ((item as { b64_json?: string }).b64_json) legacyArr.push({ b64_json: (item as { b64_json?: string }).b64_json })
  }
  for (const item of submitJson.images ?? []) legacyArr.push(item)
  const legacyUrls = legacyArr
    .map((img) => img.url || (img.b64_json ? saveBase64ImageToUploads(img.b64_json) : undefined))
    .filter((u): u is string => Boolean(u))
  if (legacyUrls.length > 0) return legacyUrls

  const taskId = submitJson.data?.[0]?.task_id
  if (!taskId) {
    throw new Error(
      `Apimart image: no task_id in submit response (${JSON.stringify(submitJson).slice(0, 400)})`,
    )
  }
  return await pollApimartTask(taskId)
}

/**
 * Persist a base64 image returned by a provider (b64_json path) to
 * public/uploads/ and return its `/uploads/<uuid>.<ext>` URL. The
 * client must never see raw `data:image/png;base64,…` URLs — they
 * land directly in Zustand stores, balloon the IDB snapshot past the
 * 5 MB cap in idb-storage.ts, the write is silently refused, and on
 * refresh the user's newly-generated keyframes/videos vanish.
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

async function runFalFluxImage(prompt: string, aspect: string, numImages: number, refImage?: string): Promise<string[]> {
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const sizeMap: Record<string, string> = {
    '1:1': 'square_hd', '9:16': 'portrait_16_9', '16:9': 'landscape_16_9', '4:3': 'landscape_4_3',
  }
  const body: Record<string, unknown> = {
    prompt,
    image_size: sizeMap[aspect] ?? 'landscape_16_9',
    num_images: numImages,
  }
  if (refImage) body.image_url = refImage
  const res = await fetch('https://fal.run/fal-ai/flux-pro/v1.1', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`FAL ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { images?: { url: string }[] }
  const urls = data.images?.map((i) => i.url) ?? []
  if (urls.length === 0) throw new Error('FAL: no images in response')
  return urls
}

async function runFluxImage(
  prompt: string,
  aspect: string,
  numImages: number,
  refImages: string[] = [],
  model?: string,
  sizeOverride?: string,
): Promise<string[]> {
  // Apimart is the only image backend — FAL is no longer used here.
  // Opt back in to FAL with ENABLE_FAL_IMAGE_FALLBACK=1 (off by default).
  try {
    const urls = await runApimartImage(prompt, aspect, numImages, refImages, model, sizeOverride)
    if (urls.length) return urls
    throw new Error('Apimart 返回空结果')
  } catch (error) {
    if (process.env.ENABLE_FAL_IMAGE_FALLBACK === '1') {
      console.warn(`[image] Apimart failed; FAL fallback enabled: ${(error as Error).message}`)
      return runFalFluxImage(prompt, aspect, numImages, refImages[0])
    }
    throw new Error(`图片生成失败 (Apimart): ${(error as Error).message}`)
  }
}

/**
 * Read an optional Apimart model id from caller params. Director-
 * agent pins this (currently `openai/gpt-5.4-image-2`); other call
 * sites can omit it and accept the env default. Any non-tokenrouter
 * provider hint is ignored — Apimart is the only image backend.
 */
function modelFromParams(params: Record<string, unknown> | undefined): string | undefined {
  const m = params?.model
  return typeof m === 'string' && m.length > 0 ? m : undefined
}

// Caller-pinned pixel size, e.g. scene panoramas ask for '3840x2160'
// (the gpt-image-2 max — long edge ≤ 3840). Anything that doesn't look
// like `<digits>x<digits>` is ignored and the aspect→size default kicks
// in. Keep validation here so a typo at the call site doesn't propagate
// into an Apimart 400.
function sizeFromParams(params: Record<string, unknown> | undefined): string | undefined {
  const s = params?.size
  return typeof s === 'string' && /^\d+x\d+$/.test(s) ? s : undefined
}

async function textToImage(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const refs = getImages(req.inputs)
  const aspect = (req.params?.aspect as string) || '16:9'
  const urls = await runFluxImage(
    text || 'a beautiful scene',
    aspect,
    1,
    refs,
    modelFromParams(req.params),
    sizeFromParams(req.params),
  )
  return { outputs: urls.map((url) => ({ kind: 'image' as const, url })) }
}

async function batchImage(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const refs = getImages(req.inputs)
  const aspect = (req.params?.aspect as string) || '16:9'
  const urls = await runFluxImage(text || 'a beautiful scene', aspect, 4, refs, modelFromParams(req.params))
  return { outputs: urls.map((url) => ({ kind: 'image' as const, url })) }
}

async function smartEdit(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  if (!images.length) throw new Error('需要输入图片')
  // Resolve image to data URL so OpenAI can read it
  const imageDataUrl = await resolveImageToDataUrl(images[0])
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: await buildEditFormData(imageDataUrl, text || 'enhance this image'),
  })
  if (!res.ok) {
    // Fallback to text-to-image with reference
    const fallbackPrompt = `${text || 'enhance'}, based on the reference image`
    return textToImage({ ...req, inputs: [{ kind: 'text', text: fallbackPrompt }, { kind: 'image', url: imageDataUrl }] })
  }
  const data = (await res.json()) as { data?: { url?: string }[] }
  const url = data.data?.[0]?.url
  if (!url) throw new Error('OpenAI: no image')
  return { outputs: [{ kind: 'image', url }] }
}

async function buildEditFormData(imageUrl: string, prompt: string): Promise<FormData> {
  const form = new FormData()
  form.append('prompt', prompt)
  form.append('model', 'gpt-image-1')
  form.append('n', '1')
  if (imageUrl.startsWith('data:')) {
    const m = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (m) {
      const buf = Buffer.from(m[2], 'base64')
      form.append('image', new Blob([buf], { type: m[1] }), 'image.png')
    }
  } else {
    const r = await fetch(imageUrl)
    const buf = await r.arrayBuffer()
    form.append('image', new Blob([buf], { type: 'image/png' }), 'image.png')
  }
  return form
}

async function inpaint(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  if (!images.length) throw new Error('需要输入图片')
  const maskUrl = req.params?.mask_url as string | undefined
  // Resolve image to data URL (FAL accepts data URLs)
  const imageDataUrl = await resolveImageToDataUrl(images[0])
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const body: Record<string, unknown> = {
    prompt: text || 'fill the masked area naturally',
    image_url: imageDataUrl,
    num_images: 1,
  }
  if (!maskUrl) throw new Error('需要标记区域（mask_url 缺失）')
  body.mask_url = maskUrl
  console.log(`[inpaint] image: ${imageDataUrl.slice(0, 50)}... mask: ${maskUrl.slice(0, 50)}... prompt: ${text}`)
  const res = await fetch('https://fal.run/fal-ai/flux-general/inpainting', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error(`[inpaint] FAL error ${res.status}:`, errText.slice(0, 500))
    throw new Error(`FAL inpaint ${res.status}: ${errText}`)
  }
  const data = (await res.json()) as { images?: { url: string }[] }
  const url = data.images?.[0]?.url
  if (!url) throw new Error('FAL: no inpaint result')
  return { outputs: [{ kind: 'image', url }] }
}

async function upscaleImage(req: CapReq): Promise<CapRes> {
  const images = getImages(req.inputs)
  if (!images.length) throw new Error('需要输入图片')
  const scale = Number(req.params?.scale ?? 2)
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const res = await fetch('https://fal.run/fal-ai/clarity-upscaler', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: images[0], scale }),
  })
  if (!res.ok) throw new Error(`FAL upscale ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { image?: { url: string } }
  const url = data.image?.url
  if (!url) throw new Error('FAL: no upscale result')
  return { outputs: [{ kind: 'image', url }] }
}

async function outpaint(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  if (!images.length) throw new Error('需要输入图片')
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const res = await fetch('https://fal.run/fal-ai/flux-pro/v1.1/outpainting', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: images[0],
      prompt: text || 'extend the scene naturally',
      num_images: 1,
    }),
  })
  if (!res.ok) throw new Error(`FAL outpaint ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { images?: { url: string }[] }
  const url = data.images?.[0]?.url
  if (!url) throw new Error('FAL: no outpaint result')
  return { outputs: [{ kind: 'image', url }] }
}

async function cropImage(req: CapReq): Promise<CapRes> {
  const images = getImages(req.inputs)
  if (!images.length) throw new Error('需要输入图片')
  const aspect = (req.params?.aspect as string) || '16:9'
  const prompt = `Crop this image to ${aspect} aspect ratio, keeping the most important subject in frame`
  return smartEdit({ ...req, inputs: [{ kind: 'text', text: prompt }, { kind: 'image', url: images[0] }] })
}

async function shotAssociation(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  let enhancedPrompt: string
  if (images.length > 0) {
    enhancedPrompt = await geminiVision(
      `分析这张分镜图，生成一个相关但不同的镜头变体。描述新镜头的画面内容、构图、氛围。
只输出英文 prompt，不超过 150 词，可直接用于图片生成。`,
      text || '生成一个相关的镜头变体',
      images[0],
    )
  } else {
    enhancedPrompt = await geminiText(
      `基于用户描述，联想生成一个相关的镜头变体。输出英文 prompt，不超过 150 词。`,
      text,
    )
  }
  return textToImage({ capability: 'text-to-image', inputs: [{ kind: 'text', text: enhancedPrompt }], params: req.params })
}

async function multiAngle(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  const angle = (req.params?.angle as string) || 'side'
  const angleMap: Record<string, string> = {
    front: 'front view, straight-on perspective',
    side: 'side profile view, 90-degree angle',
    back: 'rear view, from behind',
    top: 'top-down overhead view, birds eye',
    low: 'low angle looking up, dramatic perspective',
    bird: 'aerial birds eye view from high above',
  }
  let prompt: string
  if (images.length > 0) {
    prompt = await geminiVision(
      `分析这张图片的场景和角色。用英文描述同一场景从 ${angleMap[angle] || angle} 角度看到的画面。
输出可直接用于图片生成的 prompt，不超过 150 词。`,
      text || '',
      images[0],
    )
  } else {
    prompt = `${text}, ${angleMap[angle] || angle}`
  }
  return textToImage({ capability: 'text-to-image', inputs: [{ kind: 'text', text: prompt }], params: req.params })
}

async function angleAdjust(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  const shotType = (req.params?.shot_type as string) || 'medium'
  const shotMap: Record<string, string> = {
    'extreme-close': 'extreme close-up, showing fine details',
    'close': 'close-up shot, head and shoulders',
    'medium': 'medium shot, waist up',
    'full': 'full shot, entire body visible',
    'wide': 'wide shot, character in environment',
    'establishing': 'extreme wide establishing shot, full environment',
  }
  let prompt: string
  if (images.length > 0) {
    prompt = await geminiVision(
      `分析这张图片。用英文描述将这个场景改为 ${shotMap[shotType] || shotType} 的画面。
保持角色和场景不变，只调整景别。输出可直接用于图片生成的 prompt，不超过 150 词。`,
      text || '',
      images[0],
    )
  } else {
    prompt = `${text}, ${shotMap[shotType] || shotType}`
  }
  return textToImage({ capability: 'text-to-image', inputs: [{ kind: 'text', text: prompt }], params: req.params })
}

async function poseEdit(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  if (!images.length) throw new Error('需要输入图片')
  let prompt: string
  if (text) {
    prompt = await geminiVision(
      `分析图片中人物的姿势。用户想要调整为: "${text}"。
输出英文 prompt 描述调整后的完整画面，保持人物和场景不变，只改变姿势。不超过 150 词。`,
      text,
      images[0],
    )
  } else {
    prompt = await geminiVision(
      `分析图片中人物的姿势。生成一个自然的姿势变体。
输出英文 prompt 描述变体画面，不超过 150 词。`,
      '',
      images[0],
    )
  }
  return textToImage({
    capability: 'text-to-image',
    inputs: [{ kind: 'text', text: prompt }, { kind: 'image', url: images[0] }],
    params: req.params,
  })
}

// ─── Video capabilities ──────────────────────────────────────────────

function isSupportedRasterDataUrl(url: string): boolean {
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url.trim())
  if (!match) return false
  const payload = match[2]
  return payload.length > 0 && payload.length % 4 !== 1
}

/**
 * A URL the Seedance call can resolve once we inline it. Three valid shapes:
 *   - absolute http(s)://... — Seedance fetches directly
 *   - raster data:image/(png|jpe?g|webp);base64,... — Seedance accepts inline
 *   - root-relative path (/uploads/..., /voices/...) — local files served
 *     by Vite. We read them off disk and rewrite to a data: URL in
 *     `inlineLocalRefsInContentParts` BEFORE submitting, so Seedance never
 *     has to reach back into the dev server.
 *
 * Previously this filter rejected root-relative paths outright, which
 * dropped every user-uploaded image (saved under /uploads/) and every
 * voice file (under /voices/) before they could reach the model. The
 * symptom was either "全能生视频至少需要 1 张图片或 1 个视频" or a
 * silently characterless video.
 */
function isSeedanceMediaUrl(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed.length <= 2) return false
  if (/^https?:\/\//i.test(trimmed)) return true
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('/voices/')) return true
  return isSupportedRasterDataUrl(trimmed)
}

/** Back-compat alias — the filter is now kind-agnostic. */
const isSeedanceImageUrl = isSeedanceMediaUrl

function filterValidRefs(urls: string[]): string[] {
  return urls.filter(isSeedanceMediaUrl).map((u) => u.trim())
}

// Exported helpers for tests in src/lib/__tests__/seedance-url-handling.test.ts.
export { isSeedanceMediaUrl, filterValidRefs, inlineLocalRefsInContentParts, detectVideoType }

// ─── Seedance video generation type helpers (inlined for Node server) ──
// Duplicated from src/lib/capabilities/video-types.ts because Vite plugins
// run in Node and can't resolve the @/ path alias.

type VideoGenType =
  | 'text-to-video'
  | 'image-to-video-first'
  | 'image-to-video-first-last'
  | 'reference-to-video'
  | 'universal-to-video'

interface VideoInputs {
  images: string[]
  videos: string[]
  audios: string[]
  mode?: 'first-last' | 'reference'
}

function detectVideoType(inputs: VideoInputs): VideoGenType {
  if (inputs.videos.length > 0 || inputs.audios.length > 0) return 'universal-to-video'
  const n = inputs.images.length
  if (n === 0) return 'text-to-video'
  if (n === 1) return 'image-to-video-first'
  if (n === 2 && inputs.mode !== 'reference') return 'image-to-video-first-last'
  return 'reference-to-video'
}

function buildContentParts(
  prompt: string,
  inputs: VideoInputs,
  type: VideoGenType,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text: prompt || 'cinematic video' }]
  switch (type) {
    case 'text-to-video':
      break
    case 'image-to-video-first':
      parts.push({ type: 'image_url', image_url: { url: inputs.images[0] }, role: 'first_frame' })
      break
    case 'image-to-video-first-last':
      parts.push({ type: 'image_url', image_url: { url: inputs.images[0] }, role: 'first_frame' })
      parts.push({ type: 'image_url', image_url: { url: inputs.images[1] }, role: 'last_frame' })
      break
    case 'reference-to-video':
      for (const url of inputs.images.slice(0, 9)) {
        parts.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
      }
      break
    case 'universal-to-video':
      for (const url of inputs.images.slice(0, 9)) {
        parts.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
      }
      for (const url of inputs.videos.slice(0, 3)) {
        parts.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
      }
      for (const url of inputs.audios.slice(0, 3)) {
        parts.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
      }
      break
  }
  return parts
}

/**
 * Inline every root-relative URL in a Seedance contentParts array as a
 * data: URL by reading the local file off `public/`. Image / video /
 * audio parts all share this path because Seedance can't reach back into
 * our dev server — anything we want it to "see" must travel inline.
 *
 * Absolute http(s) and already-inline data: URLs pass through untouched.
 */
async function inlineLocalRefsInContentParts(
  contentParts: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const out = await Promise.all(contentParts.map(async (part) => {
    const type = part.type as string | undefined
    if (type === 'image_url') {
      const url = (part.image_url as { url?: string } | undefined)?.url
      if (typeof url === 'string' && url.startsWith('/')) {
        const inlined = await resolveImageToDataUrl(url)
        return { ...part, image_url: { ...(part.image_url as object), url: inlined } }
      }
    } else if (type === 'video_url') {
      const url = (part.video_url as { url?: string } | undefined)?.url
      if (typeof url === 'string' && url.startsWith('/')) {
        const inlined = await readLocalAsDataUrl(url)
        return { ...part, video_url: { ...(part.video_url as object), url: inlined } }
      }
    } else if (type === 'audio_url') {
      const url = (part.audio_url as { url?: string } | undefined)?.url
      if (typeof url === 'string' && url.startsWith('/')) {
        const inlined = await readLocalAsDataUrl(url)
        return { ...part, audio_url: { ...(part.audio_url as object), url: inlined } }
      }
    }
    return part
  }))
  return out
}

/** Generic local-file → data URL reader for non-image media (audio, video).
 *  Picks the mime type from the extension. */
async function readLocalAsDataUrl(localPath: string): Promise<string> {
  const { readFileSync } = await import('fs')
  const { join } = await import('path')
  const decoded = decodeURIComponent(localPath)
  const buf = readFileSync(join(process.cwd(), 'public', decoded))
  const ext = decoded.split('.').pop()?.toLowerCase() ?? ''
  const mime =
    ext === 'mp3' ? 'audio/mpeg' :
    ext === 'wav' ? 'audio/wav' :
    ext === 'flac' ? 'audio/flac' :
    ext === 'm4a' ? 'audio/mp4' :
    ext === 'ogg' ? 'audio/ogg' :
    ext === 'mp4' ? 'video/mp4' :
    ext === 'webm' ? 'video/webm' :
    ext === 'mov' ? 'video/quicktime' :
    'application/octet-stream'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/** Convert a local /uploads/ path to a file:// readable buffer, or fetch remote URL as base64 data URL */
async function resolveImageToDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:')) {
    if (!isSupportedRasterDataUrl(imageUrl)) throw new Error('unsupported image data URL for Seedance')
    return imageUrl
  }
  if (imageUrl.startsWith('/')) {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    // URL-decode so CJK filenames (typical for /voices/) resolve to the
    // actual disk path. Strip query strings too — they're cache-busters.
    const decoded = decodeURIComponent(imageUrl.split('?')[0])
    const buf = readFileSync(join(process.cwd(), 'public', decoded))
    const ext = decoded.split('.').pop()?.toLowerCase() ?? 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  }
  // Remote URL — fetch and convert
  const r = await fetch(imageUrl)
  if (!r.ok) throw new Error(`fetch image failed: ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  const contentType = r.headers.get('content-type') || 'image/png'
  if (!/^image\/(png|jpe?g|webp)$/i.test(contentType)) {
    throw new Error(`unsupported fetched image type for Seedance: ${contentType}`)
  }
  return `data:${contentType};base64,${buf.toString('base64')}`
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function escapeSvgAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Seedance sometimes rejects realistic face input images. On video generation
 * failure, retry by wrapping each input image in an SVG containing the original
 * image plus a 6×6 white grid overlay (12px, 100% opacity).
 */
export function createSeedanceGridOverlayImageUrl(imageUrl: string): string {
  const escapedUrl = escapeSvgAttr(imageUrl)
  const gridLines = Array.from({ length: 7 }, (_, i) => {
    const p = (i / 6) * 1024
    return `<line x1="${p}" y1="0" x2="${p}" y2="1024"/><line x1="0" y1="${p}" x2="1024" y2="${p}"/>`
  }).join('')

  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" data-grid="6x6">
  <image href="${escapedUrl}" x="0" y="0" width="1024" height="1024" preserveAspectRatio="xMidYMid slice"/>
  <g stroke="white" stroke-width="12" stroke-opacity="1" fill="none" vector-effect="non-scaling-stroke">${gridLines}</g>
</svg>`)
}

export function buildSeedanceGridRetryContentParts(
  contentParts: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  // The historical grid retry returned SVG data URLs. Doubao/Seedance rejects
  // those as image_url, so keep the original parts until this can rasterize to
  // PNG/JPEG/WebP or upload a real image URL.
  return contentParts.map((part) => {
    return part
  })
}

function hasGridRetryChangedImageParts(
  original: Array<Record<string, unknown>>,
  retry: Array<Record<string, unknown>>,
): boolean {
  return retry.some((part, index) => {
    if (part.type !== 'image_url') return false
    const originalUrl = (original[index]?.image_url as { url?: unknown } | undefined)?.url
    const retryUrl = (part.image_url as { url?: unknown } | undefined)?.url
    return typeof retryUrl === 'string' && retryUrl !== originalUrl
  })
}

function hasSeedanceImageParts(contentParts: Array<Record<string, unknown>>): boolean {
  return contentParts.some((part) => part.type === 'image_url' && typeof (part.image_url as { url?: unknown } | undefined)?.url === 'string')
}

/**
 * BytePlus海外 (Dreamina — Seedance / Seedream) base URL.
 * Honors ARK_BASE_URL / ARK_API_BASE_URL so an operator can flip the host
 * via env without a code change. Defaults to ap-southeast.bytepluses.com —
 * the legacy cn-beijing.volces.com (火山方舟国内) endpoint was removed.
 */
function arkBaseUrl(): string {
  const raw = process.env.ARK_BASE_URL || process.env.ARK_API_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3'
  return raw.replace(/\/+$/, '')
}

/**
 * Default Seedance model id. Prefers SEEDANCE_MODEL / SEEDANCE_ENDPOINT
 * because BytePlus海外 expects an account-specific endpoint id (e.g.
 * `ep-20260423151341-p2zm9`) rather than the universal model name; the
 * universal `dreamina-seedance-2-0-fast-260128` is kept as a sane fallback.
 */
function defaultSeedanceModel(): string {
  return process.env.SEEDANCE_MODEL || process.env.SEEDANCE_ENDPOINT || process.env.ARK_SEEDANCE_ENDPOINT || 'dreamina-seedance-2-0-fast-260128'
}

/**
 * Map the universal Seedance model id the UI emits to the account-bound
 * endpoint id BytePlus海外 actually accepts for video task creation. Without
 * this, posting `model: 'dreamina-seedance-2-0-fast-260128'` to ark-* gets
 * a 403 AccessDenied — the universal id isn't a real endpoint for any
 * specific account. Resolution order:
 *   1. Already an `ep-…` endpoint id → pass through.
 *   2. Per-model env override `SEEDANCE_ENDPOINT_<MODEL_SLUG>` (uppercased,
 *      non-alnum → '_'). Set this in env when the project pins a specific
 *      universal id to a specific endpoint.
 *   3. Static fallback table for the models we ship by default.
 *   4. Generic `SEEDANCE_ENDPOINT` / `ARK_SEEDANCE_ENDPOINT` env override.
 *   5. The original model id (so misconfig surfaces as the same 403 the
 *      caller would have seen before this helper existed — no silent drop).
 *
 * Mirrors the resolver in vite-providers-plugin.ts. Kept duplicated to avoid
 * coupling the two Vite plugin files (they run as independent middleware).
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

/** Shared Seedance task submission — handles content parts + polling. */
async function submitSeedanceTaskOnce(opts: {
  contentParts: Array<Record<string, unknown>>
  model?: string
  resolution?: string
  aspect?: string
  duration?: number
  generateAudio?: boolean
  seed?: number
  invitedImageAssetIds?: string[]
}): Promise<string> {
  // Prefer BYTEPLUS_ARK_API_KEY (海外侧 ark-* Bearer token); fall back to
  // the legacy ARK_API_KEY for envs that haven't been migrated yet. The
  // legacy key was a Volcengine cn-beijing token and is no longer accepted.
  const key = process.env.BYTEPLUS_ARK_API_KEY || process.env.ARK_API_KEY
  if (!key) throw new Error('BYTEPLUS_ARK_API_KEY (or legacy ARK_API_KEY) not set')
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
  const base = arkBaseUrl()

  // Inline any root-relative refs (/uploads/, /voices/) as data URLs so
  // BytePlus can actually fetch them — it sits in ap-southeast and can't
  // hit our localhost dev server.
  const content = await inlineLocalRefsInContentParts(opts.contentParts)

  const body: Record<string, unknown> = {
    model: resolveSeedanceModel(opts.model ?? defaultSeedanceModel()),
    content,
    resolution: opts.resolution ?? '480p',
    ratio: opts.aspect ?? '16:9',
    duration: Math.max(4, Math.min(15, opts.duration ?? 5)),
    generate_audio: opts.generateAudio ?? true,
  }
  if (opts.seed != null && opts.seed >= 0) body.seed = opts.seed
  // Privacy-block fallback: when the caller pre-registered character refs
  // as BytePlus digital assets, ship them as invited_images so the
  // moderator treats those characters as approved. Empty array = omit.
  if (opts.invitedImageAssetIds?.length) {
    body.invited_images = opts.invitedImageAssetIds.map((id) => ({ asset_id: id }))
  }

  const createRes = await fetch(`${base}/contents/generations/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify(body),
  })
  if (!createRes.ok) throw new Error(`BytePlus create ${createRes.status}: ${await createRes.text()}`)
  const taskId = ((await createRes.json()) as { id?: string }).id
  if (!taskId) throw new Error('BytePlus: no task id')

  return poll<string>(async () => {
    const r = await fetch(`${base}/contents/generations/tasks/${taskId}`, { headers })
    if (!r.ok) return { done: false, error: `status ${r.status}` }
    const d = (await r.json()) as Record<string, unknown>
    const status = d.status as string | undefined
    const video = (d.content as { video_url?: string } | undefined)?.video_url
      ?? ((d.output as Record<string, unknown> | undefined)?.video as { url?: string } | undefined)?.url
    if (status === 'succeeded' && video) return { done: true, result: video }
    if (status === 'failed' || status === 'cancelled') return { done: false, error: `task ${status}` }
    return { done: false }
  }, { intervalMs: 4000, timeoutMs: 6 * 60 * 1000 })
}

async function submitSeedanceTask(opts: {
  contentParts: Array<Record<string, unknown>>
  model?: string
  resolution?: string
  aspect?: string
  duration?: number
  generateAudio?: boolean
  seed?: number
  invitedImageAssetIds?: string[]
}): Promise<string> {
  try {
    return await submitSeedanceTaskOnce(opts)
  } catch (firstError) {
    if (!hasSeedanceImageParts(opts.contentParts)) throw firstError

    const retryOpts = {
      ...opts,
      contentParts: buildSeedanceGridRetryContentParts(opts.contentParts),
    }
    if (!hasGridRetryChangedImageParts(opts.contentParts, retryOpts.contentParts)) throw firstError

    try {
      return await submitSeedanceTaskOnce(retryOpts)
    } catch (retryError) {
      const firstMessage = (firstError as Error).message ?? String(firstError)
      const retryMessage = (retryError as Error).message ?? String(retryError)
      throw new Error(`Seedance failed, grid-overlay retry also failed: ${retryMessage}; original: ${firstMessage}`)
    }
  }
}

async function textToVideo(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = filterValidRefs(getImages(req.inputs))
  // Audios + videos used to be hard-coded to []. Cinematographer ships
  // voice audio refs through this same capability id, and the storyboard
  // beat-video flow does too — dropping them silently meant Seedance
  // never received the 音色 references the prompt asked it to follow.
  const videos = filterValidRefs(getVideos(req.inputs))
  const audios = filterValidRefs(getAudios(req.inputs))
  if (!text && !images.length && !videos.length) throw new Error('需要输入文本或参考图')

  const mode = (req.params?.mode as 'first-last' | 'reference' | undefined)
  // When audios or videos are present, detectVideoType promotes the call
  // to universal-to-video so the build step emits the audio_url / video_url
  // parts BytePlus expects. Image-only calls keep the image-to-video-first
  // / image-to-video-first-last / reference-to-video routing.
  const type = detectVideoType({ images, videos, audios, mode })
  const contentParts = buildContentParts(text, { images, videos, audios, mode }, type)

  const model = (req.params?.model as string) || 'dreamina-seedance-2-0-fast-260128'
  const resolution = (req.params?.resolution as string) || '480p'
  const aspect = (req.params?.aspect as string) || '16:9'
  const duration = Number(req.params?.duration ?? 5)
  // eslint-disable-next-line no-console
  console.log('[voice-debug][text-to-video] dispatch', {
    detectedType: type,
    counts: { images: images.length, videos: videos.length, audios: audios.length },
    model, resolution, aspect, duration,
    audiosBytes: audios.map((u) => audioRefSummary(u)),
    promptHead: text.slice(0, 300),
    promptLength: text.length,
    promptHasVoiceBlock: /音色\d+/.test(text),
  })

  const url = await submitSeedanceTask({
    contentParts,
    model,
    resolution,
    aspect,
    duration,
    generateAudio: req.params?.generate_audio !== false,
    seed: req.params?.seed != null ? Number(req.params.seed) : undefined,
    invitedImageAssetIds: Array.isArray(req.params?.invitedImageAssetIds)
      ? (req.params!.invitedImageAssetIds as string[])
      : undefined,
  })
  return { outputs: [{ kind: 'video', url }] }
}

function audioRefSummary(u: string): string {
  if (u.startsWith('data:')) {
    const head = u.slice(0, 30)
    const bytes = Math.round((u.length - head.length) * 0.75)  // base64 → bytes
    return `${head}… (${(bytes / 1024).toFixed(1)}KB inline)`
  }
  return u.length > 120 ? `${u.slice(0, 117)}…` : u
}

async function universalToVideo(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = filterValidRefs(getImages(req.inputs))
  const videos = filterValidRefs(getVideos(req.inputs))
  const audios = filterValidRefs(getAudios(req.inputs))

  if (images.length === 0 && videos.length === 0) {
    throw new Error('全能生视频至少需要 1 张图片或 1 个视频')
  }

  const contentParts = buildContentParts(text, { images, videos, audios }, 'universal-to-video')

  const url = await submitSeedanceTask({
    contentParts,
    model: (req.params?.model as string) || 'dreamina-seedance-2-0-fast-260128',
    resolution: (req.params?.resolution as string) || '480p',
    aspect: (req.params?.aspect as string) || '16:9',
    duration: Number(req.params?.duration ?? 5),
    generateAudio: req.params?.generate_audio !== false,
    seed: req.params?.seed != null ? Number(req.params.seed) : undefined,
    invitedImageAssetIds: Array.isArray(req.params?.invitedImageAssetIds)
      ? (req.params!.invitedImageAssetIds as string[])
      : undefined,
  })
  return { outputs: [{ kind: 'video', url }] }
}

async function firstLastFrame(req: CapReq): Promise<CapRes> {
  const images = getImages(req.inputs)
  if (images.length < 1) throw new Error('需要至少 1 张图片作为首帧')
  const text = getText(req.inputs) || 'smooth transition between frames'
  // Force first-last mode: 1 image = first frame, 2 images = first + last frame
  return textToVideo({
    capability: 'text-to-video',
    inputs: [
      { kind: 'text', text },
      ...images.map((url) => ({ kind: 'image' as const, url })),
    ],
    params: { ...req.params, mode: 'first-last' },
  })
}

async function multiRefVideo(req: CapReq): Promise<CapRes> {
  const images = getImages(req.inputs)
  const text = getText(req.inputs)
  if (images.length < 2) throw new Error('需要至少 2 张参考图（单张请用文生视频的首帧模式）')
  // Force reference mode for 2+ images (otherwise 2 images = first+last frame)
  return textToVideo({
    capability: 'text-to-video',
    inputs: [
      { kind: 'text', text: text || 'create a video combining these reference images' },
      ...images.map((url) => ({ kind: 'image' as const, url })),
    ],
    params: { ...req.params, mode: 'reference' },
  })
}

async function upscaleVideo(req: CapReq): Promise<CapRes> {
  const videos = getVideos(req.inputs)
  if (!videos.length) throw new Error('需要输入视频')
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const res = await fetch('https://fal.run/fal-ai/video-upscaler', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videos[0] }),
  })
  if (!res.ok) throw new Error(`FAL video upscale ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { video?: { url: string } }
  const url = data.video?.url
  if (!url) throw new Error('FAL: no upscaled video')
  return { outputs: [{ kind: 'video', url }] }
}

async function lipSync(req: CapReq): Promise<CapRes> {
  const videos = getVideos(req.inputs)
  const audios = getAudios(req.inputs)
  if (!videos.length) throw new Error('需要输入视频')
  if (!audios.length) throw new Error('需要输入音频')
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const res = await fetch('https://fal.run/fal-ai/sync-lipsync', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videos[0], audio_url: audios[0] }),
  })
  if (!res.ok) throw new Error(`FAL lip-sync ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { video?: { url: string } }
  const url = data.video?.url
  if (!url) throw new Error('FAL: no lip-sync result')
  return { outputs: [{ kind: 'video', url }] }
}

async function motionImitation(req: CapReq): Promise<CapRes> {
  const videos = getVideos(req.inputs)
  const images = getImages(req.inputs)
  if (!videos.length) throw new Error('需要输入参考视频（含动作）')
  if (!images.length) throw new Error('需要输入目标人物图')
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const mode = (req.params?.mode as string) || 'std'
  // std: animate-anyone (pose-driven), pro: dreamactor/v2 (ByteDance, higher quality)
  const endpoint = mode === 'pro'
    ? 'fal-ai/bytedance/dreamactor/v2'
    : 'fal-ai/animate-anyone'
  const body: Record<string, unknown> = mode === 'pro'
    ? { reference_image: images[0], driving_video: videos[0] }
    : { reference_image_url: images[0], motion_video_url: videos[0] }
  const res = await fetch(`https://fal.run/${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`FAL motion ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { video?: { url: string }; output?: { video?: { url: string }; video_url?: string } }
  const url = data.video?.url ?? data.output?.video?.url ?? data.output?.video_url
  if (!url) throw new Error('FAL: no motion result')
  return { outputs: [{ kind: 'video', url }] }
}

async function videoSplit(req: CapReq): Promise<CapRes> {
  const videos = getVideos(req.inputs)
  if (!videos.length) throw new Error('需要输入视频')
  const analysis = await geminiText(
    `分析视频内容并建议如何按场景切分。输出 JSON 数组格式：
[{ "start": 0, "end": 3.5, "description": "..." }, ...]
每个片段包含起止时间(秒)和场景描述。`,
    `视频 URL: ${videos[0]}`,
  )
  return { outputs: [{ kind: 'text', text: analysis }] }
}

async function videoStyleTransfer(req: CapReq): Promise<CapRes> {
  const videos = getVideos(req.inputs)
  const text = getText(req.inputs)
  if (!videos.length) throw new Error('需要输入视频')
  const style = (req.params?.style as string) || 'anime'
  const stylePrompt: Record<string, string> = {
    'anime': 'anime style, cel-shaded, vibrant colors, Studio Ghibli inspired',
    'oil-painting': 'oil painting style, thick brushstrokes, impressionist',
    'watercolor': 'watercolor painting, soft edges, translucent colors',
    'sketch': 'pencil sketch, black and white, cross-hatching',
    'pixel-art': '8-bit pixel art, retro game style',
    '3d-render': '3D CGI render, Pixar quality, volumetric lighting',
  }
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const res = await fetch('https://fal.run/fal-ai/creative-video', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_url: videos[0],
      prompt: text || stylePrompt[style] || style,
    }),
  })
  if (!res.ok) throw new Error(`FAL style transfer ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { video?: { url: string } }
  const url = data.video?.url
  if (!url) throw new Error('FAL: no style transfer result')
  return { outputs: [{ kind: 'video', url }] }
}

// ─── Audio capabilities ──────────────────────────────────────────────
async function presetVoice(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  if (!text) throw new Error('需要输入文本')
  const voiceId = (req.params?.voice_id as string) || 'alloy'
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', voice: voiceId, input: text }),
  })
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const url = `data:audio/mpeg;base64,${buf.toString('base64')}`
  return { outputs: [{ kind: 'audio', url }] }
}

async function voiceClone(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const audios = getAudios(req.inputs)
  if (!text) throw new Error('需要输入文本')
  if (!audios.length) throw new Error('需要输入参考音频')
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY not set')
  const addRes = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: await buildVoiceCloneForm(audios[0], 'cloned-voice'),
  })
  if (!addRes.ok) throw new Error(`ElevenLabs clone ${addRes.status}: ${await addRes.text()}`)
  const { voice_id } = (await addRes.json()) as { voice_id: string }
  const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  })
  if (!ttsRes.ok) throw new Error(`ElevenLabs TTS ${ttsRes.status}: ${await ttsRes.text()}`)
  const buf = Buffer.from(await ttsRes.arrayBuffer())
  const url = `data:audio/mpeg;base64,${buf.toString('base64')}`
  return { outputs: [{ kind: 'audio', url }] }
}

async function buildVoiceCloneForm(audioUrl: string, name: string): Promise<FormData> {
  const form = new FormData()
  form.append('name', name)
  if (audioUrl.startsWith('data:')) {
    const m = audioUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (m) {
      const buf = Buffer.from(m[2], 'base64')
      form.append('files', new Blob([buf], { type: m[1] }), 'ref.mp3')
    }
  } else {
    const r = await fetch(audioUrl)
    const buf = await r.arrayBuffer()
    form.append('files', new Blob([buf], { type: 'audio/mpeg' }), 'ref.mp3')
  }
  return form
}

async function polyphonicSetting(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  if (!text) throw new Error('需要输入文本')
  const result = await geminiText(
    `你是中文语音合成专家。分析文本中的多音字，标注正确读音。
输出格式：原文 + 每个多音字的拼音标注。
例：输入"银行行长" → "银行(háng)行(xíng)长(zhǎng)"`,
    text,
  )
  return { outputs: [{ kind: 'text', text: result }] }
}

async function soundEffects(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  if (!text) throw new Error('需要输入音效描述')
  const duration = Number(req.params?.duration ?? 5)
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY not set')
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, duration_seconds: duration }),
  })
  if (!res.ok) throw new Error(`ElevenLabs SFX ${res.status}: ${await res.text()}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const url = `data:audio/mpeg;base64,${buf.toString('base64')}`
  return { outputs: [{ kind: 'audio', url }] }
}

// ─── Dispatch ────────────────────────────────────────────────────────
const handlers: Record<string, (req: CapReq) => Promise<CapRes>> = {
  'script-rewrite': scriptRewrite,
  'script-breakdown': scriptBreakdown,
  'element-extraction': elementExtraction,
  'shot-extraction': shotExtraction,
  'consistency-check': consistencyCheck,
  'storyboard-qc': storyboardQC,
  'bridge-row-judge': bridgeRowJudge,
  'text-to-image': textToImage,
  'batch-image': batchImage,
  'smart-edit': smartEdit,
  'inpaint': inpaint,
  'upscale-image': upscaleImage,
  'outpaint': outpaint,
  'crop-image': cropImage,
  'shot-association': shotAssociation,
  'multi-angle': multiAngle,
  'angle-adjust': angleAdjust,
  'pose-edit': poseEdit,
  'text-to-video': textToVideo,
  'first-last-frame': firstLastFrame,
  'multi-ref-video': multiRefVideo,
  'universal-video': universalToVideo,
  'upscale-video': upscaleVideo,
  'lip-sync': lipSync,
  'motion-imitation': motionImitation,
  'video-split': videoSplit,
  'video-style-transfer': videoStyleTransfer,
  'preset-voice': presetVoice,
  'voice-clone': voiceClone,
  'polyphonic': polyphonicSetting,
  'sound-effects': soundEffects,
}

export function capabilitiesPlugin(): Plugin {
  return {
    name: 'capabilities-api',
    configureServer(server) {
      server.middlewares.use('/capabilities/run', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const body = await readJson(req)
          const handler = handlers[body.capability]
          if (!handler) { sendJson(res, 400, { error: `unknown capability: ${body.capability}` }); return }
          const result = await handler(body)
          sendJson(res, 200, result)
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })

      server.middlewares.use('/capabilities/list', (_req, res) => {
        sendJson(res, 200, Object.keys(handlers))
      })

      // Model discovery: returns image + video models with metadata
      server.middlewares.use('/capabilities/models', (_req, res) => {
        // Inline PROVIDERS data to avoid @/ alias issues in Node
        const modelList = {
          image: [
            { id: 'fal-ai/flux-pro/v1.1', label: 'FLUX Pro v1.1', provider: 'fal', costPer: 0.05, supportsRef: false },
            { id: 'fal-ai/flux-pro/v1.1-ultra', label: 'FLUX Pro Ultra', provider: 'fal', costPer: 0.08, supportsRef: false },
            { id: 'fal-ai/flux/dev', label: 'FLUX Dev', provider: 'fal', costPer: 0.025, supportsRef: false },
            { id: 'dreamina-seedream-5-0-260128', label: 'Seedream 5.0', provider: 'doubao', costPer: 0.04, supportsRef: true },
            { id: 'dreamina-seedream-4-5-251128', label: 'Seedream 4.5', provider: 'doubao', costPer: 0.02, supportsRef: true },
            { id: 'dall-e-3', label: 'DALL·E 3', provider: 'openai', costPer: 0.04, supportsRef: false },
            { id: 'gpt-image-1', label: 'GPT Image 1', provider: 'openai', costPer: 0.04, supportsRef: false },
          ],
          video: [
            { id: 'dreamina-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast', provider: 'doubao', costPer: 0.35, supportsAudio: true, supportsRef: true, durations: [5, 10] },
            { id: 'dreamina-seedance-2-0-260128', label: 'Seedance 2.0', provider: 'doubao', costPer: 0.70, supportsAudio: true, supportsRef: true, durations: [5, 10] },
            { id: 'dreamina-seedance-1-5-pro-251215', label: 'Seedance 1.5 Pro', provider: 'doubao', costPer: 0.50, supportsAudio: true, supportsRef: true, durations: [5, 10] },
            { id: 'fal-ai/kling-video/v1.5/pro/text-to-video', label: 'Kling v1.5 Pro', provider: 'fal', costPer: 0.45, supportsAudio: false, supportsRef: false, durations: [5, 10] },
            { id: 'fal-ai/kling-video/v1/standard/text-to-video', label: 'Kling v1 Standard', provider: 'fal', costPer: 0.20, supportsAudio: false, supportsRef: false, durations: [5, 10] },
            { id: 'fal-ai/minimax/video-01/text-to-video', label: 'MiniMax Hailuo', provider: 'fal', costPer: 0.30, supportsAudio: false, supportsRef: false, durations: [6] },
            { id: 'fal-ai/wan-t2v', label: 'Wan2.6 文生视频', provider: 'fal', costPer: 0.10, supportsAudio: false, supportsRef: false, durations: [5] },
            { id: 'fal-ai/hunyuan-video', label: 'HunyuanVideo', provider: 'fal', costPer: 0.25, supportsAudio: false, supportsRef: false, durations: [5] },
          ],
        }
        sendJson(res, 200, modelList)
      })

      // File upload endpoint — saves to public/uploads/, returns URL path
      server.middlewares.use('/uploads/save', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        const started = Date.now()
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = Buffer.concat(chunks)
          console.log(`[uploads/save] received ${(body.length/1024).toFixed(0)}KB body (ct=${req.headers['content-type']})`)

          // Parse multipart or raw binary
          const contentType = req.headers['content-type'] ?? ''
          let fileData: Buffer
          let ext = '.png'

          if (contentType.includes('application/json')) {
            // JSON with base64 data URL
            const json = JSON.parse(body.toString('utf8')) as { dataUrl: string; filename?: string }
            const m = json.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (!m) { sendJson(res, 400, { error: 'invalid data URL' }); return }
            fileData = Buffer.from(m[2], 'base64')
            const mime = m[1]
            if (mime.includes('jpeg') || mime.includes('jpg')) ext = '.jpg'
            else if (mime.includes('png')) ext = '.png'
            else if (mime.includes('webp')) ext = '.webp'
            else if (mime.includes('mp4')) ext = '.mp4'
            else if (mime.includes('webm')) ext = '.webm'
            else if (mime.includes('mp3') || mime.includes('mpeg')) ext = '.mp3'
            else if (mime.includes('wav')) ext = '.wav'
          } else {
            fileData = body
          }

          const uploadsDir = join(process.cwd(), 'public', 'uploads')
          mkdirSync(uploadsDir, { recursive: true })
          const filename = `${randomUUID()}${ext}`
          writeFileSync(join(uploadsDir, filename), fileData)
          const url = `/uploads/${filename}`
          console.log(`[uploads/save] wrote ${url} (${(fileData.length/1024).toFixed(0)}KB) in ${Date.now()-started}ms`)
          sendJson(res, 200, { url })
        } catch (e) {
          console.error(`[uploads/save] FAILED:`, (e as Error).message)
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })

      // ── /thumb/<width>/<filename> ─────────────────────────────────────
      // Resized JPEG of an /uploads/ image, cached on disk under
      // public/uploads/.thumbs/<width>-<basename>.jpg. Why this exists:
      // many assets are 4K PNGs (3840×2160, ~16MB on disk, ~33MB
      // decoded in memory + GPU texture). Showing a dozen of them
      // simultaneously on the canvas reliably crashed Chrome with OOM.
      // Commercial canvases (Figma, liblibtv, Miro) solve this by
      // serving downscaled previews through a thumb CDN — this
      // middleware is the local equivalent.
      //
      // Cache strategy:
      //   - First request generates the thumb with sharp + writes it
      //     to .thumbs/.
      //   - Subsequent requests stream the cached file directly.
      //   - Cache is invalidated when the source file's mtime is newer
      //     than the cache file's (regen on source change).
      //
      // Width is clamped to [32, 2048] so a stray ?w=99999 can't burn
      // gigs of RAM. JPEG quality 75 is the sweet spot for
      // photo-realistic content; ~5-8% of original PNG size.
      const THUMB_DIR = join(process.cwd(), 'public', 'uploads', '.thumbs')
      const UPLOADS_DIR = join(process.cwd(), 'public', 'uploads')
      const SAFE_FILENAME = /^[\w.-]+\.(png|jpg|jpeg|webp)$/i
      server.middlewares.use('/thumb', async (req, res) => {
        const started = Date.now()
        try {
          // req.url here is the path AFTER /thumb, e.g. "/512/abc-def.png"
          const m = /^\/(\d+)\/(.+)$/.exec(req.url ?? '')
          if (!m) {
            console.warn('[thumb] 400 bad path', req.url)
            res.statusCode = 400; res.end('bad path'); return
          }
          const width = Math.max(32, Math.min(2048, Number(m[1])))
          const filename = decodeURIComponent(m[2])
          if (!SAFE_FILENAME.test(filename)) {
            console.warn('[thumb] 400 bad filename', filename)
            res.statusCode = 400; res.end('bad filename'); return
          }

          const srcPath = join(UPLOADS_DIR, filename)
          if (!existsSync(srcPath)) {
            console.warn('[thumb] 404', filename)
            res.statusCode = 404; res.end('not found'); return
          }

          mkdirSync(THUMB_DIR, { recursive: true })
          const baseName = filename.replace(/\.[^.]+$/, '')
          const cachePath = join(THUMB_DIR, `${width}-${baseName}.jpg`)

          let serveCache = false
          if (existsSync(cachePath)) {
            const cacheStat = statSync(cachePath)
            const srcStat = statSync(srcPath)
            if (cacheStat.mtimeMs >= srcStat.mtimeMs) serveCache = true
          }

          if (!serveCache) {
            const srcStat = statSync(srcPath)
            await sharp(srcPath)
              .resize({ width, withoutEnlargement: true })
              .jpeg({ quality: 75, mozjpeg: true })
              .toFile(cachePath)
            const cacheStat = statSync(cachePath)
            console.log(`[thumb] GEN ${filename} → w=${width} ${(srcStat.size/1024).toFixed(0)}KB → ${(cacheStat.size/1024).toFixed(1)}KB in ${Date.now()-started}ms`)
          } else {
            const cacheStat = statSync(cachePath)
            console.log(`[thumb] HIT ${filename} w=${width} ${(cacheStat.size/1024).toFixed(1)}KB ${Date.now()-started}ms`)
          }

          res.setHeader('Content-Type', 'image/jpeg')
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          createReadStream(cachePath).pipe(res)
        } catch (e) {
          console.error(`[thumb] ERROR ${req.url}:`, (e as Error).message)
          res.statusCode = 500
          res.end(`thumb failed: ${(e as Error).message}`)
        }
      })

      // Export zip endpoint — downloads all URLs server-side, packages as zip, saves to public/uploads
      server.middlewares.use('/capabilities/export-zip', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const { items } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            items: { url: string; filename: string }[]
          }
          if (!items?.length) { sendJson(res, 400, { error: 'no items' }); return }

          const JSZip = (await import('jszip')).default
          const zip = new JSZip()

          for (const item of items) {
            try {
              let buf: Buffer
              if (item.url.startsWith('data:')) {
                const m = item.url.match(/^data:[^;]+;base64,(.+)$/)
                buf = m ? Buffer.from(m[1], 'base64') : Buffer.from('')
              } else if (item.url.startsWith('/')) {
                // Local file
                const { readFileSync } = await import('fs')
                buf = readFileSync(join(process.cwd(), 'public', item.url))
              } else {
                const r = await fetch(item.url)
                if (!r.ok) continue
                buf = Buffer.from(await r.arrayBuffer())
              }
              zip.file(item.filename, buf)
            } catch {
              // Skip failed downloads
            }
          }

          const zipBuf = await zip.generateAsync({ type: 'nodebuffer' })
          const uploadsDir = join(process.cwd(), 'public', 'uploads')
          mkdirSync(uploadsDir, { recursive: true })
          const zipName = `export-${randomUUID().slice(0, 8)}.zip`
          writeFileSync(join(uploadsDir, zipName), zipBuf)
          sendJson(res, 200, { url: `/uploads/${zipName}` })
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })

      // Proxy download endpoint — fetches external URLs server-side to bypass CORS
      server.middlewares.use('/capabilities/proxy-download', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const { url } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url: string }
          if (!url || !/^https?:\/\//i.test(url)) { sendJson(res, 400, { error: 'invalid URL' }); return }

          const upstream = await fetch(url)
          if (!upstream.ok) { sendJson(res, 502, { error: `upstream ${upstream.status}` }); return }

          const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
          res.statusCode = 200
          res.setHeader('Content-Type', contentType)
          const buf = Buffer.from(await upstream.arrayBuffer())
          res.end(buf)
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })
    },
  }
}
