import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'

/**
 * Build a text snapshot of the canvas for injection into the LLM system prompt,
 * so the model can answer questions like "based on the canvas, generate a shot list".
 */
export function buildCanvasContext(): string {
  const nodes = useCanvasStore.getState().nodes
  const edges = useCanvasStore.getState().edges
  const items = useCanvasItemStore.getState().items
  const assets = useAssetStore.getState().assets
  const assetMap = new Map(assets.map((a) => [a.id, a]))

  if (nodes.length === 0) return '画布当前为空。'

  const lines: string[] = []
  lines.push(`画布包含 ${nodes.length} 个节点，${edges.length} 条连线。节点清单:`)

  nodes.forEach((n, idx) => {
    const short = n.id.slice(0, 6)
    const x = Math.round(n.position.x)
    const y = Math.round(n.position.y)
    if (n.data.itemId) {
      const it = items[n.data.itemId]
      if (!it) return
      if (it.kind === 'text') {
        const preview = (it.content ?? '').replace(/\s+/g, ' ').slice(0, 200)
        lines.push(`${idx + 1}. [文本 ${short}] "${it.name}" @(${x},${y}) · 内容: ${preview || '(空)'}`)
      } else {
        lines.push(`${idx + 1}. [图片 ${short}] "${it.name}" @(${x},${y}) · URL: ${it.content || '(无)'}`)
      }
    } else if (n.data.assetId) {
      const a = assetMap.get(n.data.assetId)
      if (!a) return
      lines.push(
        `${idx + 1}. [${a.type} ${short}] "${a.name}" @(${x},${y})` +
          (a.description ? ` · ${a.description}` : '') +
          (a.imageUrl ? ` · URL: ${a.imageUrl}` : ''),
      )
    }
  })

  if (edges.length > 0) {
    lines.push('')
    lines.push('连线关系 (source -> target, 用节点 id 前 6 位):')
    for (const e of edges) {
      lines.push(`- ${e.source.slice(0, 6)} -> ${e.target.slice(0, 6)}`)
    }
  }

  return lines.join('\n')
}
