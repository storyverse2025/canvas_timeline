import { v4 as uuid } from 'uuid'
import type { Edge, Node } from '@xyflow/react'
import type { CanvasItem, CanvasItemRole } from '@/stores/canvas-item-store'
import type { CanvasNodeGeometry } from '@/stores/canvas-store'
import type { ElementSlot, StoryboardRow } from '@/types/storyboard'
import { EMPTY_ELEMENT_SLOT, MAX_ROW_CHARACTERS, MAX_ROW_PROPS, normalizeRowSlots } from '@/types/storyboard'
import type { SvAsset, SvBundle, SvReference, SvRow } from './types'

/**
 * Pure StoryVerse bundle → canvas + storyboard mapper.
 *
 * Kept free of store access and I/O so it can be tested against a fixture
 * pulled straight out of the production database. The applier
 * (`apply-import.ts`) is the only part that touches Zustand; the timeline
 * needs nothing at all — `initStoryboardTimelineLink` rebuilds the three
 * tracks from the storyboard rows the moment they land.
 */

export interface MappedImport {
  items: CanvasItem[]
  nodes: Node<CanvasNodeGeometry>[]
  edges: Edge[]
  rows: StoryboardRow[]
  summary: {
    assets: number
    keyframes: number
    videos: number
    rows: number
    scripts: number
    linkedSlots: number
    /** Extra canvas nodes spawned for reference images the asset library
     *  no longer exposes (superseded versions / deleted assets). */
    referenceOnlyImages: number
  }
}

/** One entry of a frame prompt's `[REFERENCES]` block. */
export interface ParsedReference {
  /** 1-based index into the frame's `references`. */
  imageIndex: number
  /** Raw slot tag: `char1`, `char2`, `scene`, `prop1`, … */
  tag: string
  name: string
  description: string
}

const REF_LINE_RE = /^\(\s*(?:image|img)\s*(\d+)\s*\)\s*<\s*([^>]+?)\s*>\s*@?\s*([^\n]*)$/i

/**
 * Parse the `[REFERENCES]` block StoryVerse embeds at the top of every frame
 * prompt:
 *
 *   [REFERENCES]
 *   (image1) <char1> @Maya Reyes - East Asian woman, rust-orange dress
 *   (image2) <scene> @Contemporary luxury private study - walnut study
 *
 * This is a far better slot signal than guessing from the asset library,
 * because it says which reference image plays which role in THIS shot.
 */
export function parseReferenceBlock(prompt: string): ParsedReference[] {
  if (!prompt) return []
  const start = prompt.indexOf('[REFERENCES]')
  if (start < 0) return []
  const rest = prompt.slice(start + '[REFERENCES]'.length)
  // The block ends at the next bracketed section header.
  const end = rest.search(/\n\s*\[[A-Z][A-Z _-]*\]/)
  const block = end >= 0 ? rest.slice(0, end) : rest

  const out: ParsedReference[] = []
  for (const raw of block.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(REF_LINE_RE)
    if (!m) continue
    const [, idx, tag, tail] = m
    // `Maya Reyes - East Asian woman, rust-orange dress` → name / description.
    const dash = tail.indexOf(' - ')
    out.push({
      imageIndex: Number(idx),
      tag: tag.toLowerCase(),
      name: (dash >= 0 ? tail.slice(0, dash) : tail).trim(),
      description: (dash >= 0 ? tail.slice(dash + 3) : '').trim(),
    })
  }
  return out
}

/** Pull the human-readable intent line out of a frame prompt, for 画面描述. */
export function extractVisualDescription(row: SvRow): string {
  if (row.description.trim()) return row.description.trim()
  const goal = row.framePrompt.match(/\[SPATIAL REFERENCE GOAL\]\s*\n([\s\S]*?)(?:\n\s*\[|$)/)
  if (goal?.[1]?.trim()) return goal[1].trim()
  // Fall back to the first prose line of the shot prompt that isn't a
  // directive header or a reference listing.
  for (const line of (row.shotPrompt || row.displayPrompt).split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('参考图') || /^[A-Z_]+:/.test(t) || t.startsWith('[')) continue
    return t
  }
  return ''
}

