/**
 * Scene + Prop description canvas text nodes.
 *
 * After art-director extracts scenes / props and canvas-elements creates
 * their image placeholders, these spawners drop a matching text node onto
 * the canvas holding the raw description fields (location / mood /
 * lighting for scenes; description / function / material cues for props)
 * + the image_prompt the art-director will hand to the image model.
 *
 * Each text node is edge-wired from its image canvas node so the canvas
 * graph reads as "this image was rendered from this description".
 *
 * Pattern mirrors character-design.spawnCharacterBioCanvasNodes; the
 * shared findItemNodeByRoleAndName helper would belong in a tiny
 * canvas-helpers module if a third site ever needs it.
 */

import type { ExtractedProp, ExtractedScene } from '@/lib/canvas-elements'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'

const SCENE_DESC_ROLE = 'scene-description' as const
const PROP_DESC_ROLE = 'prop-description' as const

/**
 * Find the canvas node that owns an image canvas item with the given
 * role + name. Returns undefined if either no matching item exists or no
 * canvas node has been mounted for it yet.
 */
function findImageNodeByRoleAndName(role: 'character' | 'scene' | 'prop', name: string): string | undefined {
  const items = useCanvasItemStore.getState().items
  const target = Object.values(items).find(
    (it) =>
      it.kind === 'image' &&
      it.role === role &&
      it.name.trim().toLowerCase() === name.trim().toLowerCase(),
  )
  if (!target) return undefined
  const node = useCanvasStore.getState().nodes.find((n) => {
    const data = n.data as { itemId?: string }
    return data.itemId === target.id
  })
  return node?.id
}

/**
 * Idempotent spawn + edge-wire of a single text node for one asset.
 * Updates existing item content on re-runs; never duplicates nodes/edges.
 */
function upsertDescriptionNode(opts: {
  textItemName: string
  content: string
  role: typeof SCENE_DESC_ROLE | typeof PROP_DESC_ROLE
  imageNodeId: string | undefined
  position: { x: number; y: number }
  size: { width: number; height: number }
}): void {
  const items = useCanvasItemStore.getState().items
  const existingItem = Object.values(items).find(
    (it) => it.kind === 'text' && it.role === opts.role && it.name === opts.textItemName,
  )

  let textItemId: string
  if (existingItem) {
    textItemId = existingItem.id
    if (existingItem.content !== opts.content) {
      useCanvasItemStore.getState().updateItem(textItemId, { content: opts.content })
    }
  } else {
    textItemId = useCanvasItemStore.getState().addItem({
      kind: 'text',
      name: opts.textItemName,
      content: opts.content,
      role: opts.role,
    })
  }

  // Find or create the canvas node for the text item.
  const existingTextNode = useCanvasStore.getState().nodes.find((n) => {
    const data = n.data as { itemId?: string }
    return data.itemId === textItemId
  })
  const textNodeId =
    existingTextNode?.id ??
    useCanvasStore.getState().addItemNode(textItemId, 'text', opts.position, opts.size)

  // Wire description text → image so the text is UPSTREAM. The image's
  // NodeEditPanel.regenerate then pulls this text content into the
  // regen prompt via gatherUpstream. Migrate any older session that
  // wired it the wrong way (image → text).
  if (opts.imageNodeId) {
    const reverseEdgeId = useCanvasStore
      .getState()
      .edges.find((e) => e.source === opts.imageNodeId && e.target === textNodeId)?.id
    if (reverseEdgeId) {
      useCanvasStore.getState().setEdges(
        useCanvasStore.getState().edges.filter((e) => e.id !== reverseEdgeId),
      )
    }
    const existing = useCanvasStore
      .getState()
      .edges.find((e) => e.source === textNodeId && e.target === opts.imageNodeId)
    if (!existing) {
      useCanvasStore.getState().addEdge(textNodeId, opts.imageNodeId)
    }
  }
}

export function formatSceneDescriptionBody(scene: ExtractedScene): string {
  const sections: string[] = []
  sections.push(`# ${scene.name}`)
  sections.push('## 场景描述 / Scene Description')
  if (scene.location) sections.push(`地点 / Location: ${scene.location}`)
  if (scene.lighting) sections.push(`光线 / Lighting: ${scene.lighting}`)
  if (scene.mood) sections.push(`氛围 / Mood: ${scene.mood}`)
  if (scene.image_prompt) {
    sections.push('')
    sections.push('## 图像 Prompt (可复制) / Image Prompt')
    sections.push(scene.image_prompt)
  }
  return sections.join('\n')
}

export function formatPropDescriptionBody(prop: ExtractedProp): string {
  const sections: string[] = []
  sections.push(`# ${prop.name}`)
  sections.push('## 道具描述 / Prop Description')
  if (prop.description) sections.push(prop.description)
  if (prop.image_prompt) {
    sections.push('')
    sections.push('## 图像 Prompt (可复制) / Image Prompt')
    sections.push(prop.image_prompt)
  }
  return sections.join('\n')
}

/**
 * Per-scene description text canvas node, wired from its 360° panorama
 * image node. Mirrors spawnCharacterBioCanvasNodes' idempotency contract:
 * existing items get content updates, never duplicate nodes / edges.
 *
 * Call AFTER ensureElements has created the scene image placeholders, so
 * the edge has somewhere to attach.
 */
export function spawnSceneDescriptionCanvasNodes(scenes: ExtractedScene[]): void {
  let stagger = 0
  for (const scene of scenes) {
    const imageNodeId = findImageNodeByRoleAndName('scene', scene.name)
    upsertDescriptionNode({
      textItemName: `${scene.name} · 场景描述`,
      content: formatSceneDescriptionBody(scene),
      role: SCENE_DESC_ROLE,
      imageNodeId,
      // Place to the LEFT of the scene panoramas so text is upstream.
      // Scenes spawn at x=50; description width 340 + 30 gap → x = -320.
      position: { x: -320, y: 500 + stagger * 240 },
      size: { width: 340, height: 220 },
    })
    stagger++
  }
}

/**
 * Per-prop description text canvas node, wired from its prop image node.
 * Same idempotent contract as the scene spawner.
 */
export function spawnPropDescriptionCanvasNodes(props: ExtractedProp[]): void {
  let stagger = 0
  for (const prop of props) {
    const imageNodeId = findImageNodeByRoleAndName('prop', prop.name)
    upsertDescriptionNode({
      textItemName: `${prop.name} · 道具描述`,
      content: formatPropDescriptionBody(prop),
      role: PROP_DESC_ROLE,
      imageNodeId,
      // Place to the LEFT of the prop images so text is upstream.
      // Props spawn at x=50; description width 320 + 30 gap → x = -300.
      position: { x: -300, y: 950 + stagger * 240 },
      size: { width: 320, height: 200 },
    })
    stagger++
  }
}
