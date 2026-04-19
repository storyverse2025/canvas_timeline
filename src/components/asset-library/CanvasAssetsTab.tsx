import { useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useProjectDB, type ElementRole } from '@/stores/project-db'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useAssetStore } from '@/stores/asset-store'
import { AssetCard } from './AssetCard'
import { CategoryFilter } from './CategoryFilter'
import type { Element } from '@/stores/project-db'

/**
 * Tab 1: Shows all image elements currently on the canvas.
 * Merges data from ProjectDB, legacy canvas-item-store, AND asset-store.
 */
export function CanvasAssetsTab() {
  const [filter, setFilter] = useState<ElementRole | 'all'>('all')
  const dbElements = useProjectDB((s) => s.elements)
  const dbNodes = useProjectDB((s) => s.canvasNodes)

  // Legacy stores for backward compat
  const legacyItems = useCanvasItemStore((s) => s.items)
  const legacyNodes = useCanvasStore((s) => s.nodes)
  const legacyAssets = useAssetStore((s) => s.assets)

  const rf = useReactFlow()

  const elements = useMemo(() => {
    const result: (Element & { canvasNodeId?: string })[] = []
    const seen = new Set<string>()

    // From ProjectDB elements that have canvas nodes
    for (const node of Object.values(dbNodes)) {
      const el = dbElements[node.elementId]
      if (el && el.kind === 'image' && !seen.has(el.id)) {
        seen.add(el.id)
        result.push({ ...el, canvasNodeId: node.id })
      }
    }

    // From legacy canvas nodes — both itemId and assetId types
    const assetMap = new Map(legacyAssets.map((a) => [a.id, a]))

    for (const legacyNode of legacyNodes) {
      // Asset-type nodes (character/scene/prop/keyframe from asset-store)
      const assetId = legacyNode.data?.assetId as string | undefined
      if (assetId && !seen.has(assetId)) {
        const asset = assetMap.get(assetId)
        if (asset) {
          seen.add(assetId)
          result.push({
            id: assetId,
            kind: 'image',
            role: mapAssetType(asset.type),
            name: asset.name,
            content: asset.imageUrl ?? '',
            description: asset.description ?? '',
            source: 'imported',
            createdAt: asset.createdAt,
            updatedAt: asset.createdAt,
            canvasNodeId: legacyNode.id,
          })
        }
      }

      // Item-type nodes (free-form image/text from canvas-item-store)
      const itemId = legacyNode.data?.itemId as string | undefined
      if (itemId && !seen.has(itemId)) {
        const item = legacyItems[itemId]
        if (item && item.kind === 'image' && item.content) {
          seen.add(itemId)
          result.push({
            id: itemId,
            kind: 'image',
            role: guessRole(item.name),
            name: item.name,
            content: item.content,
            description: item.prompt ?? '',
            source: item.provider ? 'generated' : 'manual',
            createdAt: item.createdAt,
            updatedAt: item.createdAt,
            canvasNodeId: legacyNode.id,
          })
        }
      }
    }

    if (filter !== 'all') return result.filter((e) => e.role === filter)
    return result
  }, [dbElements, dbNodes, legacyItems, legacyNodes, legacyAssets, filter])

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
          画布上没有{filter === 'all' ? '' : FILTER_LABELS[filter] ?? ''}图片
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

const FILTER_LABELS: Record<string, string> = {
  character: '角色', prop: '道具', scene: '场景', keyframe: 'KF',
}

/** Map asset-store type to ElementRole */
function mapAssetType(type: string): ElementRole {
  switch (type) {
    case 'character': return 'character'
    case 'scene': return 'scene'
    case 'prop': return 'prop'
    case 'keyframe': return 'keyframe'
    default: return 'unknown'
  }
}

/** Heuristic guess from node name */
function guessRole(name: string): ElementRole {
  const n = name.toLowerCase()
  if (/角色|character|人物|主角|配角|英雄|导师|反派|盟友|hero|villain|mentor|ally/i.test(n)) return 'character'
  if (/道具|prop|物品|武器|工具|item|weapon/i.test(n)) return 'prop'
  if (/场景|scene|背景|环境|地点|location|forest|city|room|森林|城市|房间/i.test(n)) return 'scene'
  if (/keyframe|kf-|分镜|关键帧/i.test(n)) return 'keyframe'
  if (/video|视频|bv-/i.test(n)) return 'beat-video'
  return 'unknown'
}
