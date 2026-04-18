import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'

export interface UpstreamContext {
  texts: string[];
  images: string[];
}

/** BFS upstream from a node, collect text prompts and reference image URLs. */
export function gatherUpstream(nodeId: string): UpstreamContext {
  const { nodes, edges } = useCanvasStore.getState()
  const items = useCanvasItemStore.getState().items
  const assets = useAssetStore.getState().assets

  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    const arr = incoming.get(e.target) ?? []
    arr.push(e.source)
    incoming.set(e.target, arr)
  }

  const texts: string[] = []
  const images: string[] = []
  const visited = new Set<string>()
  const queue = [...(incoming.get(nodeId) ?? [])]

  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const node = nodes.find((n) => n.id === id)
    if (!node) continue

    if (node.data.itemId) {
      const it = items[node.data.itemId]
      if (it) {
        if (it.kind === 'text' && it.content.trim()) texts.push(it.content.trim())
        else if (it.kind === 'image' && it.content) images.push(it.content)
      }
    } else if (node.data.assetId) {
      const a = assets.find((x) => x.id === node.data.assetId)
      if (a?.imageUrl) images.push(a.imageUrl)
      if (a?.description) texts.push(a.description)
      else if (a?.name) texts.push(a.name)
    }

    for (const src of incoming.get(id) ?? []) if (!visited.has(src)) queue.push(src)
  }

  return { texts, images }
}
