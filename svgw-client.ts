/**
 * StoryVerse 网关（svnewapi / SVRouter）客户端 —— 视频算力统一入口。
 *
 * 为什么存在：直连 BytePlus Ark 只能用本账号绑定的那一个 endpoint
 * (`ep-…p2zm9` = seedance 2.0 **fast**)，通用 model id 一律 AccessDenied，
 * 而 AK/SK 又没有 ark:CreateEndpoint 权限 —— 也就是说 2.5 在直连这条路上
 * 根本拿不到。网关上 `sv-seedance-2.5` / `sv-seedance-2.0` 都是现成的。
 *
 * 契约来源：`/data/repos/sv-v2h/v2h/clients/vendor/svgw.py`（实跑验证过的
 * 权威实现）+ `/data/repos/sv-v2h/skill/references/pitfalls.md`。这里是它的
 * TypeScript 移植，刻意保留了那边踩出来的几条硬约束：
 *
 *  1. 素材只收**公网 URL** 或 `asset://<id>`，不吃 base64。
 *  2. 含真人的图/视频必须先 `POST /v1/assets` 注册（网关服务端带
 *     `Moderation.Strategy=Skip`，这就是「开白」的实际机制），否则 Ark 当场
 *     回 `InputVideoSensitiveContentDetected.PrivacyInformation`。
 *  3. 任务 id 在**顶层**，不在 `data` 下；两种信封都要兼容，否则任务照跑照
 *     计费但拿不到结果。
 *  4. 网关会 403 掉没有浏览器 UA 的裸客户端。
 *  5. `ratio` 在 first-frame / first-last-frame / video-extend / video-edit
 *     下被强制成 adaptive，要指定 16:9 只能用 video-ref / image-ref /
 *     text-to-video。2026-09-19 实测补充：video-edit 传具体画幅会被
 *     `build_request_failed: requires adaptive ratio` 拒（提交前拒，不计费），
 *     而且它**还要求 duration 必须是 Auto(-1)** —— 这条 svgw.py 没写。
 *  6. 不带 `sv-` 前缀的裸 id 不是 SV 契约模型，别用。
 */

/** 浏览器 UA —— 网关 403 掉裸客户端（Node fetch 默认 UA 就是裸的）。 */
const SVGW_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

/** `data.quota / 500000 = USD` —— 网关的计费单位。 */
export const QUOTA_PER_USD = 500_000

const TERMINAL_OK = new Set(['success', 'succeeded', 'completed'])
const TERMINAL_BAD = new Set(['failure', 'failed', 'error', 'cancelled', 'canceled'])

export type SvgwMode =
  | 'text-to-video'
  | 'first-frame'
  | 'first-last-frame'
  | 'image-ref'
  | 'video-ref'
  | 'video-extend'
  | 'video-edit'

/**
 * svgw.py 的 docstring 说 video-ref / video-extend / video-edit「后三个 2.5 才有」，
 * 但这条对 **video-ref 不成立**：2026-09-19 实测 `sv-seedance-2.0` + video-ref 一路
 * 到了 Ark，只在 duration 上被拒，错误原文写着 `for model dreamina-seedance-2-0
 * in r2v` —— 参考视频被当成 r2v 收下了。v2h 的转横屏流水线也一直用 2.0 跑 video-ref。
 * 所以这里只留下没有实测证据的那两个，而且**只警告不拦**：网关才是权威，
 * 我们不该凭一句注释把用户的活儿挡下来，更不该偷偷升到贵一倍的档位。
 */
const MODES_LIKELY_2_5_ONLY = new Set<SvgwMode>(['video-extend', 'video-edit'])

/** 这些模式下网关强制 ratio=adaptive，传 16:9 也不生效。 */
const MODES_IGNORING_RATIO = new Set<SvgwMode>(['first-frame', 'first-last-frame', 'video-extend', 'video-edit'])

export function svgwBaseUrl(): string {
  const raw = process.env.SVGW_BASE_URL || process.env.SVNEWAPI_GATEWAY || 'https://gateway.storyverseai.art'
  return raw.replace(/\/+$/, '')
}

export function svgwApiKey(): string | undefined {
  return process.env.SVGW_API_KEY || process.env.SVNEWAPI_KEY
}

export function svgwConfigured(): boolean {
  return Boolean(svgwApiKey())
}

