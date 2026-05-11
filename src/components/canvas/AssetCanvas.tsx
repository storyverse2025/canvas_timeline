import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  type NodeChange,
  type EdgeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCanvasStore } from '@/stores/canvas-store'
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useViewStore } from '@/stores/view-store'
import { AssetNode, type AssetNodeData } from './nodes/AssetNode'
import { ImageCanvasNode } from './nodes/ImageCanvasNode'
import { TextCanvasNode } from './nodes/TextCanvasNode'
import { AssetCanvasToolbar } from './AssetCanvasToolbar'
import { NodeContextMenu, type ContextMenuState } from './NodeContextMenu'
import { LibtvTasksPanel } from './LibtvTasksPanel'
import { GenerateDialog } from './GenerateDialog'
import { useGenerateDialogStore } from '@/stores/generate-dialog-store'
import { useLibtvGenerate } from '@/hooks/useLibtvGenerate'
import { NodeEditPanel } from './NodeEditPanel'
import { CapabilityDialogMount } from './CapabilityDialog'
import { useEditPanelStore } from '@/stores/edit-panel-store'
import type { Asset } from '@/types/asset'

const nodeTypes = { asset: AssetNode, image: ImageCanvasNode, text: TextCanvasNode }

export function AssetCanvas() {
  const canvasNodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const onNodesChange = useCanvasStore((s) => s.onNodesChange)
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange)
  const storeAddEdge = useCanvasStore((s) => s.addEdge)
  const setSelectedNodeIds = useCanvasStore((s) => s.setSelectedNodeIds)

  const assets = useAssetStore((s) => s.assets)
  const selectedAssetIds = useViewStore((s) => s.selectedAssetIds)
  const setSelectedAssetIds = useViewStore((s) => s.setSelectedAssetIds)

  // One-shot upgrade: legacy asset-only nodes have no `itemId`, so they get
  // rendered as the lean AssetNode and miss the floating toolbar / right-click
  // capabilities. Back-fill them with a canvas-item so they switch to the
  // rich ImageCanvasNode rendering on next render. Idempotent — only acts on
  // nodes still missing `itemId`.
  useEffect(() => {
    const itemStore = useCanvasItemStore.getState()
    const canvas = useCanvasStore.getState()
    const assetMap = new Map<string, Asset>(assets.map((a) => [a.id, a]))
    let upgraded = 0
    for (const n of canvas.nodes) {
      const data = n.data as { itemId?: string; assetId?: string }
      if (data.itemId || !data.assetId) continue
      const asset = assetMap.get(data.assetId)
      if (!asset) continue
      const itemId = itemStore.addItem({
        kind: 'image',
        name: asset.name,
        content: asset.imageUrl ?? '',
        prompt: asset.prompt,
      })
      canvas.updateNode(n.id, { itemId } as Record<string, unknown>)
      upgraded++
    }
    if (upgraded > 0) {
      // eslint-disable-next-line no-console
      console.info(`[AssetCanvas] upgraded ${upgraded} legacy asset nodes to image nodes`)
    }
    // Run once per assets-list identity change. Nodes added later already get
    // backing items via addVisualAsset / handleAdd.
  }, [assets])

  // Derive XYFlow nodes from canvas geometry + asset/item data
  const nodes = useMemo(() => {
    const assetMap = new Map<string, Asset>(assets.map((a) => [a.id, a]))
    return canvasNodes
      .map((n) => {
        const data = n.data as { itemId?: string; assetId?: string }
        if (data.itemId) {
          // Image / text node — keep itemId AND any assetId backing so
          // ImageCanvasNode can show a typed badge and selection still
          // resolves to the asset for the AssetTable etc.
          const assetId = data.assetId
          const isSelected = assetId ? selectedAssetIds.includes(assetId) : undefined
          return {
            ...n,
            type: n.type ?? 'image',
            ...(isSelected !== undefined ? { selected: isSelected } : {}),
            data: assetId ? { itemId: data.itemId, assetId } : { itemId: data.itemId },
          }
        }
        const assetId = data.assetId
        if (!assetId) return null
        const asset = assetMap.get(assetId)
        if (!asset) return null
        // Legacy fallback: render as AssetNode while the upgrader effect runs.
        return {
          ...n,
          type: 'asset',
          selected: selectedAssetIds.includes(assetId),
          data: { ...asset, assetId } as AssetNodeData,
        }
      })
      .filter(Boolean) as typeof canvasNodes
  }, [canvasNodes, assets, selectedAssetIds])

  const handleSelectionChange = useCallback(
    ({ nodes: sel }: OnSelectionChangeParams) => {
      const assetIds = sel
        .map((n) => (n.data as { assetId?: string }).assetId)
        .filter(Boolean) as string[]
      setSelectedAssetIds(assetIds)
      setSelectedNodeIds(sel.map((n) => n.id))
    },
    [setSelectedAssetIds, setSelectedNodeIds]
  )

  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)

  const handleNodeContextMenu = useCallback((e: React.MouseEvent, node: { id: string }) => {
    e.preventDefault()
    setCtxMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
  }, [])

  const handleConnect = useCallback(
    (connection: { source: string | null; target: string | null }) => {
      if (connection.source && connection.target) {
        storeAddEdge(connection.source, connection.target)
      }
    },
    [storeAddEdge]
  )

  return (
    <div className="relative w-full h-full">
      <AssetCanvasToolbar />
      <ReactFlow
        nodes={nodes as any}
        edges={edges}
        nodeTypes={nodeTypes as any}
        onNodesChange={onNodesChange as (changes: NodeChange[]) => void}
        onEdgesChange={onEdgesChange as (changes: EdgeChange[]) => void}
        onConnect={handleConnect}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={() => setCtxMenu(null)}
        onSelectionChange={handleSelectionChange}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={36}
        defaultEdgeOptions={{
          type: 'default',
          animated: false,
          style: { strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        }}
        snapToGrid
        snapGrid={[16, 16]}
        fitView
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="opacity-30" />
        <Controls className="!bottom-4 !left-4" />
        <MiniMap
          className="!bottom-4 !right-4 !bg-card"
          nodeColor={(n) => {
            const d = n.data as unknown as AssetNodeData
            if (d?.type === 'character') return '#8b5cf6'
            if (d?.type === 'scene') return '#10b981'
            if (d?.type === 'prop') return '#f59e0b'
            return '#3b82f6'
          }}
        />
      </ReactFlow>
      <NodeContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
      <LibtvTasksPanel />
      <GenerateDialogMount />
      <CapabilityDialogMount />
      <EditPanelMount />
    </div>
  )
}

