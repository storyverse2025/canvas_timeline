import { Wand2, Copy, Trash2, Crosshair, Sparkles, Pencil } from 'lucide-react'
import { NodeToolbar, Position } from '@xyflow/react'
import { useReactFlow } from '@xyflow/react'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useGenerateDialogStore } from '@/stores/generate-dialog-store'
import { useEditPanelStore } from '@/stores/edit-panel-store'
import { gatherUpstream } from '@/lib/canvas-graph'
import type { MediaKind } from '@/lib/providers/types'

interface Props {
  nodeId: string;
  itemId?: string;
  isVisible: boolean;
}

/**
 * Hover/selected node toolbar — drawn ABOVE the node by xyflow,
 * so it doesn't get clipped or shift layout.
 */
export function NodeFloatingToolbar({ nodeId, itemId, isVisible }: Props) {
  const removeNode = useCanvasStore((s) => s.removeNode)
  const addItemNode = useCanvasStore((s) => s.addItemNode)
  const items = useCanvasItemStore((s) => s.items)
  const addItem = useCanvasItemStore((s) => s.addItem)
  const openDialog = useGenerateDialogStore((s) => s.open)
  const openEdit = useEditPanelStore((s) => s.open)
  const rf = useReactFlow()

  const item = itemId ? items[itemId] : undefined

  const startGen = (kind: MediaKind) => {
    if (!item) return
    const upstream = gatherUpstream(nodeId)
    // Include THIS node's own image as a reference when it has one (e.g. using an image
    // node as the first frame for image-to-video generation).
    const selfImage = item.kind === 'image' && item.content && !/\.(mp4|webm|mov)(\?|$)/i.test(item.content)
      ? [item.content]
      : []
    // When source is a text node, seed its content into the prompt.
    const selfText = item.kind === 'text' && item.content ? [item.content] : []
    const prompt = [item.name, ...selfText, ...upstream.texts].filter(Boolean).join(' · ')
    const refImages = [...selfImage, ...upstream.images]
    openDialog({ nodeId, itemId: item.id, prompt, upstreamImages: refImages, defaultKind: kind })
  }

  const duplicate = () => {
    if (!item) return
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
    if (!node) return
    const newItem = addItem({ kind: item.kind, name: item.name + ' 副本', content: item.content })
    const w = (node.style?.width as number) ?? node.width ?? 240
    const h = (node.style?.height as number) ?? node.height ?? 160
    addItemNode(newItem, item.kind, { x: node.position.x + 40, y: node.position.y + 40 }, { width: w, height: h })
  }

  const focus = () => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
    if (!node) return
    const w = (node.style?.width as number) ?? node.width ?? 240
    const h = (node.style?.height as number) ?? node.height ?? 160
    rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1.4, duration: 350 })
  }

  return (
    <NodeToolbar nodeId={nodeId} isVisible={isVisible} position={Position.Top} offset={6}>
      <div className="flex items-center gap-1 px-1.5 py-1 rounded-md bg-card border border-border shadow-lg text-xs">
        {item?.kind === 'image' && (
          <>
            <button title="生成图片" className="p-1 rounded hover:bg-accent" onClick={() => startGen('image')}>
              <Sparkles className="w-3.5 h-3.5 text-primary" />
            </button>
            <button title="生成视频" className="p-1 rounded hover:bg-accent" onClick={() => startGen('video')}>
              <Wand2 className="w-3.5 h-3.5 text-purple-400" />
            </button>
          </>
        )}
        {item?.kind === 'text' && (
          <button title="按文本生成图" className="p-1 rounded hover:bg-accent" onClick={() => startGen('image')}>
            <Sparkles className="w-3.5 h-3.5 text-primary" />
          </button>
        )}
        <div className="w-px h-4 bg-border mx-0.5" />
        {itemId && (
          <button title="编辑" className="p-1 rounded hover:bg-accent" onClick={() => openEdit(nodeId, itemId)}>
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        <button title="聚焦" className="p-1 rounded hover:bg-accent" onClick={focus}>
          <Crosshair className="w-3.5 h-3.5" />
        </button>
        <button title="复制" className="p-1 rounded hover:bg-accent" onClick={duplicate}>
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button title="删除" className="p-1 rounded hover:bg-destructive/20 text-destructive" onClick={() => removeNode(nodeId)}>
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </NodeToolbar>
  )
}
