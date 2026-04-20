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
  enhancePrompt?: boolean;
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

// ─── Gemini image ─────────────────────────────────────────────────────
async function runGemini(req: Req): Promise<{ url: string; kind: 'image' }> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] }[] }[] }
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)
  const inline = part?.inlineData
  if (!inline) throw new Error('Gemini: no image in response')
  return { url: `data:${inline.mimeType};base64,${inline.data}`, kind: 'image' }
}

// ─── Prompt optimizer (Gemini text) ───────────────────────────────────
interface OptimizeReq {
  prompt: string;
  kind: 'image' | 'video';
  aspect?: string;
  duration?: number;
}

async function optimizePrompt(req: OptimizeReq): Promise<{ prompt: string }> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const durLine = req.kind === 'video' && req.duration ? `- Total duration: ~${req.duration}s` : ''
  const ratioLine = req.aspect ? `- Aspect ratio: ${req.aspect}` : ''
  const sys = req.kind === 'video'
    ? `You are a cinematography director. Rewrite the user's brief into a rich video generation prompt.
Break the ${req.duration ?? 5}-second clip into 1-3 shots. For each shot include:
- Shot type (close-up / medium / wide / establishing)
- Camera movement (dolly / pan / tilt / zoom / static / handheld)
- Composition (rule of thirds / centered / leading lines)
- Lighting & mood (golden hour / soft overhead / dramatic rim light etc.)
- Duration in seconds (sum must equal total)

Return ONE cohesive prompt paragraph (no JSON, no numbered list, no markdown) in English, ending with --ratio ${req.aspect ?? '16:9'}. Keep it under 180 words.`
    : `You are an image art director. Rewrite the user's brief into a rich still image prompt with:
- Subject & action
- Composition and framing (${req.aspect ?? '16:9'})
- Lens choice (e.g. 35mm, 85mm, wide angle)
- Lighting (direction, quality, color temperature)
- Mood & style references

Return ONE cohesive prompt paragraph in English, no markdown, under 120 words.`

  const userMsg = [
    `Brief: ${req.prompt}`,
    ratioLine,
    durLine,
  ].filter(Boolean).join('\n')

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: userMsg }] }],
      generationConfig: { temperature: 0.8 },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
  if (!text) throw new Error('Gemini: empty response')
  return { prompt: text }
}

async function dispatch(req: Req): Promise<{ url: string; kind: 'image' | 'video' }> {
  if (!req.provider || !req.model) throw new Error('provider/model required')
  if (!req.prompt?.trim()) throw new Error('prompt required')
  switch (req.provider) {
    case 'fal':    return runFal(req)
    case 'doubao':
      return /seedance/i.test(req.model) ? runDoubaoVideo(req) : runDoubaoImage(req)
    case 'openai': return runOpenAI(req)
    case 'gemini': return runGemini(req)
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
      server.middlewares.use('/providers/available', (_req, res) => {
        sendJson(res, 200, {
          libtv:  !!process.env.LIBTV_ACCESS_KEY,
          fal:    !!process.env.FAL_KEY,
          doubao: !!process.env.ARK_API_KEY,
          openai: !!process.env.OPENAI_API_KEY,
          gemini: !!(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY),
        })
      })
    },
  }
}
