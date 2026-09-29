import { v4 as uuid } from 'uuid'
import { toast } from 'sonner'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore, type CanvasItem } from '@/stores/canvas-item-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useProjectDB } from '@/stores/project-db'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import { usePrevisRunsStore } from '@/stores/previs-runs-store'
import { runCapability } from '@/lib/capabilities/client'
import { logAction, logError } from '@/lib/client-log'
import { SHOOT_PROVIDER, isValidReferenceImageUrl, type VirtualAvatarShootRef } from '@/lib/agents/cinematographer-agent'
import { resolveShootAvatarRefs } from '@/hooks/useStoryboardGenerate'
import { buildReferencePack } from '@/lib/reference-pack'
import { rowCharacters, rowIdentitySheets, type StoryboardRow } from '@/types/storyboard'
import { buildBlockoutPrompt, colorName, filterShotDescription, shotIdOfVideo, stripBlockoutBlock, type PrevisBeatClip } from './blockout-reshoot-prompt'

/**
 * 「按白模重拍」on a finished 3D 预演 node. Nothing is overwritten: the run fans
 * out from the previs node into one blockout clip node per beat (the cut白模
 * video itself), and each blockout node then produces a NEW Seedance video node:
 *
 *   3D 预演 ──> 白模 · S1 ──> S1 白模重拍
 *          └──> 白模 · S2 ──> S2 白模重拍
 *
 * Each new video is shot with its beat's blockout clip as Seedance 2.0
 * reference_video (@视频1) plus the original shot's 角色图 / keyframe / refs, and
 * the prompt block from blockout-reshoot-prompt.ts. The source beat videos and
 * the storyboard rows keep pointing at what they pointed at before — the new
 * nodes are candidates the user adopts by hand.
 */


const CONCURRENCY = 2
/** Seedance 2.0 rejects 1080p once a reference_video is attached (verified); ask for 720p directly. */
const RESHOOT_RESOLUTION = '720p'
/**
 * 白模重拍用 **2.0**，不是 2.5。
 *
 * 2.5 的官方说法是「beyond motion transfer into creative interpretation」——
 * 自由发挥更强，对跟白模这件事是负面的。同一条 S8 白模、同一份 prompt、同样
 * 2 张角色图，2026-09-19 实测：2.0 还保得住竹林和大致构图，2.5 直接换成了昏暗
 * 长廊里的追打，白模构图荡然无存。
 *
 * （2.0 能不能收参考视频一度被我判错：网关 video-ref 实测 2.0 正常受理，
 * 走的是 Ark 的 r2v。）
 */
const RESHOOT_MODEL = 'dreamina-seedance-2-0-260128'
/** 关键帧是否进参考图。实测它会明显削弱白模的运镜/走位跟随，见 planReferences。 */
const INCLUDE_KEYFRAME = false

/** shortId of the previs run a result item came from. */
export function previsShortIdOf(item: CanvasItem): string | null {
  const run = Object.values(usePrevisRunsStore.getState().runs).find((r) => r.itemId === item.id)
  if (run) return run.shortId
  return /\/uploads\/previs-([0-9a-z]{8})\.mp4/.exec(item.content)?.[1] ?? null
}

export function isPrevisResultItem(item: CanvasItem | undefined): boolean {
  // provider alone would also match the per-beat blockout clip nodes this flow
  // creates; only a node that maps back to a run shortId is the previs result.
  return !!item && item.kind === 'video' && item.provider === 'storyai-director-studio' && !!item.content
    && previsShortIdOf(item) !== null
}

export interface Target {
  beat: PrevisBeatClip
  /** The beat's original shot video, when it is still on canvas — source of the
   *  prompt and reference images. */
  nodeId?: string
  item?: CanvasItem
  row: StoryboardRow | undefined
  /** Canvas node holding this beat's blockout clip (created on demand). */
  blockoutNodeId?: string
  /** Placeholder item the new Seedance video is written into. */
  resultItemId?: string
  resultNodeId?: string
}

