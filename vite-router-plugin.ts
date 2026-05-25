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

// ─── Capability dispatch ──────────────────────────────────────────────

const SYNC_IMAGE_CAPABILITIES = new Set(['text-to-image', 'image-edit'])
const ASYNC_VIDEO_CAPABILITIES = new Set(['text-to-video', 'image-to-video', 'video-edit'])

function pickProvider(req: RunRequest): string {
  if (req.provider) return req.provider
  const model = req.model ?? ''
  if (/^(dreamina-|doubao-)?seedream/.test(model)) return 'bytedance'
  if (/^(dreamina-|doubao-)?seedance/.test(model)) return 'bytedance'
  if (SYNC_IMAGE_CAPABILITIES.has(req.capability)) return 'bytedance' // V1a default
  if (ASYNC_VIDEO_CAPABILITIES.has(req.capability)) return 'bytedance'
  throw new Error(`router: no default provider for capability=${req.capability}`)
}

function pickModel(req: RunRequest, provider: string): string {
  if (req.model) return req.model
  if (provider === 'bytedance') {
    if (SYNC_IMAGE_CAPABILITIES.has(req.capability)) return process.env.SEEDREAM_MODEL || 'seedream-5-0-260128'
    if (ASYNC_VIDEO_CAPABILITIES.has(req.capability)) return defaultSeedanceModel()
  }
  throw new Error(`router: no default model for provider=${provider} capability=${req.capability}`)
}

async function dispatchSync(req: RunRequest, provider: string, model: string, keyOverride: string | null): Promise<RouterOutput[]> {
  if (provider === 'bytedance' && SYNC_IMAGE_CAPABILITIES.has(req.capability)) {
    const inputs = req.inputs ?? []
    const refs = inputs.filter((i) => i.kind === 'image' && i.url).map((i) => i.url!)
    const params = req.params ?? {}
    return runSeedream({
      model,
      prompt: req.prompt ?? '',
      refs,
      aspectRatio: (params.aspectRatio as string) || (params.aspect_ratio as string) || '1:1',
      resolution: (params.resolution as string) || '2K',
      keyOverride,
    })
  }
  throw new Error(`router: no sync handler for provider=${provider} capability=${req.capability}`)
}

async function dispatchAsync(req: RunRequest, provider: string, model: string, routerTaskId: string, keyOverride: string | null): Promise<void> {
  if (provider === 'bytedance' && ASYNC_VIDEO_CAPABILITIES.has(req.capability)) {
    const inputs = req.inputs ?? []
    const params = req.params ?? {}
    const mode = (params.genMode as string) || undefined
    const content = buildSeedanceContent(req.prompt ?? '', inputs, mode)
    const providerTaskId = await submitSeedanceTask({
      model,
      contentParts: content,
      duration: Number.parseInt((params.duration as string) ?? '5', 10) || 5,
      ratio: (params.ratio as string) || '16:9',
      resolution: (params.resolution as string) || '720p',
      generateAudio: (params.generate_audio as string) !== 'false',
      keyOverride,
    })
    const now = Date.now()
    const state = tasks.get(routerTaskId)
    if (state) {
      tasks.set(routerTaskId, { ...state, providerTaskId, updatedAt: now })
    }
    startSeedancePollLoop(routerTaskId, providerTaskId, keyOverride)
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

const V1A_MODELS: ModelEntry[] = [
  {
    id: 'seedream-5.0',
    apiModelId: 'seedream-5-0-260128',
    label: 'Seedream 5.0',
    type: 'image',
    provider: 'bytedance',
    capabilities: ['text-to-image', 'image-edit'],
    params: [
      { id: 'aspectRatio', label: 'Aspect ratio', type: 'select',
        options: [
          { label: '1:1', value: '1:1' }, { label: '4:3', value: '4:3' }, { label: '3:4', value: '3:4' },
          { label: '16:9', value: '16:9' }, { label: '9:16', value: '9:16' }, { label: '3:2', value: '3:2' },
          { label: '2:3', value: '2:3' }, { label: '21:9', value: '21:9' },
        ], default: '1:1' },
      { id: 'resolution', label: 'Resolution', type: 'select',
        options: [{ label: '1K', value: '1K' }, { label: '2K', value: '2K' }, { label: '3K', value: '3K' }, { label: '4K', value: '4K' }],
        default: '2K' },
    ],
  },
  {
    id: 'seedance-2.0-fast',
    apiModelId: 'dreamina-seedance-2-0-fast-260128',
    label: 'Seedance 2.0 Fast',
    type: 'video',
    provider: 'bytedance',
    capabilities: ['text-to-video', 'image-to-video'],
    params: [
      { id: 'duration', label: 'Duration', type: 'select',
        options: [4, 5, 6, 7, 8, 9, 10, 11, 12].map((d) => ({ label: `${d}s`, value: String(d) })),
        default: '5' },
      { id: 'ratio', label: 'Ratio', type: 'select',
        options: ['16:9', '9:16', '1:1'].map((r) => ({ label: r, value: r })),
        default: '16:9' },
      { id: 'resolution', label: 'Resolution', type: 'select',
        options: [{ label: '480p', value: '480p' }, { label: '720p', value: '720p' }],
        default: '720p' },
      { id: 'generate_audio', label: 'Audio', type: 'select',
        options: [{ label: 'On', value: 'true' }, { label: 'Off', value: 'false' }],
        default: 'true' },
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

  if (body.provider === 'bytedance' || body.provider === 'byteplus') {
    try {
      const r = await fetch(`${arkBaseUrl()}/models`, { headers: { 'Authorization': `Bearer ${key}` } })
      if (r.status === 200) return sendJson(res, 200, { ok: true, message: 'Connected.' })
      if (r.status === 401 || r.status === 403) return sendJson(res, 200, { ok: false, message: 'Invalid API key.' })
      return sendJson(res, 200, { ok: false, message: `Unexpected status ${r.status}.` })
    } catch (e) {
      return sendJson(res, 200, { ok: false, message: `Network error: ${(e as Error).message}` })
    }
  }
  return sendJson(res, 200, { ok: false, message: `Provider ${body.provider} not supported in V1a.` })
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
