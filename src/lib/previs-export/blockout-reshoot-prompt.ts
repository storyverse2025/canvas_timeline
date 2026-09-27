/**
 * 「按白模重拍」: prompt block + beat ↔ canvas-video mapping. Pure — no stores.
 *
 * A finished 3D 预演 renders one blockout clip per beat (grey set, one
 * solid-colour mannequin per character). Reshooting a source beat video sends
 * that clip to Seedance 2.0 as `reference_video` (@视频1) next to the video's
 * original reference images, and prepends the block built here to its prompt.
 *
 * Prompt design (why it reads the way it does):
 * - Seedance copies whatever a reference video shows unless told otherwise, so
 *   the block says up front which properties to take (camera, cuts, blocking,
 *   action timing) and which to ignore (mannequin look, grey untextured set,
 *   lighting) — and explicitly bans mannequins in the output.
 * - Colour is only an identity key. Each character is named with its colour and,
 *   when known, the @图片N that carries its face/costume; otherwise the model
 *   tends to dress the character in the mannequin colour.
 * - The staging segments are exactly what the blockout was compiled from, so a
 *   time-coded shot list (Seedance follows `[0-2.5s]` cues) tells the model where
 *   the hard cuts are and what each shot is — a video alone doesn't say which
 *   frame change is a cut and which is camera motion.
 * - The blockout only animates walking / sitting / standing; expressions,
 *   gestures and lip-sync still come from the original description, and the
 *   video wins where the description disagrees on camera or position.
 */

/** One beat of a finished previs run, as returned by GET /previs/beats. */
export interface PrevisBeatClip {
  /** 每个镜头一张白模帧 PNG（/uploads/…），按 staging 的硬切边界取。
   *  图生图定帧拿它们当构图基准 —— 每个镜头的机位和景别都不同，一张锚不住整段。 */
  frameUrls?: string[]
  /** 与 frameUrls 一一对应的镜头信息：景别锁住定帧的景别，主体/对手决定喂谁的角色图。 */
  frameShots?: {
    /** 这一帧在 beat 里的秒数。 */
    at?: number
    shotSize: string | null
    subject: string | null
    partner: string | null
    /** 这一帧真正出场的人物 key —— 服务端从画面数假人颜色得来。
     *  staging 的 subject/partner 和渲出来的画面对不上（beat 3 实测），以这个为准。 */
    present?: string[]
  }[]
  beat: number
  /** manifest beat shotId: storyboard row id, else the canvas video item id. */
  shotId: string
  start: number
  duration: number
  /** Public URL Seedance can fetch (studio host, plain HTTP). */
  clipUrl: string
  /** Same clip under the canvas's /uploads/, for playing it on the canvas. */
  localUrl?: string
  /** 这一镜要演什么，一句中文（staging 的 beat.goal，去掉「Beat N.」前缀）。 */
  goal?: string | null
  characters: {
    key: string
    name: string
    color: string
    /** 白模里这个人做的动作（中文名，如「失败者」），以及它发生的时间窗。 */
    motion?: string | null
    motionWindow?: [number, number] | null
    moveWindow?: [number, number] | null
    /** 起止站位不同 = 这一镜里他确实走动了。 */
    moved?: boolean
    actions?: string[]
  }[]
  segments: {
    t0: number
    t1: number
    shotSize: string | null
    cameraMotion: string | null
    cameraPreset: string | null
    subject: string | null
    /** 这一段的对手戏人物（过肩时的前景肩）。和 subject 一起决定这一段谁在画面里。 */
    partner?: string | null
  }[]
}

const START = '【白模参考 @白模1】'
/** 旧块用的是 @视频1。重拍会读回上一版 prompt，认不出旧块就会叠加两个块。 */
const LEGACY_START = '【白模参考 @视频1】'
const END = '【镜头描述】'


/** Labels of the studio's CAMERA_MOTION_PRESETS (storyai-director-studio). */


/** Exact names for the studio's draft PALETTE, hue buckets for anything else. */
const PALETTE_NAMES: Record<string, string> = {
  '#4f8cff': '蓝色',
  '#ff6b6b': '红色',
  '#ffd166': '黄色',
  '#06d6a0': '绿色',
  '#c77dff': '紫色',
  '#f4a261': '橙色',
  '#8ecae6': '浅蓝色',
  '#ffafcc': '粉色',
}

