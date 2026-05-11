import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'

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

// ─── Doubao (火山方舟) ─────────────────────────────────────────────────
async function runDoubaoImage(req: Req): Promise<{ url: string; kind: 'image' }> {
  const key = process.env.ARK_API_KEY
  if (!key) throw new Error('ARK_API_KEY not set')
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
  const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Doubao ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { data?: { url: string }[] }
  const url = data.data?.[0]?.url
  if (!url) throw new Error('Doubao: no image in response')
  return { url, kind: 'image' }
}

async function runDoubaoVideo(req: Req): Promise<{ url: string; kind: 'video' }> {
  const key = process.env.ARK_API_KEY
  if (!key) throw new Error('ARK_API_KEY not set')
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }

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
    model: req.model,
    content: contentParts,
    resolution: req.resolution ?? '480p',
    ratio: req.aspect ?? '16:9',
    duration: Math.max(4, Math.min(15, Math.round(req.duration ?? 5))),
    generate_audio: req.generateAudio ?? true,
  }
  if (req.seed != null && req.seed >= 0) body.seed = req.seed
  const createRes = await fetch('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!createRes.ok) throw new Error(`Doubao video create ${createRes.status}: ${await createRes.text()}`)
  const createData = (await createRes.json()) as { id?: string }
  const taskId = createData.id
  if (!taskId) throw new Error('Doubao: no task id')

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
      const r = await fetch(`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${taskId}`, { headers })
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
  const url = item?.url ?? (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : undefined)
  if (!url) throw new Error('OpenAI: no image')
  return { url, kind: 'image' }
}

// ─── TokenRouter (OpenAI-compatible) ─────────────────────────────────
const TOKENROUTER_BASE_URL = 'https://www.tokenrouter.com/backend-api/v1'
const TOKENROUTER_TEXT_MODEL = 'google/gemini-3-flash-preview'

const TR_IMAGE_SIZE: Record<string, string> = {
  '1:1': '1024x1024', '9:16': '1024x1792', '16:9': '1792x1024', '4:3': '1536x1152', '3:4': '1152x1536',
}

function tokenRouterBaseUrl(): string {
  return (process.env.TOKENROUTER_BASE_URL || TOKENROUTER_BASE_URL).replace(/\/$/, '')
}

async function tokenRouterChat(systemPrompt: string, userText: string, temperature?: number): Promise<string> {
  const key = process.env.TOKENROUTER_API_KEY
  if (!key) throw new Error('TOKENROUTER_API_KEY not set')
  const res = await fetch(`${tokenRouterBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.TOKENROUTER_TEXT_MODEL || TOKENROUTER_TEXT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      ...(temperature != null ? { temperature } : {}),
    }),
  })
  if (!res.ok) throw new Error(`TokenRouter chat ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('TokenRouter: empty response')
  return text
}

// ─── TokenRouter image (covers gemini provider + tokenrouter provider) ─────
async function runTokenRouterImage(req: Req, providerPrefix?: string): Promise<{ url: string; kind: 'image' }> {
  const key = process.env.TOKENROUTER_API_KEY
  if (!key) throw new Error('TOKENROUTER_API_KEY not set')
  // Accept either bare model id (e.g. "gpt-5.4-image-2") or full TokenRouter id ("openai/...", "google/...")
  const model = req.model.includes('/') ? req.model : `${providerPrefix ?? ''}${req.model}`
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    n: req.numImages ?? 1,
    size: TR_IMAGE_SIZE[req.aspect ?? '16:9'] ?? '1024x1024',
  }
  const refs = (req.refImages ?? []).slice(0, 3).filter((u) => /^https?:\/\//i.test(u) || u.startsWith('data:'))
  if (refs.length) body.image = refs
  let res = await fetch(`${tokenRouterBaseUrl()}/images/generations`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok && refs.length) {
    delete body.image
    res = await fetch(`${tokenRouterBaseUrl()}/images/generations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  if (!res.ok) throw new Error(`TokenRouter image ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }>; images?: Array<{ url?: string; b64_json?: string }> }
  const items = data.data || data.images || []
  const first = items[0]
  const url = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : undefined)
  if (!url) throw new Error('TokenRouter: no image in response')
  return { url, kind: 'image' }
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

  const text = await tokenRouterChat(sys, userMsg, 0.8)
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
  // TokenRouter / OpenAI input_audio supports: wav, mp3. Gemini-3 also accepts webm/ogg in practice.
  if (mime.includes('mp3') || mime.includes('mpeg')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

async function voiceRevise(req: IncomingMessage): Promise<VoiceRevisePlan> {
  const key = process.env.TOKENROUTER_API_KEY
  if (!key) throw new Error('TOKENROUTER_API_KEY not set')
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

  const res = await fetch(`${tokenRouterBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.TOKENROUTER_TEXT_MODEL || TOKENROUTER_TEXT_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: [
          { type: 'text', text: 'Here is my spoken feedback. Listen and produce the revision JSON.' },
          { type: 'input_audio', input_audio: { data: audioB64, format } },
        ] },
      ],
    }),
  })
  if (!res.ok) throw new Error(`TokenRouter voice-revise ${res.status}: ${await res.text()}`)
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

async function dispatch(req: Req): Promise<{ url: string; kind: 'image' | 'video' }> {
  if (!req.provider || !req.model) throw new Error('provider/model required')
  if (!req.prompt?.trim()) throw new Error('prompt required')
  switch (req.provider) {
    case 'fal':    return runFal(req)
    case 'doubao':
      return /seedance/i.test(req.model) ? runDoubaoVideo(req) : runDoubaoImage(req)
    case 'openai': return runOpenAI(req)
    case 'gemini': return runTokenRouterImage(req, 'google/')
    case 'tokenrouter': return runTokenRouterImage(req)
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
      server.middlewares.use('/providers/available', (_req, res) => {
        sendJson(res, 200, {
          libtv:  !!process.env.LIBTV_ACCESS_KEY,
          fal:    !!process.env.FAL_KEY,
          doubao: !!process.env.ARK_API_KEY,
          openai: !!process.env.OPENAI_API_KEY,
          gemini: !!process.env.TOKENROUTER_API_KEY,
          tokenrouter: !!process.env.TOKENROUTER_API_KEY,
        })
      })
    },
  }
}
