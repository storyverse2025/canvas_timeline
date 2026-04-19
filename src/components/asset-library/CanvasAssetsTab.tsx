import { useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useProjectDB, type ElementRole } from '@/stores/project-db'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { AssetCard } from './AssetCard'
import { CategoryFilter } from './CategoryFilter'
import type { Element } from '@/stores/project-db'

/**
 * Tab 1: Shows all image elements currently on the canvas.
 * Merges data from both ProjectDB.elements and legacy canvas-item-store.
 */
export function CanvasAssetsTab() {
  const [filter, setFilter] = useState<ElementRole | 'all'>('all')
  const dbElements = useProjectDB((s) => s.elements)
  const dbNodes = useProjectDB((s) => s.canvasNodes)

  // Also read from legacy stores for backward compat
  const legacyItems = useCanvasItemStore((s) => s.items)
  const legacyNodes = useCanvasStore((s) => s.nodes)

  const rf = useReactFlow()

  const elements = useMemo(() => {
    const result: (Element & { canvasNodeId?: string })[] = []
    const seen = new Set<string>()

    // From ProjectDB
    for (const node of Object.values(dbNodes)) {
      const el = dbElements[node.elementId]
      if (el && el.kind === 'image' && !seen.has(el.id)) {
        seen.add(el.id)
        result.push({ ...el, canvasNodeId: node.id })
      }
    }

    // From legacy canvas-item-store (items that are on canvas but not in ProjectDB)
    for (const legacyNode of legacyNodes) {
      const itemId = legacyNode.data?.itemId
      if (!itemId) continue
      const item = legacyItems[itemId]
      if (!item || item.kind !== 'image' || !item.content) continue
      if (seen.has(itemId)) continue
      seen.add(itemId)
      result.push({
        id: itemId,
        kind: 'image',
        role: guessRole(item.name),
        name: item.name,
        content: item.content,
        description: '',
        source: 'manual',
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        canvasNodeId: legacyNode.id,
      })
    }

    if (filter !== 'all') return result.filter((e) => e.role === filter)
    return result
  }, [dbElements, dbNodes, legacyItems, legacyNodes, filter])

  const handleLocate = (canvasNodeId: string) => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === canvasNodeId)
    if (!node) return
    const w = (node.style?.width as number) ?? node.width ?? 240
    const h = (node.style?.height as number) ?? node.height ?? 160
    rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1.4, duration: 350 })
  }

  const handleDragStart = (e: React.DragEvent, el: Element) => {
    e.dataTransfer.setData('application/asset-element', JSON.stringify({
      kind: el.kind, name: el.name, content: el.content, role: el.role,
    }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="flex flex-col h-full">
      <CategoryFilter value={filter} onChange={setFilter} />
      {elements.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-4 text-center">
          画布上没有{filter === 'all' ? '' : `${filter === 'character' ? '角色' : filter === 'scene' ? '场景' : '道具'}`}图片
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-2">
          <div className="grid grid-cols-2 gap-2">
            {elements.map((el) => (
              <AssetCard
                key={el.id}
                element={el}
                onLocate={el.canvasNodeId ? () => handleLocate(el.canvasNodeId!) : undefined}
                onDragStart={(e) => handleDragStart(e, el)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function guessRole(name: string): ElementRole {
  const n = name.toLowerCase()
  if (/角色|character|人物|主角/.test(n)) return 'character'
  if (/道具|prop|物品/.test(n)) return 'prop'
  if (/场景|scene|背景/.test(n)) return 'scene'
  if (/keyframe|kf-|分镜/.test(n)) return 'keyframe'
  return 'unknown'
}