export function colorName(hex: string): string {
  const h = hex.trim().toLowerCase()
  if (PALETTE_NAMES[h]) return PALETTE_NAMES[h]
  const m = /^#?([0-9a-f]{6})$/.exec(h)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max - min < 0.12) return l > 0.8 ? '白色' : l < 0.2 ? '黑色' : '灰色'
  let hue: number
  if (max === r) hue = ((g - b) / (max - min) + 6) % 6
  else if (max === g) hue = (b - r) / (max - min) + 2
  else hue = (r - g) / (max - min) + 4
  hue *= 60
  const light = l > 0.72
  if (hue < 15 || hue >= 330) return light ? '粉色' : '红色'
  if (hue < 45) return '橙色'
  if (hue < 70) return '黄色'
  if (hue < 165) return '绿色'
  if (hue < 200) return '青色'
  if (hue < 255) return light ? '浅蓝色' : '蓝色'
  if (hue < 290) return '紫色'
  return '粉色'
}

const fmt = (t: number) => String(Math.round(t * 10) / 10)

/** Drop a block added by an earlier reshoot so reshooting again doesn't stack them. */
export function stripBlockoutBlock(prompt: string): string {
  const text = prompt.trimStart()
  if (!text.startsWith(START) && !text.startsWith(LEGACY_START)) return prompt
  const end = text.indexOf(END)
  return end < 0 ? prompt : text.slice(end + END.length).replace(/^\s*\n/, '').trim()
}

export interface BuildBlockoutPromptInput {
  basePrompt: string
  beat: PrevisBeatClip
  /** character key → 1-based @图片 index of that character's 角色图. */
  imageIndexOf?: Record<string, number | undefined>
  /** 1-based @图片 index of the keyframe the look must match. */
  styleImageIndex?: number
  /** Legend lines for reference images the base prompt doesn't already explain. */
  imageLegend?: string[]
  /** 把白模里的动作/beat 目标翻成中文写进 prompt。默认 false：动作应该由
   *  @视频1 自己传达，写成文字等于让白模失去意义。留作兜底。 */
  includeActionText?: boolean
}

/** 把一个 beat 里每个人物的表演数据翻成中文行（时间窗 + 动作 + 走位）。 */
function describeActions(beat: PrevisBeatClip): string[] {
  const out: string[] = []
  for (const c of beat.characters) {
    const bits: string[] = []
    if (c.motion) bits.push(c.motion)
    if (c.moved) bits.push('在场内走位换位置')
    for (const a of c.actions ?? []) bits.push(a)
    if (!bits.length) continue
    const w = c.motionWindow ?? c.moveWindow
    const when = w ? `${fmt(w[0])}-${fmt(w[1])}s：` : ''
    out.push(`- ${colorName(c.color)}假人（${c.name}）${when}${bits.join('，')}`)
  }
  return out
}

/**
 * 定帧模式的出片 prompt —— **一个常量**，不随场景、人物、镜头语言变化。
 *
 * 这是整套方案的收口：运镜/景别/切点/走位/朝向由 @白模1 给，人物/场景/光线/画风由
 * @图片1（按白模构图重绘的实拍定帧）给，文字只剩"照做、别改"。2026-09 实测这段话
 * 配好定帧能跟住白模；而它一旦缺少"假人就是图里那些人物"这句对应关系，模型就会把
 * 假人形状原样保留（P3 实测）。所以这句不能省。
 */
export const STYLED_STILL_PROMPT = [
  START,
  '后面几张参考图是按 @白模1 里不同时刻的构图预先渲染好的实拍定帧，按时间先后排列：人物的长相、服装、场景、光线和画风都以它们为准。',
  '把 @白模1 渲染成和这些定帧同一个世界的实拍画面 —— 白模里的纯色假人就是定帧里的那些人物。',
  '除了外观，其余一切都和 @白模1 完全一致：机位、构图、景别、人物位置、朝向、移动方向和时间点都不要改；定帧只提供外观，画面怎么走一律看 @白模1。',
  '画面里的人数、谁在画面里、各自的位置，任何时刻都跟 @白模1 一致：@白模1 某一段里只有一个人，成片这一段就只能有这一个人，不要把别人加回画面。',
  '景别也要逐秒对齐：人物在画面里占多大、镜头离他多远，都照 @白模1 同一时刻来，白模里是半身就不要拍成全身，是全身就不要推成特写。',
  '成片是正常拍摄的画面：不能出现假人、灰色白模或未贴图的几何体。',
  END,
].join('\n')

