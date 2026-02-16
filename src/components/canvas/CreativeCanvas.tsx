import { useCallback, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type OnConnect,
  type NodeTypes,
  addEdge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCanvasStore } from '@/stores/canvas-store'
import { CanvasToolbar } from './CanvasToolbar'
import { ScriptNode } from './nodes/ScriptNode'
import { VisualAssetNode } from './nodes/VisualAssetNode'
import { AudioBlockNode } from './nodes/AudioBlockNode'

const nodeTypes: NodeTypes = {
  script: ScriptNode,
  visual: VisualAssetNode,
  audio: AudioBlockNode,
}

export function CreativeCanvas() {
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const onNodesChange = useCanvasStore((s) => s.onNodesChange)
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange)
  const setEdges = useCanvasStore((s) => s.setEdges)
  const setSelectedNodeIds = useCanvasStore((s) => s.setSelectedNodeIds)

  const onConnect: OnConnect = useCallback(
    (connection) => {
      setEdges(addEdge({ ...connection, animated: true, style: { stroke: 'hsl(172 66% 50%)' } }, edges))
    },
    [edges, setEdges]
  )

  const onSelectionChange = useCallback(
    ({ nodes: selected }: { nodes: { id: string }[] }) => {
      setSelectedNodeIds(selected.map((n) => n.id))
    },
    [setSelectedNodeIds]
  )

  return (
    <div className="h-full w-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        nodeTypes={nodeTypes}
        fitView
        snapToGrid
        snapGrid={[20, 20]}
        minZoom={0.1}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(220 15% 15%)" />
        <Controls className="!bg-card !border-border" />
        <MiniMap
          nodeColor={(node) => {
            switch (node.type) {
              case 'script': return 'hsl(172, 66%, 50%)'
              case 'visual': return 'hsl(280, 60%, 55%)'
              case 'audio': return 'hsl(45, 90%, 55%)'
              default: return 'hsl(220, 15%, 30%)'
            }
          }}
          maskColor="hsl(220 20% 6% / 0.8)"
          className="!bg-card/80 !border-border"
        />
      </ReactFlow>
      <CanvasToolbar />
    </div>
  )
}
