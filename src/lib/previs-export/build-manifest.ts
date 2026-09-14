import type { Node } from '@xyflow/react'
import type { CanvasItem } from '@/stores/canvas-item-store'
import type { CanvasNodeGeometry } from '@/stores/canvas-store'
import type { ElementSlot, StoryboardRow } from '@/types/storyboard'
import { rowCharacters, rowProps } from '@/types/storyboard'

/**
 * Canvas selection → StoryverseManifest for the 3D 导演台 (storyai-director-studio).
 *
 * The director studio's whole previs pipeline (reference-image import, rule
 * draft staging, build, render) is keyed on the storyverse manifest shape, so
 * instead of teaching it a new input format we export the canvas in that shape
 * and hand it to `import_manifest`. See docs/plans/2026-09-13-canvas-previs-node.md.
 *
 * Pure: no store access, no I/O. The server plugin copies `images[]` into the
 * studio's `public/canvas-import/<shortId>/` so every `legacyImageUrl` here is
 * same-origin for the studio's browser (no CORS, no self-signed cert, no nginx).
 *
 * Manifest conventions mirrored from the studio's fixture:
 *   - characters are referenced by `key` (`base_character_<slug>`),
 *     environments / props by `id`;
 *   - `continuity.characterPositions` decides who draft staging puts in a beat,
 *     so every present character gets an entry even with empty positions.
 */

export type PrevisCategory = 'character' | 'environment' | 'property'

export interface PrevisManifestAsset {
  id: string
  key: string
  category: PrevisCategory
  name: string
  role: string | null
  prompt: string
  persona: Record<string, unknown>
  storagePath: null
  legacyImageUrl: string
  faceBoxes: never[]
}

export interface PrevisManifestBeat {
  beat: number
  shotId: string
  duration: number
  prompt: string
  dialogue: { speaker: string | null; content: string; timecode: string | null }[]
  storyboardImageUrl: string | null
  actionDescription: string | null
  continuity: {
    environment: string | null
    props: string[]
    characterPositions: { characterId: string; startPosition: string; endPosition: string }[]
  }
  imageReferences: { tag: string; index: number; assetId: string; identifier: string }[]
  rhythm: null
}

export interface PrevisManifest {
  schemaVersion: 1
  sourceUrl: string
  fetchedAt: string
  project: { id: string; title: string; settings: Record<string, unknown>; aspectRatio: string }
  episode: { id: string; title: string; number: number }
  assets: PrevisManifestAsset[]
  assetDefinitions: {
    characters: { assetId: string; description: string; assetIdentifier: string }[]
    environments: { assetId: string; description: string; keyPositions: { positionName: string; description: string }[] }[]
    props: { assetId: string; description: string; assetIdentifier: string }[]
  }
  beats: PrevisManifestBeat[]
}

/** A file the server must place at `public/canvas-import/<shortId>/<file>`. */
export interface PrevisImageCopy {
  /** Canvas content URL: `/uploads/...`, `http(s)://...` or `data:` */
  source: string
  file: string
}

export interface BuildPrevisManifestInput {
  /** uuid; its first 8 alnum chars are the studio's work dir / shortId. */
  runId: string
  videoNodeIds: string[]
  /** Extra selected asset nodes (characters / environments / props). */
  assetNodeIds: string[]
  nodes: Node<CanvasNodeGeometry>[]
  items: Record<string, CanvasItem>
  rows: StoryboardRow[]
  title?: string
  aspectRatio?: string
  now?: Date
}

export interface BuildPrevisManifestResult {
  manifest: PrevisManifest
  shortId: string
  images: PrevisImageCopy[]
  warnings: string[]
}

export class PrevisManifestError extends Error {}

/** Same rule as the studio's `shortProjectId`. */
export function shortIdOf(runId: string): string {
  return runId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8).toLowerCase()
}

export function categoryOfRole(role: CanvasItem['role']): PrevisCategory | null {
  switch (role) {
    case 'character': return 'character'
    case 'scene':
    case 'scene-view': return 'environment'
    case 'prop': return 'property'
    default: return null
  }
}

function slug(text: string): string {
  const ascii = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return ascii.slice(0, 32)
}

function extOf(url: string): string {
  if (url.startsWith('data:image/jpeg') || url.startsWith('data:image/jpg')) return '.jpg'
  if (url.startsWith('data:image/webp')) return '.webp'
  if (url.startsWith('data:')) return '.png'
  const m = url.split('?')[0].match(/\.(png|jpe?g|webp)$/i)
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.png'
}