/** 图生图那一步用的假人↔角色图对应关系。只进定帧生成，不进出片 prompt。 */
export function buildStillMapping(beat: PrevisBeatClip, indexOf: Record<string, number | undefined>): string {
  const parts = beat.characters
    .map((c) => {
      const idx = indexOf[c.key]
      return idx ? `${colorName(c.color)}假人对应第 ${idx + 1} 张图的人物` : null
    })
    .filter(Boolean)
  return parts.length ? `${parts.join('，')}。` : ''
}

/**
 * 把镜头描述里「白模根本没拍到」的部分删掉。
 *
 * 2026-09-27 实测：beat 8 的描述里有「鬼面客踉跄后退…转身走开」，但白模在他那个动作
 * 发生的时段（6–9.2s）拍的是沈渊单人近景，鬼面客根本不在画面里。文字留着这句，模型
 * 要么把他硬塞回画面，要么为了演全动作把景别拉宽 —— 两种都在和白模打架。
 *
 * 判据用数据，不靠语义：某人物的动作时间窗和他在白模里实际出镜的时间没有重叠，
 * 只讲他的那一句就删掉。不点名任何人的句子（环境、氛围）一律保留。
 */
export function filterShotDescription(
  text: string,
  characters: { name: string; motionWindow?: [number, number] | null }[],
  onScreen: Map<string, [number, number][]>,
): string {
  const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1]
  const offScreen = new Set(
    characters
      .filter((c) => {
        const win = c.motionWindow
        if (!win) return false
        const spans = onScreen.get(c.name) ?? []
        return spans.length > 0 && !spans.some((span) => overlaps(win, span))
      })
      .map((c) => c.name),
  )
  if (offScreen.size === 0) return text.trim()

  return text
    .split(/(?<=[；。;])/)
    .map((clause) => {
      const named = characters.filter((c) => clause.includes(c.name)).map((c) => c.name)
      // 只讲被判定为「白模没拍到」的人物的句子才删；提到在场人物的句子保留。
      return named.length > 0 && named.every((n) => offScreen.has(n)) ? '' : clause
    })
    .join('')
    .replace(/^[；。;，,\s]+/, '')
    .trim()
}

