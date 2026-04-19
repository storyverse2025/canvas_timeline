import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

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

// ─── LLM helpers (Gemini text) ───────────────────────────────────────
async function geminiText(systemPrompt: string, userText: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.7 },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim()
  if (!text) throw new Error('Gemini: empty response')
  return text
}

async function geminiVision(systemPrompt: string, userText: string, imageUrl: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const parts: Record<string, unknown>[] = [{ text: userText }]
  if (imageUrl.startsWith('data:')) {
    const m = imageUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
  } else {
    parts.push({ fileData: { mimeType: 'image/jpeg', fileUri: imageUrl } })
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.5 },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() || ''
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

// ─── Image capabilities ─────────────────────────────────────────────
async function textToImage(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const refs = getImages(req.inputs)
  const aspect = (req.params?.aspect as string) || '16:9'
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const body: Record<string, unknown> = {
    prompt: text || 'a beautiful scene',
    image_size: aspect === '1:1' ? 'square_hd' : 'landscape_16_9',
    num_images: 1,
  }
  if (refs.length > 0) body.image_url = refs[0]
  const res = await fetch('https://fal.run/fal-ai/flux-pro/v1.1', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`FAL ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { images?: { url: string }[] }
  const url = data.images?.[0]?.url
  if (!url) throw new Error('FAL: no image')
  return { outputs: [{ kind: 'image', url }] }
}

async function smartEdit(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const images = getImages(req.inputs)
  if (!images.length) throw new Error('需要输入图片')
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY not set')
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: await buildEditFormData(images[0], text || 'enhance this image'),
  })
  if (!res.ok) {
    const fallbackPrompt = `${text || 'enhance'}, based on the reference image`
    return textToImage({ ...req, inputs: [{ kind: 'text', text: fallbackPrompt }, { kind: 'image', url: images[0] }] })
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
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const body: Record<string, unknown> = {
    prompt: text || 'fill the masked area naturally',
    image_url: images[0],
    num_images: 1,
  }
  if (maskUrl) body.mask_url = maskUrl
  const res = await fetch('https://fal.run/fal-ai/flux-pro/v1.1/inpainting', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`FAL inpaint ${res.status}: ${await res.text()}`)
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

/** Only absolute http(s) or data: URLs are valid for remote APIs. */
function filterValidRefs(urls: string[]): string[] {
  return urls.filter((u) => u && u.length > 10 && (/^https?:\/\//i.test(u) || u.startsWith('data:')))
}

async function textToVideo(req: CapReq): Promise<CapRes> {
  const text = getText(req.inputs)
  const refs = filterValidRefs(getImages(req.inputs))
  if (!text && !refs.length) throw new Error('需要输入文本或参考图')
  const duration = Number(req.params?.duration ?? 5)
  const aspect = (req.params?.aspect as string) || '16:9'
  const resolution = (req.params?.resolution as string) || '480p'
  const key = process.env.ARK_API_KEY
  if (!key) throw new Error('ARK_API_KEY not set')
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
  const contentParts: Array<Record<string, unknown>> = [
    { type: 'text', text: text || 'cinematic video' },
  ]
  // Seedance 2.0: multi-image reference (up to 9) with role: "reference_image"
  // Single image with role: "first_frame" for first-frame mode
  if (refs.length === 1) {
    contentParts.push({ type: 'image_url', image_url: { url: refs[0] }, role: 'first_frame' })
  } else if (refs.length > 1) {
    for (const u of refs.slice(0, 9)) {
      contentParts.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' })
    }
  }
  // Use new request body parameters (not --flags in prompt)
  const body: Record<string, unknown> = {
    model: 'doubao-seedance-2-0-fast-260128',
    content: contentParts,
    resolution,
    ratio: aspect,
    duration: Math.max(4, Math.min(15, duration)),
    generate_audio: false,
  }
  const createRes = await fetch('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', {
    method: 'POST', headers,
    body: JSON.stringify(body),
  })
  if (!createRes.ok) throw new Error(`Doubao create ${createRes.status}: ${await createRes.text()}`)
  const taskId = ((await createRes.json()) as { id?: string }).id
  if (!taskId) throw new Error('Doubao: no task id')
  const url = await poll<string>(async () => {
    const r = await fetch(`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${taskId}`, { headers })
    if (!r.ok) return { done: false, error: `status ${r.status}` }
    const d = (await r.json()) as Record<string, unknown>
    const status = d.status as string | undefined
    const video = (d.content as { video_url?: string } | undefined)?.video_url
      ?? ((d.output as Record<string, unknown> | undefined)?.video as { url?: string } | undefined)?.url
    if (status === 'succeeded' && video) return { done: true, result: video }
    if (status === 'failed' || status === 'cancelled') return { done: false, error: `task ${status}` }
    return { done: false }
  }, { intervalMs: 4000, timeoutMs: 6 * 60 * 1000 })
  return { outputs: [{ kind: 'video', url }] }
}

async function firstLastFrame(req: CapReq): Promise<CapRes> {
  const images = getImages(req.inputs)
  if (images.length < 1) throw new Error('需要至少 1 张图片作为首帧')
  const text = getText(req.inputs) || 'smooth transition between frames'
  return textToVideo({
    capability: 'text-to-video',
    inputs: [
      { kind: 'text', text },
      ...images.map((url) => ({ kind: 'image' as const, url })),
    ],
    params: req.params,
  })
}

async function multiRefVideo(req: CapReq): Promise<CapRes> {
  const images = getImages(req.inputs)
  const text = getText(req.inputs)
  if (images.length < 1) throw new Error('需要至少 1 张参考图')
  return textToVideo({
    capability: 'text-to-video',
    inputs: [
      { kind: 'text', text: text || 'create a video combining these reference images' },
      ...images.map((url) => ({ kind: 'image' as const, url })),
    ],
    params: req.params,
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
  if (!videos.length) throw new Error('需要输入参考视频')
  if (!images.length) throw new Error('需要输入目标人物图')
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY not set')
  const res = await fetch('https://fal.run/fal-ai/animate-anyone', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference_image_url: images[0], motion_video_url: videos[0] }),
  })
  if (!res.ok) throw new Error(`FAL motion ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { video?: { url: string } }
  const url = data.video?.url
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
  'text-to-image': textToImage,
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

      // File upload endpoint — saves to public/uploads/, returns URL path
      server.middlewares.use('/uploads/save', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
        try {
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = Buffer.concat(chunks)

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
          sendJson(res, 200, { url })
        } catch (e) {
          sendJson(res, 500, { error: String((e as Error).message ?? e) })
        }
      })
    },
  }
}
