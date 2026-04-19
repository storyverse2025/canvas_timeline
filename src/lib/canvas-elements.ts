import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { runCapability } from '@/lib/capabilities/client'

export type ElementRole = 'character' | 'prop' | 'scene' | 'keyframe' | 'unknown'

export interface ClassifiedElement {
  nodeId: string
  itemId: string
  name: string
  imageUrl: string
  role: ElementRole
  description: string
}

export interface ElementInventory {
  characters: ClassifiedElement[]
  props: ClassifiedElement[]
  scenes: ClassifiedElement[]
  keyframes: ClassifiedElement[]
  unknown: ClassifiedElement[]
}

/** Collect all image nodes from the canvas. */
function getImageNodes(): { nodeId: string; itemId: string; name: string; imageUrl: string }[] {
  const nodes = useCanvasStore.getState().nodes
  const items = useCanvasItemStore.getState().items
  const result: { nodeId: string; itemId: string; name: string; imageUrl: string }[] = []
  for (const n of nodes) {
    if (!n.data.itemId) continue
    const it = items[n.data.itemId]
    if (!it || it.kind !== 'image' || !it.content) continue
    if (/\.(mp4|webm|mov)(\?|$)/i.test(it.content)) continue
    result.push({ nodeId: n.id, itemId: it.id, name: it.name, imageUrl: it.content })
  }
  return result
}

/**
 * Use AI to classify image nodes into roles (character/prop/scene/keyframe).
 * Returns structured inventory.
 */
export async function classifyCanvasElements(): Promise<ElementInventory> {
  const imageNodes = getImageNodes()
  if (imageNodes.length === 0) {
    return { characters: [], props: [], scenes: [], keyframes: [], unknown: [] }
  }

  // Build a summary for the AI to classify
  const nodeList = imageNodes.map((n, i) =>
    `${i + 1}. id="${n.nodeId.slice(0, 8)}" name="${n.name}"`
  ).join('\n')

  const result = await runCapability({
    capability: 'element-extraction',
    inputs: [{ kind: 'text', text:
      `以下是画布上的图片节点列表。请根据节点名称和内容分类每个节点的角色类型。
输出 JSON 数组格式：[{ "id": "节点id前8位", "role": "character|prop|scene|keyframe|unknown", "description": "简短描述" }]
只输出 JSON，不要其他文字。

节点列表：
${nodeList}` }],
  })

  const text = result.outputs[0]?.text ?? ''
  let classifications: { id: string; role: ElementRole; description: string }[] = []
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) classifications = JSON.parse(jsonMatch[0])
  } catch { /* parse failure — all nodes stay unknown */ }

  const inventory: ElementInventory = {
    characters: [], props: [], scenes: [], keyframes: [], unknown: [],
  }

  for (const node of imageNodes) {
    const shortId = node.nodeId.slice(0, 8)
    const cls = classifications.find((c) => shortId.startsWith(c.id) || c.id.startsWith(shortId.slice(0, 6)))
    const role: ElementRole = cls?.role ?? guessRoleFromName(node.name)
    const el: ClassifiedElement = {
      nodeId: node.nodeId,
      itemId: node.itemId,
      name: node.name,
      imageUrl: node.imageUrl,
      role,
      description: cls?.description ?? node.name,
    }
    switch (role) {
      case 'character': inventory.characters.push(el); break
      case 'prop': inventory.props.push(el); break
      case 'scene': inventory.scenes.push(el); break
      case 'keyframe': inventory.keyframes.push(el); break
      default: inventory.unknown.push(el)
    }
  }

  return inventory
}

/** Heuristic: guess role from node name for fallback. */
function guessRoleFromName(name: string): ElementRole {
  const n = name.toLowerCase()
  if (/角色|character|人物|主角|配角|protagonist|actor/.test(n)) return 'character'
  if (/道具|prop|物品|武器|工具/.test(n)) return 'prop'
  if (/场景|scene|背景|环境|location|地点/.test(n)) return 'scene'
  if (/keyframe|kf-|分镜|关键帧/.test(n)) return 'keyframe'
  return 'unknown'
}

/**
 * Check what essential elements are missing and auto-generate them.
 * Returns the final inventory after generation.
 */