export function buildBlockoutPrompt(input: BuildBlockoutPromptInput): string {
  const { beat } = input
  const base = stripBlockoutBlock(input.basePrompt).trim()
  // 「替换」口吻，不是「参考」口吻。2026-09-21 实测：说「参考 @白模1 的运镜…」时模型
  // 会当成在请它设计一个镜头，机位构图随它发挥；说「把蓝色假人替换成 @图片1 的人物」
  // 时它默认把没提到的一切都保住 —— 机位、构图、切点、朝向都跟住了白模。
  const swaps = beat.characters
    .map((c) => {
      const idx = input.imageIndexOf?.[c.key]
      return idx ? `${colorName(c.color)}假人替换成 @图片${idx} 的人物（${c.name}）` : null
    })
    .filter(Boolean)

  const lines: string[] = [
    START,
    `@白模1 是这个镜头的 3D 白模预演（灰模布景、每个人物是一个纯色假人），时长 ${fmt(beat.duration)} 秒。`,
    swaps.length
      ? `把 @白模1 里的${swaps.join('，')}。`
      : '把 @白模1 里的纯色假人替换成参考图里的真实人物。',
    // 把白模的职责划死：只管镜头语言和人物的大体运动姿势。不说清楚的话，它那套灰模
    // 布景会漏进成片，和真实场景混在一起（2026-09-27 实测：背景成了低模几何体+竹林的混合物）。
    '@白模1 只用来定两件事：一是镜头语言 —— 机位、景别、构图、镜头运动和切镜时间点；二是人物的大体运动和姿势 —— 站位、走位路线、朝向、动作发生的时间。这两件事必须和 @白模1 完全一致，不要改。',
    '@白模1 里的布景、地面、天空、材质和颜色一概不作数，一律不要画进成片：成片的场景、光线、色调和画风以参考图为准，按真实实拍来。',
    // 这两条锁是分别针对实测出来的两种漂移加的，都是通用规则、不描述剧情：
    // 人物锁治「单人镜头里冒出另一个人」，景别锁治「白模是半身、成片拍成全身」。
    '画面里的人数、谁在画面里、各自的位置，任何时刻都跟 @白模1 一致：@白模1 某一段里只有一个人，成片这一段就只能有这一个人，不要把另一个人加回画面。',
    '景别也要逐秒对齐：人物在画面里占多大、镜头离他多远，都照 @白模1 同一时刻来，白模里是半身就不要拍成全身，是全身就不要推成特写。',
    // 白模假人脸上的深色五官和胸前的深色面板是**朝向标记**，不是服装或道具。
    // 加它们是因为纯色假人看不出正反面，出片时朝向只能靠猜（实测来回横跳）。
    '假人脸上的深色五官和胸前的深色面板只是用来标示朝向的记号，不是服装、护甲或道具：看得见它们的人就是面向镜头，看不见的就是背对镜头；成片里不要把这些记号画出来。',
    // 角色图常是多格设定表（同一个人的正/侧/背三视图）。不说清楚，模型会把一个人
    // 渲成好几个（2026-09-26 在 beat 3 实测，开场出现 2~3 个同一角色）。
    '参考图里如果同一个人出现了正面、侧面、背面等多个视图，那是同一个人的设定图，不是多个人：成片里每个角色只能出现一个。',
  ]
  if (input.styleImageIndex) {
    lines.push(`@图片${input.styleImageIndex} 只作画面风格参考：色调、光影和质感以它为准，它的机位和构图不作数。`)
  }
  if (swaps.length) lines.push('不要把人物的服装或皮肤渲染成假人的颜色。')

  // 动作文字默认关闭：动作该由 @白模1 自己传达，写成文字等于让白模失去意义，
  // 而且和参考打架（实测多加一句剧情描述就把镜头整个重编了）。留作兜底。
  const actionLines = input.includeActionText ? describeActions(beat) : []
  const goalText = input.includeActionText ? (beat.goal ?? '').trim() : ''
  if (goalText || actionLines.length) {
    lines.push('动作调度（@白模1 里演的就是这些，时间码对应 @白模1）：')
    if (goalText) lines.push(`本镜内容：${goalText}`)
    lines.push(...actionLines)
  }
  lines.push(
    '灰模场景渲染成真实场景，写实电影质感。',
    '成片是正常拍摄的画面：不能出现假人、灰色白模或未贴图的几何体。',
    END,
  )
  return base ? `${lines.join('\n')}\n${base}` : lines.join('\n')
}

/**
 * A blockout clip ships to Seedance by its studio URL (plain HTTP, the only form
 * Seedance accepts), which the canvas page can't play as mixed content. The
 * previs server writes the same clip to the canvas uploads; map to that copy for
 * playback. Non-blockout URLs pass through.
 */
export function playableBlockoutUrl(url: string): string {
  const m = /\/canvas-import\/([0-9a-z]{8})\/blockout\/beat(\d{2})\.mp4/.exec(url)
  return m ? `/uploads/previs-${m[1]}-beat${m[2]}.mp4` : url
}

/** Same rule build-manifest.ts used to assign each source video its beat shotId. */
export function shotIdOfVideo(
  nodeId: string,
  item: { id: string; content?: string },
  rows: { id: string; beatVideoNodeId?: string; beatVideoUrl?: string }[],
): { shotId: string; rowId: string | null } {
  const row = rows.find((r) => r.beatVideoNodeId === nodeId)
    ?? rows.find((r) => !!item.content && r.beatVideoUrl === item.content)
  return { shotId: row?.id ?? item.id, rowId: row?.id ?? null }
}