function EditPanelMount() {
  const nodeId = useEditPanelStore((s) => s.nodeId)
  const itemId = useEditPanelStore((s) => s.itemId)
  const close = useEditPanelStore((s) => s.close)
  if (!nodeId || !itemId) return null
  return <NodeEditPanel nodeId={nodeId} itemId={itemId} onClose={close} />
}

function GenerateDialogMount() {
  const dialog = useGenerateDialogStore((s) => s.state)
  const close = useGenerateDialogStore((s) => s.close)
  const generate = useLibtvGenerate()
  if (!dialog) return null
  return (
    <GenerateDialog
      initialPrompt={dialog.prompt}
      upstreamImages={dialog.upstreamImages}
      defaultKind={dialog.defaultKind}
      onCancel={close}
      onSubmit={(r) => {
        close()
        generate({
          nodeId: dialog.nodeId,
          itemId: dialog.itemId,
          prompt: r.prompt,
          provider: r.provider,
          model: r.model,
          refImages: r.refImages,
          aspect: r.aspect,
          duration: r.duration,
          targetKind: r.kind,
          negativePrompt: r.negativePrompt,
          seed: r.seed,
          guidanceScale: r.guidanceScale,
          resolution: r.resolution,
          generateAudio: r.generateAudio,
          numImages: r.numImages,
        })
      }}
    />
  )
}
