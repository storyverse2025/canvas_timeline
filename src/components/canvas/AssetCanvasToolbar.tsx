import { useState } from 'react'
import { User, MapPin, Package, Film, Trash2, ImageIcon, Type, FlaskConical, LayoutGrid, Palette } from 'lucide-react'
import { useReactFlow } from '@xyflow/react'
import { toast } from 'sonner'
import { resolveOverlaps } from '@/lib/canvas-layout'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useViewStore } from '@/stores/view-store'
import { connectStyleToAllAssets } from '@/lib/global-style-node'
import { GENRE_CASES, type GenreCase } from '@/lib/benchmarks/genre-cases'
import { GenreCaseRunnerDialog } from '@/components/director/GenreCaseRunnerDialog'
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
  const addItemNode = useCanvasStore((s) => s.addItemNode)
  const removeNodeByAssetId = useCanvasStore((s) => s.removeNodeByAssetId)
  const addItem = useCanvasItemStore((s) => s.addItem)
  const rf = useReactFlow()
  const selectedAssetIds = useViewStore((s) => s.selectedAssetIds)
  const clearSelection = useViewStore((s) => s.clearSelection)
  const [runningCase, setRunningCase] = useState<GenreCase | null>(null)

  const handleAdd = (type: AssetType, label: string) => {
    // Back every newly-added asset with a canvas-item so the node renders via
    // the rich ImageCanvasNode (floating toolbar, right-click capabilities,
    // resize, replace) — same code path as image-typed nodes. The assetId is
    // patched onto the node's data so selection / voice-feedback / tables
    // still resolve back to the asset.
    const assetId = addAsset({ type, name: label, tags: [] })
    const itemId = addItem({ kind: 'image', name: label, content: '' })
    const nodeId = addItemNode(itemId, 'image', randomPosition(), { width: 260, height: 200 })
    useCanvasStore.getState().updateNode(nodeId, { assetId } as Record<string, unknown>)
    // Auto-link the new asset under the global style node, if one exists.
    connectStyleToAllAssets()
  }

  const handleAddImage = () => {
    const id = addItem({ kind: 'image', name: '图片节点', content: '' })
    addItemNode(id, 'image', randomPosition())
    connectStyleToAllAssets()
  }

  const handleSyncStyle = () => {
    const { linked } = connectStyleToAllAssets()
    toast.success(linked > 0 ? `已连接 ${linked} 个新资产到全局风格节点` : '全局风格节点已与所有资产连接')
  }

  const handleAddText = () => {
    const id = addItem({ kind: 'text', name: '文本节点', content: '' })
    addItemNode(id, 'text', randomPosition())
  }

  const relayout = () => {
    const setNodes = useCanvasStore.getState().setNodes
    const current = useCanvasStore.getState().nodes
    const edges = useCanvasStore.getState().edges
    const fixed = resolveOverlaps(current as never, {
      padding: 40,
      iterations: 120,
      // LR edge constraint: every arrow points rightward — target node
      // ends up to the right of its source node, no matter where the user
      // dragged them.
      edges: edges.map((e) => ({ source: e.source, target: e.target })),
    })
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
            <Button variant="secondary" size="icon" className="h-8 w-8 shadow-md" onClick={handleSyncStyle}>
              <Palette className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">全局风格 → 关联所有资产</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="icon" className="h-8 w-8 shadow-md">
                  <FlaskConical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">跑 Test Case（30s 题材基准）</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuLabel className="text-xs">30s 题材基准用例（Weta 3D CG）</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {GENRE_CASES.map((c) => (
              <DropdownMenuItem key={c.id} className="text-xs" onSelect={() => setRunningCase(c)}>
                {c.title} · {c.genre}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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

      {runningCase && (
        <GenreCaseRunnerDialog genreCase={runningCase} onClose={() => setRunningCase(null)} />
      )}
    </TooltipProvider>
  )
}