/** One target per beat: the beat, its storyboard row, and the original shot video if we can find it. */
export function planTargets(previsNodeId: string, beats: PrevisBeatClip[]): Target[] {
  const { nodes, edges } = useCanvasStore.getState()
  const items = useCanvasItemStore.getState().items
  const rows = useStoryboardStore.getState().rows
  const itemOfNode = (id: string) => {
    const itemId = nodes.find((n) => n.id === id)?.data.itemId
    return itemId ? items[String(itemId)] : undefined
  }
  const isSourceVideo = (it: CanvasItem | undefined): it is CanvasItem =>
    !!it && it.kind === 'video' && it.role !== 'beat-video-alternate' && it.provider !== 'storyai-director-studio'

  // Beat → the wired source video, by the same shotId rule build-manifest used.
  const byShotId = new Map<string, { nodeId: string; item: CanvasItem; rowId: string | null }>()
  const wired = [...new Set(edges.filter((e) => e.target === previsNodeId).map((e) => e.source))]
  for (const nodeId of wired) {
    const item = itemOfNode(nodeId)
    if (!isSourceVideo(item)) continue
    const { shotId, rowId } = shotIdOfVideo(nodeId, item, rows)
    if (!byShotId.has(shotId)) byShotId.set(shotId, { nodeId, item, rowId })
  }

  return beats.map((beat) => {
    let src = byShotId.get(beat.shotId)
    if (!src) {
      // Edge removed by hand: fall back to the row's own beat-video node / the item id.
      const row = rows.find((r) => r.id === beat.shotId)
      const nodeId = row?.beatVideoNodeId ?? nodes.find((n) => String(n.data.itemId ?? '') === beat.shotId)?.id
      const item = nodeId ? itemOfNode(nodeId) : undefined
      if (nodeId && isSourceVideo(item)) src = { nodeId, item, rowId: row?.id ?? null }
    }
    const rowId = src?.rowId ?? (rows.some((r) => r.id === beat.shotId) ? beat.shotId : null)
    return { beat, nodeId: src?.nodeId, item: src?.item, row: rows.find((r) => r.id === rowId) }
  })
}

/** Name a beat by its storyboard shot number, falling back to the beat index. */
function beatLabel(t: Target): string {
  return t.row?.shot_number ? `S${String(t.row.shot_number).replace(/^S/i, '')}` : `第${t.beat.beat}镜`
}

const NODE_GAP = 40
const BLOCKOUT_SIZE = { width: 320, height: 180 }
const VIDEO_SIZE = { width: 360, height: 200 }

/** Canvas node for this beat's blockout clip, reused when the run already made one. */
function ensureBlockoutNode(t: Target, previsNodeId: string, index: number): string {
  const canvas = useCanvasStore.getState()
  const items = useCanvasItemStore.getState().items
  const clipContent = t.beat.localUrl || t.beat.clipUrl
  const existing = canvas.nodes.find((n) => {
    const it = items[String(n.data.itemId ?? '')]
    return it?.kind === 'video' && (it.content === clipContent || it.refVideos?.[0] === t.beat.clipUrl)
  })
  if (existing) return existing.id

  const anchor = canvas.nodes.find((n) => n.id === previsNodeId)
  const x = (anchor?.position.x ?? 0) + Number(anchor?.style?.width ?? anchor?.width ?? 360) + 80
  const y = (anchor?.position.y ?? 0) + index * (BLOCKOUT_SIZE.height + NODE_GAP)
  const itemId = useCanvasItemStore.getState().addItem({
    kind: 'video',
    // 'beat-video-alternate' keeps it out of the storyboard's adoption paths and
    // out of this flow's own source-video scan.
    role: 'beat-video-alternate',
    name: `白模 · ${beatLabel(t)}`,
    content: clipContent,
    description: `3D 白模预演第 ${t.beat.beat} 镜（${Math.round(t.beat.duration)}s，原片 ${t.beat.start.toFixed(1)}s 起）`,
    // The studio URL is what Seedance actually receives as reference_video.
    refVideos: [t.beat.clipUrl],
    provider: 'storyai-director-studio',
    model: 'previs-blockout',
  })
  const nodeId = useCanvasStore.getState().addItemNode(itemId, 'video', { x, y }, BLOCKOUT_SIZE)
  useCanvasStore.getState().addEdge(previsNodeId, nodeId)
  return nodeId
}

const sameName = (a: string, b: string) => {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x))
}

export interface ReshootReferences {
  images: string[]
  legend: string[]
  imageIndexOf: Record<string, number | undefined>
  styleImageIndex?: number
  avatarAssetUris: string[]
  /** 图生图定帧用：本镜出场人物的角色图（顺序同 beat.characters）。 */
  characterImages: string[]
  /** 图生图定帧用：场景图。只贡献环境和光线，不参与构图。 */
  sceneImage?: string
  /** 图生图定帧用：道具图。白模把没有几何体的道具渲成一个灰方块，不给道具图的话
   *  出图模型会把它画成百宝箱并且悬在半空（实测）。 */
  propImages: string[]
}