interface SvgwResponse {
  status: number
  body: unknown
}

/**
 * 一次网关调用。GET 传 body=undefined。
 *
 * 网关偶发空响应 / 非 JSON，这里自己重试，而不是让调用方的轮询循环炸掉
 * （pitfalls 里那条：任务照跑照计费，客户端却先崩了）。4xx/5xx 的 JSON 是
 * 有效信息（错误码在里面），直接返回给调用方判断。
 */
export async function svgwRequest(
  path: string,
  body?: Record<string, unknown>,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<SvgwResponse> {
  const key = svgwApiKey()
  if (!key) throw new Error('SVGW_API_KEY 未配置（StoryVerse 网关密钥）')
  const timeoutMs = opts.timeoutMs ?? 300_000
  const retries = opts.retries ?? 3
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'User-Agent': SVGW_UA,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let last = 'no attempt'
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${svgwBaseUrl()}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const raw = await res.text()
      try {
        return { status: res.status, body: JSON.parse(raw) }
      } catch {
        // HTTP 状态有了但内容不是 JSON：4xx/5xx 就照原样报错，2xx 当成空响应重试。
        if (!res.ok) return { status: res.status, body: raw.slice(0, 500) }
        last = `HTTP ${res.status} 非 JSON 响应: ${raw.slice(0, 200)}`
      }
    } catch (e) {
      last = `${(e as Error).name}: ${(e as Error).message}`
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
  }
  throw new Error(`网关请求 ${path} 失败：${last}`)
}

/** 任务 id / 状态在顶层还是 data 下都可能，两种信封归一化。 */
function unwrap(body: unknown): Record<string, unknown> {
  const rec = (body ?? {}) as Record<string, unknown>
  const inner = rec.data
  return inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : rec
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

export interface SvgwVideoRequest {
  model: string
  prompt: string
  mode?: SvgwMode
  images?: string[]
  videos?: string[]
  audios?: string[]
  ratio?: string
  duration?: number
  resolution?: string
  seed?: number
  generateAudio?: boolean
  watermark?: boolean
}

/** 把一次出片请求翻成网关 `/v1/videos` 的 body。纯函数，便于单测。 */
export function buildVideoBody(req: SvgwVideoRequest): Record<string, unknown> {
  const md: Record<string, unknown> = {
    watermark: req.watermark ?? false,
    generate_audio: req.generateAudio ?? false,
  }
  if (req.mode) md.genMode = req.mode
  if (req.ratio) md.ratio = req.ratio
  if (req.duration != null) md.duration = req.duration
  if (req.resolution) md.resolution = req.resolution
  if (req.seed != null && req.seed >= 0) md.seed = req.seed

  const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, metadata: md }
  if (req.mode) body.mode = req.mode
  if (req.images?.length) body.images = [...req.images]
  if (req.videos?.length) body.videos = [...req.videos]
  if (req.audios?.length) body.audios = [...req.audios]
  return body
}

/**
 * 按素材推断 genMode。参考视频 → video-ref（我们的白模重拍就是这条），
 * 首帧/首尾帧只在明确指定 role 时才用 —— 它们会让 ratio 失效。
 */
export function svgwModeFor(inputs: {
  images: number
  videos: number
  audios: number
  imageRole?: 'first' | 'first-last' | 'reference'
}): SvgwMode {
  if (inputs.videos > 0) return 'video-ref'
  if (inputs.images === 0) return 'text-to-video'
  if (inputs.imageRole === 'first') return 'first-frame'
  if (inputs.imageRole === 'first-last') return 'first-last-frame'
  return 'image-ref'
}

/**
 * 画布里的 model id → 网关契约 model id。
 *
 * 画布历史上发的是 Ark 的通用 id（`dreamina-seedance-2-0-fast-260128`）甚至
 * endpoint id（`ep-…`）。网关不认这些，只认 `sv-` 前缀的契约模型。
 * fast 在网关上没有对应档位 —— 归到 2.0，调用方会把这件事打进日志。
 */
