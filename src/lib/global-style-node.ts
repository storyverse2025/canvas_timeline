/**
 * Global "art style" canvas node.
 *
 * Surfaces the current art direction (preset + custom style + image model)
 * as a single text node on the canvas, with edges drawn from it to every
 * visual asset / image node so users can see at a glance what style prompt
 * informs the generations downstream.
 *
 * The node is identified by `item.role === 'style'`. Initial content is
 * pulled from `useProjectDB.artDirection`; subsequent calls don't overwrite
 * the user's edits — the node is theirs to refine.
 */

import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useProjectDB } from '@/stores/project-db'
import { formatStyleGuide, getStylePreset, isPhotorealRiskPreset } from '@/lib/style-library'

const STYLE_NODE_POS = { x: 20, y: 20 }
const STYLE_NODE_SIZE = { width: 360, height: 260 }

export function buildGlobalStyleDefinition(): string {
  const ad = useProjectDB.getState().artDirection
  const preset = getStylePreset(ad.stylePreset)
  const parts: string[] = []

  parts.push('🎨 全局风格 / Global Art Style')
  parts.push(`${preset.label}`)
  parts.push(`style_id: ${preset.style_id}`)
  parts.push(`category: ${preset.category}`)
  parts.push(`source: ${preset.source}`)
  parts.push(`requested_preset: ${ad.stylePreset || '(none)'}`)
  if (isPhotorealRiskPreset(preset.style_id)) {
    parts.push('safety_rider: 3D CG stylized / UE5 — keep facial detail, avoid being read as a photographed real actor.')
  }
  parts.push(`Image model: ${ad.defaultImageModel}`)
  parts.push(`Video model: ${ad.defaultVideoModel}`)
  parts.push(`Aspect: ${ad.defaultAspectRatio}`)
  parts.push('')
  parts.push('Production Pack / global_style_guide:')
  parts.push(...formatStyleGuide(preset))
  if (ad.customStyle) {
    parts.push('')
    parts.push(`Custom override: ${ad.customStyle}`)
  }
  parts.push('')
  parts.push('Usage: pass this style guide into casting, asset, storyboard, keyframe, and video agents; preserve user edits on this node.')
  parts.push('（此节点会自动连接到画布上的所有资产，作为它们的风格参考。可以直接编辑。）')
  return parts.join('\n')
}

/**
 * Find or create the canvas node for the global style. Returns the node id.
 * Only creates content from `artDirection` on first creation; existing nodes
 * keep whatever the user has edited into them.
 */
export function ensureGlobalStyleNode(): string {
  const canvas = useCanvasStore.getState()
  const items = useCanvasItemStore.getState().items
  for (const n of canvas.nodes) {
    const itemId = (n.data as { itemId?: string }).itemId
    if (!itemId) continue
    const it = items[itemId]
    if (it && it.role === 'style') return n.id
  }
  const itemId = useCanvasItemStore.getState().addItem({
    kind: 'text',
    name: '全局风格',
    content: buildGlobalStyleDefinition(),
    role: 'style',
  })
  return useCanvasStore.getState().addItemNode(itemId, 'text', STYLE_NODE_POS, STYLE_NODE_SIZE)
}

/** True iff the node represents something that should be styled by the global text. */
function isStylableTarget(node: { id: string; data: Record<string, unknown> }): boolean {
  const data = node.data as { assetId?: string; itemId?: string }
  if (data.assetId) return true // character / scene / prop / keyframe
  if (data.itemId) {
    const it = useCanvasItemStore.getState().items[data.itemId]
    if (it && it.role === 'style') return false // don't connect style → style
    if (it && it.kind === 'image') return true
  }
  return false
}

/**
 * Ensure the style node exists and that there's an edge from it to every
 * visual asset / image node currently on the canvas. Returns counts so the
 * caller can surface a "linked N nodes" toast.
 */
export function connectStyleToAllAssets(): { styleNodeId: string; linked: number } {
  const styleNodeId = ensureGlobalStyleNode()
  const canvas = useCanvasStore.getState()
  const existing = new Set(
    canvas.edges.filter((e) => e.source === styleNodeId).map((e) => e.target),
  )
  let linked = 0
  for (const n of canvas.nodes) {
    if (n.id === styleNodeId) continue
    if (existing.has(n.id)) continue
    if (!isStylableTarget(n as { id: string; data: Record<string, unknown> })) continue
    canvas.addEdge(styleNodeId, n.id)
    linked++
  }
  return { styleNodeId, linked }
}