/**
 * Reference images for one reshoot, in @图片 order:
 *   角色图 of every character in the beat (the colour → person mapping points at
 *   these) → the shot's keyframe (the look to match) → the video's remaining refs
 *   (scene / props / storyboard grid).
 *
 * `avatars` (开白真人资产) switch to the privacy-safe set generateBeatVideo uses:
 * the photoreal 角色图 / keyframe are dropped and each covered character points at
 * its asset:// ref instead — only asset:// faces pass Seedance's privacy filter.
 */
export function planReferences(t: Target, avatars: VirtualAvatarShootRef[] = []): ReshootReferences {
  const items = useCanvasItemStore.getState().items
  const { nodes, edges } = useCanvasStore.getState()
  const itemOfNode = (id: string | undefined) => {
    const itemId = id ? nodes.find((n) => n.id === id)?.data.itemId : undefined
    return itemId ? items[String(itemId)] : undefined
  }
  const row = t.row
  const pack = row ? buildReferencePack(row) : []
  const labelOf = new Map(pack.map((p) => [p.url, `${p.label} —— ${p.usage}`]))

  // ─── 角色图 per blockout character ───
  const slots = row ? rowCharacters(row) : []
  const sheets = row ? rowIdentitySheets(row) : []
  const person = new Set<string>(pack.filter((p) => p.kind === 'character' || p.kind === 'camera').map((p) => p.url))
  const characterImage = (name: string): string | undefined => {
    const found: string[] = []
    slots.forEach((slot, i) => {
      const slotItem = itemOfNode(slot.nodeId)
      const slotName = slotItem?.name || slot.description?.split(/[，,。\n]/)[0] || ''
      if (!sameName(slotName, name)) return
      // Canvas 角色图 first, then the slot's copy, identity sheet last.
      found.push(slotItem?.content ?? '', slot.image ?? '', sheets[i] ?? '')
    })
    for (const it of Object.values(items)) if (it.role === 'character' && sameName(it.name, name)) found.push(it.content)
    const valid = found.filter((u) => isValidReferenceImageUrl(u))
    valid.forEach((u) => person.add(u))
    return valid[0]
  }
  const characters = t.beat.characters.map((c) => ({ ...c, url: characterImage(c.name) }))
  slots.forEach((slot, i) => { if (slot.image) person.add(slot.image); if (sheets[i]) person.add(sheets[i]) })

  // ─── keyframe: the look to match ───
  const upstreamKeyframe = (role: string) =>
    edges.filter((e) => e.target === t.nodeId).map((e) => itemOfNode(e.source)).find((it) => it?.role === role)?.content
  const keyframe = [row?.keyframeCleanUrl, row?.keyframeUrl, row?.reference_image, upstreamKeyframe('keyframe-clean'), upstreamKeyframe('keyframe')]
    .find((u) => isValidReferenceImageUrl(u))

  // ─── 其余参考图：白模重拍一律不带 ───
  // 2026-09-19 对照实验（S8，sv-seedance-2.0 480p video-ref，只变图数）：
  //   0 张 → 完全跟住白模（机位/构图/走位/出画时间点全对）
  //   2 张（角色图）→ 人物渲染正确，走位开始失真
  //   6 张（角色+关键帧+道具+场景）→ 整个镜头被重造，机位完全不跟
  // 6 张图的情况下，试过的每一种措辞（短跟随、逐项点名、官方句式、额外约束句）
  // 都救不回来 —— 主因是图的数量，不是 prompt。所以场景图、道具图、原节点带的
  // 其它参考图在这条路径上全部不带，只留本镜出场人物的角色图（+ 关键帧作风格）。
  // ─── everything else the video was shot with ───
  // The B&W storyboard grid is dropped on purpose: it carries its own shot plan
  // (per-panel framing, push-ins, top-down staging) and its legend tells the model
  // to read 调度/机位 from it — exactly what @视频1 is here to decide. Keeping both
  // made the render follow the grid's camera and ignore the blockout (verified on
  // 沈渊/鬼面客 S8). Scene / prop images stay: they never dictate camera.
  const storyboardGrids = new Set([
    ...pack.filter((p) => p.kind === 'storyboard').map((p) => p.url),
    ...(row?.keyframeUrl && row.keyframeUrl !== row.keyframeCleanUrl ? [row.keyframeUrl] : []),
  ])
  const original = (t.item?.refImages ?? []).filter(isValidReferenceImageUrl)
  const rest = (original.length ? original : pack.map((p) => p.url))
    .filter((u) => !person.has(u) && u !== keyframe && u !== row?.keyframeCleanUrl && !storyboardGrids.has(u))

  const privacySafe = avatars.length > 0
  const images: string[] = []
  const legend: string[] = []
  const imageIndexOf: Record<string, number | undefined> = {}
  let styleImageIndex: number | undefined
  const add = (url: string, label: string): number => {
    const at = images.indexOf(url)
    if (at >= 0) return at + 1
    images.push(url)
    legend.push(`@图片${images.length} = ${label}`)
    return images.length
  }
  if (!privacySafe) {
    for (const c of characters) {
      if (c.url) imageIndexOf[c.key] = add(c.url, `角色图「${c.name}」 —— ${colorName(c.color)}假人对应的人物，长相、发型、体型和服装以这张图为准`)
    }
    // 关键帧默认不带：实测它作为第 3 张图就会把白模压下去（结尾被拉成大脸特写，
    // 夕阳构图盖过白模的机位）。风格只能先由 prompt 正文承担。要找回「画面风格
    // 严格参考关键帧」就把这个开关打开，代价是跟随变差。
    if (keyframe && INCLUDE_KEYFRAME) styleImageIndex = add(keyframe, '关键帧')
  }
  void rest
  void labelOf
  avatars.forEach((a, i) => {
    const n = images.length + i + 1
    const c = characters.find((x) => sameName(x.name, a.characterName))
    // The server appends asset:// refs after the image parts.
    if (c) imageIndexOf[c.key] = n
    legend.push(`@图片${n} = 真人资产「${a.characterName}」（已开白的角色脸） —— ${c ? `${colorName(c.color)}假人对应的人物，` : ''}脸、发型和身形以它为准`)
  })
  // 定帧那一步要的素材：角色图按 beat.characters 顺序，外加一张场景图（只给环境）。
  // 出片本身不吃它们 —— 参考图越多越抢构图，这是实测结论。
  const characterImages = characters.map((c) => c.url).filter((u): u is string => Boolean(u))
  const sceneImage = pack.find((pk) => pk.kind === 'scene' && isValidReferenceImageUrl(pk.url))?.url
  const propImages = pack.filter((pk) => pk.kind === 'prop' && isValidReferenceImageUrl(pk.url)).map((pk) => pk.url).slice(0, 2)

  return {
    images, legend, imageIndexOf, styleImageIndex,
    avatarAssetUris: avatars.map((a) => a.assetUri),
    characterImages, sceneImage, propImages,
  }
}