export function gatewayModelFor(model: string | undefined): string {
  const m = (model ?? '').trim()
  if (m.startsWith('sv-')) return m
  if (/seedance[-_ ]?2[-_.]5/i.test(m)) return 'sv-seedance-2.5'
  if (/seedance[-_ ]?2[-_.]0/i.test(m)) return 'sv-seedance-2.0'
  if (/veo[-_ ]?3/i.test(m)) return 'sv-veo-3.1'
  if (/kling/i.test(m)) return 'sv-kling-3.0'
  if (/sora/i.test(m)) return 'sv-sora-2'
  // ep-… / 空 / 认不出来的：用默认档，日志里会写清楚换成了什么。
  return process.env.SVGW_VIDEO_MODEL || 'sv-seedance-2.0'
}

export function isGateway25(model: string): boolean {
  return /2\.5/.test(model)
}

/** 提交出片任务 → task id。 */
export async function svgwSubmitVideo(req: SvgwVideoRequest): Promise<string> {
  if (req.mode && MODES_LIKELY_2_5_ONLY.has(req.mode) && !isGateway25(req.model)) {
    console.warn(`[svgw] ${req.model} 可能不支持 ${req.mode}（没有实测过）；网关拒了就换 sv-seedance-2.5`)
  }
  if (req.ratio && req.mode && MODES_IGNORING_RATIO.has(req.mode)) {
    console.warn(`[svgw] ${req.mode} 模式下网关强制 ratio=adaptive，传的 ${req.ratio} 不生效`)
  }
  const { status, body } = await svgwRequest('/v1/videos', buildVideoBody(req))
  const d = unwrap(body)
  const id = str(d.id) || str(d.task_id)
  if (!id) throw new Error(`网关提交失败 HTTP ${status}: ${JSON.stringify(body).slice(0, 500)}`)
  return id
}

export interface SvgwResult {
  status: string
  url: string
  quota: number
  failure?: string
  done: boolean
  failed: boolean
}

/** 查一次任务态，把两种信封归一化。 */
export async function svgwFetchVideo(taskId: string): Promise<SvgwResult> {
  const { body } = await svgwRequest(`/v1/videos/${encodeURIComponent(taskId)}`, undefined, { timeoutMs: 90_000 })
  const d = unwrap(body)
  const md = (d.metadata && typeof d.metadata === 'object' ? d.metadata : {}) as Record<string, unknown>
  const url = [md.url, md.result_url, d.url, d.video_url, d.result_url].map(str).find(Boolean) ?? ''
  const status = str(d.status)
  const lower = status.toLowerCase()
  const failure = [d.fail_reason, d.reason, (d.error as Record<string, unknown> | undefined)?.message, md.fail_reason]
    .map(str)
    .find(Boolean)
  return {
    status,
    url,
    quota: Number(d.quota ?? 0) || 0,
    failure,
    done: Boolean(url) || TERMINAL_OK.has(lower),
    failed: TERMINAL_BAD.has(lower),
  }
}

/**
 * 把公网素材注册进 BytePlus 资产库 → asset id（`asset://<id>` 用于
 * images[] / videos[]）。含真人的素材必须走这条路，见文件头第 2 条。
 */
export async function svgwRegisterAsset(
  url: string,
  assetType: 'Image' | 'Video',
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
  const model = opts.model ?? 'sv-seedance-2.0'
  const { status, body } = await svgwRequest('/v1/assets', { model, url, asset_type: assetType })
  const d = unwrap(body)
  const id = str(d.id) || str(d.asset_id)
  if (!id) throw new Error(`素材注册失败 HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`)

  const deadline = Date.now() + (opts.timeoutMs ?? 600_000)
  while (Date.now() < deadline) {
    const { body: q } = await svgwRequest('/v1/assets/status', { model, id }, { timeoutMs: 90_000 })
    const s = str(unwrap(q).status).toLowerCase()
    if (s === 'active') return id
    if (s === 'failed' || s === 'error') throw new Error(`素材注册失败: ${JSON.stringify(q).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 8000))
  }
  throw new Error(`素材 ${id} 未在超时内变 Active`)
}

/** 网关上可用的模型列表（只关心 sv- 契约模型时传 svOnly）。 */
export async function svgwModels(svOnly = false): Promise<string[]> {
  const { body } = await svgwRequest('/v1/models', undefined, { timeoutMs: 30_000 })
  const data = ((body ?? {}) as { data?: Array<{ id?: string }> }).data ?? []
  const ids = data.map((m) => str(m.id)).filter(Boolean).sort()
  return svOnly ? ids.filter((i) => i.startsWith('sv-')) : ids
}