/** Canvas item role for an upstream asset category. */
export function roleForCategory(category: string): CanvasItemRole {
  switch (category.toLowerCase()) {
    case 'character': return 'character'
    case 'property': return 'prop'
    // NOT 'scene': that role makes ImageCanvasNode render a 360° panorama
    // through PanoramaViewer, and these are flat plates. 'scene-view' is the
    // flat 16:9 variant and still reads as a scene everywhere else.
    case 'environment': return 'scene-view'
    default: return 'prop'
  }
}

type SlotKind = 'character' | 'prop' | 'scene'

/** `char1` / `prop2` / `scene` → which storyboard slot the reference fills. */
export function slotKindForTag(tag: string): SlotKind | null {
  const t = tag.toLowerCase()
  if (t.startsWith('char')) return 'character'
  if (t.startsWith('prop')) return 'prop'
  if (t.startsWith('scene') || t.startsWith('env') || t.startsWith('loc')) return 'scene'
  return null
}

function slotKindForCategory(category: string): SlotKind {
  switch (category.toLowerCase()) {
    case 'character': return 'character'
    case 'environment': return 'scene'
    default: return 'prop'
  }
}

function clampDuration(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 5
  return Math.min(600, Math.max(0.5, seconds))
}

/** Layout columns — a left-to-right read: 剧本 → 素材 → 故事板 → 视频. */
const COL = { script: 0, character: 420, scene: 720, prop: 1020, keyframe: 1400, video: 1760 }
const ASSET_SIZE = { width: 240, height: 200 }
const KF_SIZE = { width: 300, height: 190 }
const VIDEO_SIZE = { width: 320, height: 210 }
const TEXT_SIZE = { width: 340, height: 220 }
const ROW_PITCH = 250

export interface MapOptions {
  /** Injectable id factory — tests pass a counter for stable snapshots. */
  makeId?: () => string
}