const isPrivacyBlock = (msg: string) => msg.includes('InputImageSensitiveContentDetected.PrivacyInformation')

/** Shoot this beat into a NEW canvas video node hanging off its blockout node. */
async function reshootOne(t: Target, blockoutNodeId: string): Promise<void> {
  const db = useProjectDB.getState()
  const aspect = (['16:9', '9:16', '1:1', '4:3'] as const).find((a) => a === db.artDirection.defaultAspectRatio) ?? '16:9'
  // 分镜正文接回来，但**先按数据过滤**：白模没拍到的内容一律删掉。
  // 2026-09-27 实测：beat 8 的描述里有「鬼面客…转身走开」，而白模在他那个动作发生的
  // 时段拍的是沈渊单人近景——他根本不在画面里。留着这句，模型要么把他塞回画面，
  // 要么为了演全动作把景别拉宽，两种都在和白模打架。删掉之后景别自己就收回来了。
  const storyText = [t.item?.prompt?.trim(), t.row?.motion_prompts, t.row?.visual_description, t.row?.character_actions]
    .map((x) => stripBlockoutBlock(x ?? '').trim())
    .filter(Boolean)
    .join('\n')
  const onScreen = new Map<string, [number, number][]>()
  for (const shot of t.beat.frameShots ?? []) {
    if (typeof shot.at !== 'number') continue
    for (const key of shot.present ?? []) {
      const name = t.beat.characters.find((c) => c.key === key)?.name
      if (!name) continue
      // 每个出镜帧按 ±1s 展开成一个时段，用来和动作时间窗比重叠。
      onScreen.set(name, [...(onScreen.get(name) ?? []), [Math.max(0, shot.at - 1), shot.at + 1]])
    }
  }
  const basePrompt = storyText
    ? filterShotDescription(storyText, t.beat.characters.map((c) => ({ name: c.name, motionWindow: c.motionWindow ?? null })), onScreen)
    : ''
  const audios = (t.item?.refAudios ?? []).filter((u) => u?.trim()).slice(0, 3)
  const duration = Math.round(Math.min(15, Math.max(4, t.beat.duration)))

  const shoot = async (refs: ReshootReferences) => {
    const prompt = buildBlockoutPrompt({ basePrompt, beat: t.beat, imageIndexOf: refs.imageIndexOf, styleImageIndex: refs.styleImageIndex, imageLegend: refs.legend })
    // 场景图跟在角色图后面：白模的职责已在 prompt 里划死为「镜头语言 + 大体运动姿势」，
    // 布景一概不作数，成片的环境就靠这张场景图（否则背景会退化成灰白的自编场景）。
    const images = refs.sceneImage ? [...refs.images, refs.sceneImage] : refs.images
    const r = await runCapability({
      capability: 'text-to-video',
      inputs: [
        { kind: 'text', text: prompt },
        ...images.map((url) => ({ kind: 'image' as const, url })),
        { kind: 'video', url: t.beat.clipUrl },
        ...audios.map((url) => ({ kind: 'audio' as const, url })),
      ],
      params: {
        provider: SHOOT_PROVIDER,
        model: RESHOOT_MODEL,
        duration: String(duration),
        aspect,
        resolution: RESHOOT_RESOLUTION,
        // 白模重拍不需要模型生成音频（配音是另一条链路）。开着会撞
        // `output audio may be related to copyright restrictions` 风控，
        // 整条任务跑完才失败、照样计费。
        generate_audio: false,
        ...(refs.avatarAssetUris.length ? { avatarAssetUris: refs.avatarAssetUris } : {}),
      },
    })
    const url = r.outputs[0]?.url
    if (!url) throw new Error('Seedance 没有返回视频')
    return { url, prompt, refs }
  }

  logAction('blockout-reshoot.shot.start', {
    beat: t.beat.beat, shotId: t.beat.shotId, duration, aspect, resolution: RESHOOT_RESOLUTION,
    clip: t.beat.clipUrl, sourceItem: t.item?.name, audios: audios.length,
  })

  let result: Awaited<ReturnType<typeof shoot>>
  try {
    result = await shoot(planReferences(t))
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    // Photoreal 角色图 / keyframe tripped the privacy filter (rejected at task
    // creation, nothing billed). If the cast is 开白'd, retry once with asset:// faces.
    if (!isPrivacyBlock(msg) || !t.row) throw e
    const resolved = await resolveShootAvatarRefs(t.row, useProjectDB.getState())
    if (resolved.byteplusMatched.length === 0) throw e
    toast.message(`${beatLabel(t)}：真人角色图被风控拦截，改用开白资产重试`, {
      description: `${resolved.byteplusMatched.map((r) => r.characterName).join('、')} 用 asset:// 真人资产；这次不带角色图和关键帧`,
    })
    result = await shoot(planReferences(t, resolved.refs.slice(0, 6)))
  }

  const { url, prompt, refs } = result
  logAction('blockout-reshoot.shot.done', { beat: t.beat.beat, url, images: refs.images.length, avatars: refs.avatarAssetUris.length })
  useCanvasItemStore.getState().updateItem(t.resultItemId!, {
    content: url,
    prompt,
    refImages: refs.images,
    refAudios: audios,
    refVideos: [t.beat.clipUrl],
    // So 编辑面板 → 用 Prompt 重新生成 starts from the same settings.
    genParams: { duration: String(duration), aspect, resolution: RESHOOT_RESOLUTION, model: RESHOOT_MODEL, provider: SHOOT_PROVIDER },
    description: `按白模重拍 · 第 ${t.beat.beat} 镜${t.item ? `（原视频「${t.item.name}」）` : ''}`,
  })
  void blockoutNodeId
}