function isCopyableImage(url: string): boolean {
  return url.startsWith('/uploads/') || /^https?:\/\//i.test(url) || url.startsWith('data:image/')
}

/** `Zachary: Look who came crawling back. Charlie: I've learned…` → per-speaker lines. */
export function parseDialogue(
  text: string,
  speakerKeyOf: (name: string) => string | null,
): PrevisManifestBeat['dialogue'] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const out: PrevisManifestBeat['dialogue'] = []
  // Split on "Name:" / "Name：" boundaries (name = up to 24 non-colon chars at a line/sentence start).
  const re = /(?:^|\n|(?<=[.!?。！？…"”]\s))([^:：\n.!?。！？]{1,24})[:：]\s*/g
  const marks: { index: number; end: number; name: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed))) marks.push({ index: m.index, end: re.lastIndex, name: m[1].trim() })
  if (marks.length === 0) return [{ speaker: null, content: trimmed, timecode: null }]
  if (marks[0].index > 0) {
    const lead = trimmed.slice(0, marks[0].index).trim()
    if (lead) out.push({ speaker: null, content: lead, timecode: null })
  }
  marks.forEach((mark, i) => {
    const content = trimmed.slice(mark.end, marks[i + 1]?.index ?? trimmed.length).trim()
    if (content) out.push({ speaker: speakerKeyOf(mark.name), content, timecode: null })
  })
  return out
}