export function mapBundleToCanvas(bundle: SvBundle, opts: MapOptions = {}): MappedImport {
  const makeId = opts.makeId ?? (() => uuid())
  const now = Date.now()

  const items: CanvasItem[] = []
  const nodes: Node<CanvasNodeGeometry>[] = []
  const edges: Edge[] = []

  const pushItem = (
    data: Omit<CanvasItem, 'id' | 'createdAt'>,
    position: { x: number; y: number },
    size: { width: number; height: number },
  ): { itemId: string; nodeId: string } => {
    const itemId = makeId()
    const nodeId = makeId()
    items.push({ ...data, id: itemId, createdAt: now })
    nodes.push({
      id: nodeId,
      type: data.kind,
      position,
      data: { itemId },
      width: size.width,
      height: size.height,
      style: { width: size.width, height: size.height },
    })
    return { itemId, nodeId }
  }

  const link = (sourceId: string, targetId: string) => {
    edges.push({
      id: `e-${makeId()}`,
      source: sourceId,
      target: targetId,
      sourceHandle: 'r',
      targetHandle: 'l',
    })
  }

  // ─── 1. Script text nodes, one per episode ───
  let scriptY = 0
  let scripts = 0
  for (const ep of bundle.episodes) {
    const body = [ep.summary && `【梗概】${ep.summary}`, ep.script].filter(Boolean).join('\n\n')
    if (!body.trim()) continue
    scripts++
    pushItem(
      {
        kind: 'text',
        name: bundle.episodes.length > 1 ? `第${ep.number}集剧本 · ${ep.title || ''}`.trim() : `剧本 · ${ep.title || bundle.project.title}`,
        content: body,
        role: 'script',
        description: `导入自 StoryVerse 项目「${bundle.project.title}」`,
      },
      { x: COL.script, y: scriptY },
      TEXT_SIZE,
    )
    scriptY += TEXT_SIZE.height + 60
  }

  // ─── 2. Asset library → canvas image nodes ───
  const assetNodeByPath = new Map<string, { nodeId: string; asset: SvAsset }>()
  const columnY: Record<string, number> = { character: 0, scene: 0, prop: 0 }
  let assetCount = 0

  for (const asset of bundle.assets) {
    if (!asset.imageUrl) continue
    const kind = slotKindForCategory(asset.category)
    const x = kind === 'character' ? COL.character : kind === 'scene' ? COL.scene : COL.prop
    const { nodeId } = pushItem(
      {
        kind: 'image',
        name: asset.name,
        content: asset.imageUrl,
        role: roleForCategory(asset.category),
        description: asset.prompt.slice(0, 300),
        prompt: asset.prompt,
      },
      { x, y: columnY[kind] },
      ASSET_SIZE,
    )
    columnY[kind] += ASSET_SIZE.height + 40
    assetCount++
    if (asset.storagePath) assetNodeByPath.set(asset.storagePath, { nodeId, asset })
  }

  /**
   * Node that should back a reference image.
   *
   * The asset library only holds each asset's ACTIVE version, but a frame's
   * references point at whatever version was current when it was composed.
   * When a reference is a superseded version we spawn one extra canvas node
   * for it (deduped by url across the whole import — typically <5 per project)
   * so the storyboard slot shows the image the shot actually used instead of
   * silently coming up empty.
   */
  const nodeByRefUrl = new Map<string, string>()
  const resolveReference = (ref: SvReference, fallbackName: string): { nodeId: string; image: string } => {
    if (!ref.url) return { nodeId: '', image: '' }
    const byPath = ref.path ? assetNodeByPath.get(ref.path) : undefined
    if (byPath) return { nodeId: byPath.nodeId, image: byPath.asset.imageUrl }

    const existing = nodeByRefUrl.get(ref.url)
    if (existing) return { nodeId: existing, image: ref.url }

    const name = ref.assetName || fallbackName || '参考图'
    const category = ref.assetCategory || 'property'
    const kind = slotKindForCategory(category)
    const x = kind === 'character' ? COL.character : kind === 'scene' ? COL.scene : COL.prop
    const { nodeId } = pushItem(
      {
        kind: 'image',
        name: ref.assetId ? `${name} · 旧版` : name,
        content: ref.url,
        role: roleForCategory(category),
        description: ref.assetId
          ? '分镜引用的历史版本（素材库当前使用的是另一版）'
          : '分镜引用图（素材库中已无对应条目）',
      },
      { x, y: columnY[kind] },
      ASSET_SIZE,
    )
    columnY[kind] += ASSET_SIZE.height + 40
    nodeByRefUrl.set(ref.url, nodeId)
    return { nodeId, image: ref.url }
  }

  // ─── 3. Frames + shots → storyboard rows, keyframe + beat-video nodes ───
  const multiEpisode = new Set(bundle.rows.map((r) => r.episodeNumber)).size > 1
  const rows: StoryboardRow[] = []
  let keyframes = 0
  let videos = 0
  let linkedSlots = 0

  bundle.rows.forEach((r, i) => {
    const y = i * ROW_PITCH
    const shotNumber = multiEpisode
      ? `E${r.episodeNumber}-${String(r.frameNumber).padStart(2, '0')}`
      : String(r.frameNumber || i + 1)

    // Slots, driven by the prompt's [REFERENCES] block where present.
    const characters: ElementSlot[] = []
    const props: ElementSlot[] = []
    let scene: ElementSlot = { ...EMPTY_ELEMENT_SLOT }
    const usedNodeIds: string[] = []

    const addSlot = (kind: SlotKind, slot: ElementSlot, nodeId: string) => {
      if (nodeId) usedNodeIds.push(nodeId)
      if (kind === 'character') { if (characters.length < MAX_ROW_CHARACTERS) characters.push(slot) }
      else if (kind === 'prop') { if (props.length < MAX_ROW_PROPS) props.push(slot) }
      else if (!scene.image && !scene.description) { scene = slot }
      linkedSlots++
    }

    const refs = parseReferenceBlock(r.framePrompt)
    if (refs.length) {
      for (const parsed of refs) {
        const kind = slotKindForTag(parsed.tag)
        if (!kind) continue
        const ref = r.references[parsed.imageIndex - 1]
        if (!ref) continue
        const { nodeId, image } = resolveReference(ref, parsed.name)
        addSlot(kind, {
          image,
          description: parsed.name || ref.assetName || parsed.description,
          nodeId,
        }, nodeId)
      }
    } else {
      // No structured block — fall back to the reference list itself,
      // bucketing each by the category it resolves to.
      for (const ref of r.references) {
        if (!ref.url) continue
        const { nodeId, image } = resolveReference(ref, '')
        addSlot(slotKindForCategory(ref.assetCategory || 'property'), {
          image,
          description: ref.assetName,
          nodeId,
        }, nodeId)
      }
    }

    // Keyframe (黑白故事板 / storyboard frame image) node.
    let keyframeNodeId = ''
    if (r.keyframeUrl) {
      keyframes++
      const { nodeId } = pushItem(
        {
          kind: 'image',
          name: `${shotNumber} 故事板`,
          content: r.keyframeUrl,
          role: 'keyframe',
          description: r.dialogue || extractVisualDescription(r).slice(0, 200),
          prompt: r.framePrompt,
        },
        { x: COL.keyframe, y },
        KF_SIZE,
      )
      keyframeNodeId = nodeId
      for (const src of new Set(usedNodeIds)) link(src, nodeId)
    }

    // Beat video node.
    let beatVideoNodeId = ''
    if (r.videoUrl) {
      videos++
      const { nodeId } = pushItem(
        {
          kind: 'video',
          name: `${shotNumber} 镜头视频`,
          content: r.videoUrl,
          role: 'beat-video',
          description: r.dialogue,
          prompt: r.shotPrompt || r.displayPrompt,
        },
        { x: COL.video, y },
        VIDEO_SIZE,
      )
      beatVideoNodeId = nodeId
      if (keyframeNodeId) link(keyframeNodeId, nodeId)
    }

    const row: StoryboardRow = normalizeRowSlots({
      id: makeId(),
      createdAt: now + i,
      shot_number: shotNumber,
      duration: clampDuration(r.durationSeconds),
      status: 'todo',
      visual_description: extractVisualDescription(r),
      reference_image: r.keyframeUrl,
      shot_size: r.shotType,
      character_actions: '',
      emotion_mood: '',
      emotion_atmosphere: '',
      character_motivation: '',
      character_psychology: '',
      performance_guidance: '',
      scene_tags: scene.description,
      lighting_atmosphere: '',
      sound_effects: '',
      mixing_brief: '',
      dialogue: r.dialogue,
      transition_note: '',
      storyboard_prompts: r.framePrompt,
      motion_prompts: r.shotPrompt || r.displayPrompt,
      bgm: '',
      visual_anchor: r.episodeTitle,
      character1: { ...EMPTY_ELEMENT_SLOT },
      character2: { ...EMPTY_ELEMENT_SLOT },
      prop1: { ...EMPTY_ELEMENT_SLOT },
      prop2: { ...EMPTY_ELEMENT_SLOT },
      characters,
      props,
      scene,
      keyframeUrl: r.keyframeUrl,
      keyframeNodeId,
      beatVideoUrl: r.videoUrl,
      beatVideoNodeId,
    })
    rows.push(row)
  })

  return {
    items,
    nodes,
    edges,
    rows,
    summary: {
      assets: assetCount,
      keyframes,
      videos,
      rows: rows.length,
      scripts,
      linkedSlots,
      referenceOnlyImages: nodeByRefUrl.size,
    },
  }
}