/** A blockout clip node made by this flow (`白模 · S8`), and the run/beat it holds. */
export function blockoutClipOf(item: CanvasItem | undefined): { shortId: string; beat: number } | null {
  if (!item || item.kind !== 'video' || item.model !== 'previs-blockout') return null
  const url = item.refVideos?.[0] ?? item.content
  const m = /previs-([0-9a-z]{8})-beat(\d{2})\.mp4|\/canvas-import\/([0-9a-z]{8})\/blockout\/beat(\d{2})\.mp4/.exec(url)
  if (!m) return null
  return { shortId: m[1] ?? m[3], beat: Number(m[2] ?? m[4]) }
}

async function fetchBeats(shortId: string): Promise<PrevisBeatClip[] | null> {
  try {
    const res = await fetch(`/previs/beats?shortId=${shortId}`, { cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    return data.beats as PrevisBeatClip[]
  } catch (e) {
    toast.error('按白模重拍：取不到白模片段', { description: (e as Error).message })
    return null
  }
}

/** Place the result node for one target and run the shoot queue. */
async function runTargets(shootable: Target[]): Promise<void> {
  const itemStore = useCanvasItemStore.getState()
  for (const t of shootable) {
    const blockout = useCanvasStore.getState().nodes.find((n) => n.id === t.blockoutNodeId)
    // Stack repeat takes under each other instead of on top of the previous one.
    const siblings = useCanvasStore.getState().edges.filter((e) => e.source === t.blockoutNodeId).length
    t.resultItemId = itemStore.addItem({
      kind: 'video',
      role: 'beat-video-alternate',
      name: `${beatLabel(t)} 白模重拍`,
      content: '',
      description: `按白模重拍 · 生成中（第 ${t.beat.beat} 镜）`,
      provider: SHOOT_PROVIDER,
      model: RESHOOT_MODEL,
    })
    t.resultNodeId = useCanvasStore.getState().addItemNode(
      t.resultItemId, 'video',
      {
        x: (blockout?.position.x ?? 0) + BLOCKOUT_SIZE.width + 80,
        y: (blockout?.position.y ?? 0) + siblings * (VIDEO_SIZE.height + NODE_GAP),
      },
      VIDEO_SIZE,
    )
    useCanvasStore.getState().addEdge(t.blockoutNodeId!, t.resultNodeId)
    // Keep the provenance of the prompt / reference images visible too.
    if (t.nodeId) useCanvasStore.getState().addEdge(t.nodeId, t.resultNodeId)
  }

  const tasks = useLibtvTasksStore.getState()
  const taskIds = new Map(shootable.map((t) => {
    const id = uuid()
    tasks.startTask({ id, nodeId: t.resultNodeId!, itemId: t.resultItemId!, prompt: '按白模重拍' })
    tasks.updateTask(id, { status: 'polling' })
    return [t.resultItemId!, id]
  }))

  const failures: string[] = []
  let done = 0
  const queue = [...shootable]
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const taskId = taskIds.get(t.resultItemId!)!
      try {
        await reshootOne(t, t.blockoutNodeId!)
        done++
        useLibtvTasksStore.getState().updateTask(taskId, { status: 'done', resultKind: 'video' })
        toast.success(`${beatLabel(t)} 白模重拍完成`)
      } catch (e) {
        let msg = (e as Error).message ?? String(e)
        if (isPrivacyBlock(msg)) {
          msg = `参考图里有真人被风控拦截：先给这些角色开白（重新生成角色图会自动开白，或在角色节点绿盾按钮里绑定已开白角色）再重拍。${msg.slice(0, 120)}`
        }
        logError('blockout-reshoot.shot.failed', { beat: t.beat.beat, error: msg })
        failures.push(`${beatLabel(t)}：${msg.slice(0, 160)}`)
        useLibtvTasksStore.getState().updateTask(taskId, { status: 'failed', error: msg })
        if (t.resultItemId) useCanvasItemStore.getState().updateItem(t.resultItemId, { description: `按白模重拍失败：${msg.slice(0, 200)}` })
      } finally {
        // The node spinner only watches pending/polling tasks; drop finished ones.
        useLibtvTasksStore.getState().removeTask(taskId)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shootable.length) }, worker))

  if (failures.length) {
    toast.error(`按白模重拍：${done} 个完成，${failures.length} 个失败`, { description: failures.join('\n') })
  } else {
    toast.success(`按白模重拍完成：${done} 个新视频节点`)
  }
}

