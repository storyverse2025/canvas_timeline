import { User, MapPin, Package, Film, Trash2, ImageIcon, Type, Sparkles, LayoutGrid } from 'lucide-react'
import { useReactFlow } from '@xyflow/react'
import { resolveOverlaps } from '@/lib/canvas-layout'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useViewStore } from '@/stores/view-store'
import type { AssetType } from '@/types/asset'

const ASSET_TYPES: { type: AssetType; label: string; Icon: React.ElementType }[] = [
  { type: 'character', label: '添加角色', Icon: User },
  { type: 'scene',     label: '添加场景', Icon: MapPin },
  { type: 'prop',      label: '添加物品', Icon: Package },
  { type: 'keyframe',  label: '添加关键帧', Icon: Film },
]

function randomPosition() {
  return {
    x: 80 + Math.random() * 400,
    y: 80 + Math.random() * 200,
  }
}

export function AssetCanvasToolbar() {
  const addAsset = useAssetStore((s) => s.addAsset)
  const removeAsset = useAssetStore((s) => s.removeAsset)
  const addNode = useCanvasStore((s) => s.addNode)
  const addItemNode = useCanvasStore((s) => s.addItemNode)
  const storeAddEdge = useCanvasStore((s) => s.addEdge)
  const removeNodeByAssetId = useCanvasStore((s) => s.removeNodeByAssetId)
  const addItem = useCanvasItemStore((s) => s.addItem)
  const rf = useReactFlow()
  const selectedAssetIds = useViewStore((s) => s.selectedAssetIds)
  const clearSelection = useViewStore((s) => s.clearSelection)

  const handleAdd = (type: AssetType, label: string) => {
    const assetId = addAsset({ type, name: label, tags: [] })
    addNode(assetId, randomPosition())
  }

  const handleAddImage = () => {
    const id = addItem({ kind: 'image', name: '图片节点', content: '' })
    addItemNode(id, 'image', randomPosition())
  }

  const handleAddText = () => {
    const id = addItem({ kind: 'text', name: '文本节点', content: '' })
    addItemNode(id, 'text', randomPosition())
  }

  const handleLoadSample = async () => {
    try {
      const res = await fetch('/samples/manifest.json')
      const manifest: {
        images: { libId: string; name: string; file: string; width: number; height: number; x: number; y: number }[];
        texts: { libId: string; name: string; content: string; width: number; height: number; x: number; y: number }[];
        edges: { source: string; target: string }[];
      } = await res.json()
      const idMap = new Map<string, string>()
      for (const img of manifest.images) {
        const itemId = addItem({ kind: 'image', name: img.name, content: img.file })
        const nodeId = addItemNode(itemId, 'image', { x: img.x, y: img.y }, { width: img.width, height: img.height })
        idMap.set(img.libId, nodeId)
      }
      for (const t of manifest.texts) {
        const itemId = addItem({ kind: 'text', name: t.name, content: t.content })
        const nodeId = addItemNode(itemId, 'text', { x: t.x, y: t.y }, { width: t.width, height: t.height })
        idMap.set(t.libId, nodeId)
      }
      for (const e of manifest.edges ?? []) {
        const s = idMap.get(e.source); const t = idMap.get(e.target)
        if (s && t) storeAddEdge(s, t)
      }
      setTimeout(() => {
        relayout()
        rf.fitView({ padding: 0.15, duration: 400 })
      }, 80)
    } catch (e) {
      console.error('load sample failed', e)
    }
  }

  const relayout = () => {
    const setNodes = useCanvasStore.getState().setNodes
    const current = useCanvasStore.getState().nodes
    const fixed = resolveOverlaps(current as never, { padding: 40, iterations: 120 })
    setNodes(fixed as typeof current)
  }

  const handleRelayout = () => {
    relayout()
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 400 }), 50)
  }

  const handleDelete = () => {
    for (const id of selectedAssetIds) {
      removeNodeByAssetId(id)
      removeAsset(id)
    }
    clearSelection()
  }

  return (
    <TooltipProvider>
      <div className="absolute top-3 left-3 z-10 flex flex-col gap-1">
        {ASSET_TYPES.map(({ type, label, Icon }) => (
          <Tooltip key={type}>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className="h-8 w-8 shadow-md"
                onClick={() => handleAdd(type, `新${label.replace('添加', '')}`)}
              >
                <Icon className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        ))}

        <div className="w-px h-2 mx-auto bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" className="h-8 w-8 shadow-md" onClick={handleAddImage}>
              <ImageIcon className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">添加图片</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" className="h-8 w-8 shadow-md" onClick={handleAddText}>
              <Type className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">添加文本</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" className="h-8 w-8 shadow-md" onClick={handleLoadSample}>
              <Sparkles className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">加载 libTV 示例</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" className="h-8 w-8 shadow-md" onClick={handleRelayout}>
              <LayoutGrid className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">整理布局（避免重叠）</TooltipContent>
        </Tooltip>

        {selectedAssetIds.length > 0 && (
          <>
            <div className="w-px h-2 mx-auto bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="destructive"
                  size="icon"
                  className="h-8 w-8 shadow-md"
                  onClick={handleDelete}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                删除选中 ({selectedAssetIds.length})
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