export async function ensureElements(
  onStatus: (msg: string) => void,
): Promise<ElementInventory> {
  onStatus('正在分析画布元素…')
  const inventory = await classifyCanvasElements()

  const missing: string[] = []
  if (inventory.characters.length === 0) missing.push('角色')
  if (inventory.scenes.length === 0) missing.push('场景')
  // Props are optional — don't auto-generate

  if (missing.length === 0) {
    onStatus(`画布元素齐全：${inventory.characters.length} 角色, ${inventory.props.length} 道具, ${inventory.scenes.length} 场景`)
    return inventory
  }

  onStatus(`缺少 ${missing.join('、')}，正在自动生成…`)

  // Gather text context from text nodes for prompt
  const items = useCanvasItemStore.getState().items
  const textContent = Object.values(items)
    .filter((it) => it.kind === 'text' && it.content)
    .map((it) => it.content)
    .join('\n')
    .slice(0, 1000)

  const contextHint = textContent || '一个创意短片'

  // Generate missing characters
  if (inventory.characters.length === 0) {
    onStatus('正在生成角色…')
    try {
      const r = await runCapability({
        capability: 'text-to-image',
        inputs: [{ kind: 'text', text: `Character design sheet, full body, front view, detailed character for: ${contextHint}. Professional concept art, white background, clean design` }],
        params: { aspect: '1:1' },
      })
      if (r.outputs[0]?.url) {
        const itemId = useCanvasItemStore.getState().addItem({
          kind: 'image', name: '角色1', content: r.outputs[0].url,
        })
        const nodeId = useCanvasStore.getState().addItemNode(itemId, 'image', { x: 50, y: 50 }, { width: 200, height: 200 })
        inventory.characters.push({
          nodeId, itemId, name: '角色1',
          imageUrl: r.outputs[0].url, role: 'character', description: '自动生成的角色',
        })
      }
    } catch (e) {
      onStatus(`角色生成失败: ${(e as Error).message}`)
    }
  }

  // Generate missing scene
  if (inventory.scenes.length === 0) {
    onStatus('正在生成场景…')
    try {
      const r = await runCapability({
        capability: 'text-to-image',
        inputs: [{ kind: 'text', text: `Cinematic wide establishing shot, detailed environment for: ${contextHint}. Professional matte painting, dramatic lighting, 16:9` }],
        params: { aspect: '16:9' },
      })
      if (r.outputs[0]?.url) {
        const itemId = useCanvasItemStore.getState().addItem({
          kind: 'image', name: '场景', content: r.outputs[0].url,
        })
        const nodeId = useCanvasStore.getState().addItemNode(itemId, 'image', { x: 50, y: 300 }, { width: 320, height: 180 })
        inventory.scenes.push({
          nodeId, itemId, name: '场景',
          imageUrl: r.outputs[0].url, role: 'scene', description: '自动生成的场景',
        })
      }
    } catch (e) {
      onStatus(`场景生成失败: ${(e as Error).message}`)
    }
  }

  onStatus(`元素准备完成：${inventory.characters.length} 角色, ${inventory.props.length} 道具, ${inventory.scenes.length} 场景`)
  return inventory
}

/** Build element context string for the storyboard generation prompt. */
export function buildElementContext(inv: ElementInventory): string {
  const lines: string[] = []
  if (inv.characters.length > 0) {
    lines.push('## 角色 Characters')
    inv.characters.forEach((c, i) => {
      lines.push(`${i + 1}. "${c.name}" [node:${c.nodeId.slice(0, 6)}] — ${c.description} — image: ${c.imageUrl.slice(0, 100)}`)
    })
  }
  if (inv.props.length > 0) {
    lines.push('## 道具 Props')
    inv.props.forEach((p, i) => {
      lines.push(`${i + 1}. "${p.name}" [node:${p.nodeId.slice(0, 6)}] — ${p.description} — image: ${p.imageUrl.slice(0, 100)}`)
    })
  }
  if (inv.scenes.length > 0) {
    lines.push('## 场景 Scenes')
    inv.scenes.forEach((s, i) => {
      lines.push(`${i + 1}. "${s.name}" [node:${s.nodeId.slice(0, 6)}] — ${s.description} — image: ${s.imageUrl.slice(0, 100)}`)
    })
  }
  return lines.join('\n')
}