/**
 * Re-shoot ONE beat from its blockout clip node (`白模 · S8`), so a single shot can
 * be iterated without re-running the whole previs. Each run adds another result
 * node under the clip; nothing existing is overwritten.
 */
export async function reshootOneBeatFromClip(blockoutNodeId: string): Promise<void> {
  const { nodes, edges } = useCanvasStore.getState()
  const items = useCanvasItemStore.getState().items
  const itemOf = (nodeId: string | undefined) => {
    const id = nodeId ? nodes.find((n) => n.id === nodeId)?.data.itemId : undefined
    return id ? items[String(id)] : undefined
  }
  const clip = blockoutClipOf(itemOf(blockoutNodeId))
  if (!clip) {
    toast.error('这个节点不是白模片段')
    return
  }
  // The previs node this clip hangs off — planTargets needs it to find the shot videos.
  const previsNodeId = edges
    .filter((e) => e.target === blockoutNodeId)
    .find((e) => isPrevisResultItem(itemOf(e.source)))?.source
    ?? nodes.find((n) => {
      const it = items[String(n.data.itemId ?? '')]
      return !!it && isPrevisResultItem(it) && previsShortIdOf(it) === clip.shortId
    })?.id
  if (!previsNodeId) {
    toast.error('找不到这个白模片段对应的 3D 预演节点', { description: '把白模节点重新连到预演节点上再试' })
    return
  }

  const beats = await fetchBeats(clip.shortId)
  if (!beats) return
  const target = planTargets(previsNodeId, beats).find((t) => t.beat.beat === clip.beat)
  if (!target) {
    toast.error(`预演里没有第 ${clip.beat} 镜`)
    return
  }
  if (!target.item && !target.row) {
    toast.error('找不到这一镜的原始 prompt', { description: '把原镜头视频节点连回 3D 预演节点，或确认分镜表里还有对应的行' })
    return
  }
  target.blockoutNodeId = blockoutNodeId
  if (!window.confirm(
    `用这段白模重拍「${beatLabel(target)}」（${Math.round(target.beat.duration)}s）？\n\n` +
    `会在这个白模节点右边新建一个视频节点（Seedance 2.5 ${RESHOOT_RESOLUTION}），已有的节点都不会被改动。`,
  )) return

  logAction('blockout-reshoot.single.start', { shortId: clip.shortId, beat: clip.beat })
  toast.message(`开始重拍 ${beatLabel(target)}`, { description: '几分钟，结果会落在右边的新节点上' })
  await runTargets([target])
}