export function buildPrevisManifest(input: BuildPrevisManifestInput): BuildPrevisManifestResult {
  const warnings: string[] = []
  const shortId = shortIdOf(input.runId)
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]))
  const itemOfNode = (nodeId: string): CanvasItem | undefined => {
    const itemId = nodeById.get(nodeId)?.data?.itemId
    return itemId ? input.items[String(itemId)] : undefined
  }

  // ─── assets, deduped by canvas item id ───
  const assets: PrevisManifestAsset[] = []
  const assetByItemId = new Map<string, PrevisManifestAsset>()
  const images: PrevisImageCopy[] = []
  const usedKeys = new Set<string>()

  const ensureAsset = (item: CanvasItem, category: PrevisCategory): PrevisManifestAsset | null => {
    const existing = assetByItemId.get(item.id)
    if (existing) return existing
    if (item.kind !== 'image' || !item.content || !isCopyableImage(item.content)) {
      warnings.push(`素材「${item.name}」没有可用图片，已跳过`)
      return null
    }
    let key = item.id
    if (category === 'character') {
      const base = `base_character_${slug(item.name) || 'char'}`
      key = base
      for (let n = 2; usedKeys.has(key); n++) key = `${base}_${n}`
    }
    usedKeys.add(key)
    const file = `${String(assets.length + 1).padStart(2, '0')}-${category}${extOf(item.content)}`
    images.push({ source: item.content, file })
    const prompt = (item.prompt || item.description || item.name).trim()
    const asset: PrevisManifestAsset = {
      id: item.id,
      key,
      category,
      name: item.name,
      role: null,
      prompt,
      persona: {},
      storagePath: null,
      legacyImageUrl: `/canvas-import/${shortId}/${file}`,
      faceBoxes: [],
    }
    assets.push(asset)
    assetByItemId.set(item.id, asset)
    return asset
  }

  const assetFromSlot = (slot: ElementSlot, category: PrevisCategory): PrevisManifestAsset | null => {
    if (!slot.nodeId) {
      if (slot.description || slot.image) warnings.push(`分镜槽位「${slot.description || '未命名'}」没有连到画布节点，已跳过`)
      return null
    }
    const item = itemOfNode(slot.nodeId)
    if (!item) return null
    return ensureAsset(item, category)
  }

  // Explicitly selected asset nodes go into the library regardless of beats.
  const selectedAssets: PrevisManifestAsset[] = []
  for (const nodeId of input.assetNodeIds) {
    const item = itemOfNode(nodeId)
    if (!item) continue
    const category = categoryOfRole(item.role)
    if (!category) {
      warnings.push(`节点「${item.name}」不是角色 / 场景 / 道具素材，已忽略`)
      continue
    }
    const asset = ensureAsset(item, category)
    if (asset) selectedAssets.push(asset)
  }

  // ─── beats, in storyboard order ───
  const rowIndex = new Map(input.rows.map((r, i) => [r.id, i]))
  const videos = input.videoNodeIds
    .map((nodeId, selectionOrder) => {
      const item = itemOfNode(nodeId)
      if (!item || item.kind !== 'video') return null
      const row = input.rows.find((r) => r.beatVideoNodeId === nodeId)
        ?? input.rows.find((r) => !!item.content && r.beatVideoUrl === item.content)
      return { nodeId, item, row, order: row ? rowIndex.get(row.id)! : input.rows.length + selectionOrder }
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => a.order - b.order)

  if (videos.length === 0) throw new PrevisManifestError('请至少选中一个镜头视频节点')

  const beats: PrevisManifestBeat[] = videos.map((video, i) => {
    const { item, row } = video
    if (!row) warnings.push(`视频「${item.name}」没有对应的分镜行，只用它的 prompt 和选中的素材`)

    let characters: PrevisManifestAsset[] = []
    let props: PrevisManifestAsset[] = []
    let environment: PrevisManifestAsset | null = null
    if (row) {
      characters = rowCharacters(row).map((s) => assetFromSlot(s, 'character')).filter((a): a is PrevisManifestAsset => !!a)
      props = rowProps(row).map((s) => assetFromSlot(s, 'property')).filter((a): a is PrevisManifestAsset => !!a)
      environment = row.scene ? assetFromSlot(row.scene, 'environment') : null
    }
    // Fall back to the explicit selection for whatever the row didn't provide.
    if (characters.length === 0) characters = selectedAssets.filter((a) => a.category === 'character')
    if (props.length === 0) props = selectedAssets.filter((a) => a.category === 'property')
    if (!environment) environment = selectedAssets.find((a) => a.category === 'environment') ?? null

    const imageReferences: PrevisManifestBeat['imageReferences'] = []
    const pushRef = (tag: string, a: PrevisManifestAsset) =>
      imageReferences.push({ tag, index: imageReferences.length + 1, assetId: a.key, identifier: a.name })
    characters.forEach((a, n) => pushRef(`char${n + 1}`, a))
    if (environment) pushRef('scene', environment)
    props.forEach((a, n) => pushRef(`prop${n + 1}`, a))

    let storyboardImageUrl: string | null = null
    const keyframe = row?.keyframeUrl || row?.reference_image || ''
    if (keyframe && isCopyableImage(keyframe)) {
      const file = `beat${String(i + 1).padStart(2, '0')}-storyboard${extOf(keyframe)}`
      images.push({ source: keyframe, file })
      storyboardImageUrl = `/canvas-import/${shortId}/${file}`
    }

    const speakerKeyOf = (name: string) => {
      const n = name.trim().toLowerCase()
      return characters.find((c) => c.name.trim().toLowerCase() === n)?.key
        ?? assets.find((c) => c.category === 'character' && c.name.trim().toLowerCase() === n)?.key
        ?? null
    }

    return {
      beat: i + 1,
      shotId: row?.id ?? item.id,
      duration: Math.max(0.5, Number(row?.duration) || 5),
      prompt: (item.prompt || row?.motion_prompts || row?.visual_description || '').trim(),
      dialogue: parseDialogue(row?.dialogue ?? '', speakerKeyOf),
      storyboardImageUrl,
      actionDescription: (row?.character_actions || row?.visual_description || '').trim() || null,
      continuity: {
        environment: environment?.id ?? null,
        props: props.map((a) => a.id),
        characterPositions: characters.map((a) => ({ characterId: a.key, startPosition: '', endPosition: '' })),
      },
      imageReferences,
      rhythm: null,
    }
  })

  if (!assets.some((a) => a.category === 'character')) {
    throw new PrevisManifestError('至少需要一个角色素材：选中角色节点，或让分镜行的角色槽位连到画布上的角色图')
  }
  if (!beats.some((b) => b.prompt)) warnings.push('选中的视频都没有 prompt，3D 分镜只能按分镜表文字推断')

  const title = input.title?.trim() || 'Canvas 3D 预演'
  const manifest: PrevisManifest = {
    schemaVersion: 1,
    sourceUrl: `canvas://${input.runId}`,
    fetchedAt: (input.now ?? new Date()).toISOString(),
    project: { id: input.runId, title, settings: { source: 'canvas_timeline' }, aspectRatio: input.aspectRatio || '16:9' },
    episode: { id: input.runId, title, number: 1 },
    assets,
    assetDefinitions: {
      characters: assets.filter((a) => a.category === 'character').map((a) => ({ assetId: a.key, description: a.prompt, assetIdentifier: a.name })),
      environments: assets.filter((a) => a.category === 'environment').map((a) => ({ assetId: a.id, description: a.prompt, keyPositions: [] })),
      props: assets.filter((a) => a.category === 'property').map((a) => ({ assetId: a.id, description: a.prompt, assetIdentifier: a.name })),
    },
    beats,
  }
  return { manifest, shortId, images, warnings }
}