export async function reshootInputsWithBlockout(previsNodeId: string): Promise<void> {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === previsNodeId)
  const previsItem = node?.data.itemId ? useCanvasItemStore.getState().items[String(node.data.itemId)] : undefined
  const shortId = previsItem && isPrevisResultItem(previsItem) ? previsShortIdOf(previsItem) : null
  if (!shortId) {
    toast.error('按白模重拍：这个节点不是已完成的 3D 预演')
    return
  }

  const beats = await fetchBeats(shortId)
  if (!beats) return

  logAction('blockout-reshoot.start', { shortId, beats: beats.length })
  const targets = planTargets(previsNodeId, beats)
  // A beat with neither its shot video nor a storyboard row has no prompt to shoot from.
  const shootable = targets.filter((t) => t.item || t.row)
  const skipped = targets.filter((t) => !t.item && !t.row).map(beatLabel)
  if (shootable.length === 0) {
    toast.error('按白模重拍：找不到这些镜头的原始 prompt', {
      description: '把原镜头视频节点连回这个 3D 预演节点，或确认分镜表里还有对应的行',
    })
    return
  }
  const summary = shootable.map((t) => `${beatLabel(t)}（${Math.round(t.beat.duration)}s）`).join('、')
  if (!window.confirm(
    `用 3D 白模预演作为运镜和动作参考，生成 ${shootable.length} 个新的镜头视频？\n\n${summary}\n\n` +
    `每镜会在画布上新建一个白模片段节点和一个新视频节点（Seedance 2.5 ${RESHOOT_RESOLUTION}），原来的视频节点不会被改动。` +
    (skipped.length ? `\n没有原始 prompt、只建白模节点：${skipped.join('、')}` : ''),
  )) return

  // Fan out on canvas first, so the user sees the whole plan while it shoots.
  targets.forEach((t, i) => {
    t.blockoutNodeId = ensureBlockoutNode(t, previsNodeId, i)
  })
  toast.message(`开始按白模重拍 ${shootable.length} 个镜头`, { description: '每个几分钟，结果会落在新节点上，原视频保持不变' })
  await runTargets(shootable)
}
