import { memo, useRef, useState, useCallback } from 'react'
import { Handle, Position, NodeResizer, useNodeId } from '@xyflow/react'
import { NodeFloatingToolbar } from '../NodeFloatingToolbar'
import { ImageIcon, Upload, Link as LinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'

export interface ImageNodeData {
  itemId: string;
}

interface Props {
  data: ImageNodeData;
  selected: boolean;
}

export const ImageCanvasNode = memo(function ImageCanvasNode({ data, selected }: Props) {
  const nodeId = useNodeId() ?? ''
  const item = useCanvasItemStore((s) => s.items[data.itemId])
  const updateItem = useCanvasItemStore((s) => s.updateItem)
  const activeTask = useLibtvTasksStore((s) =>
    Object.values(s.tasks).find(
      (t) => t.itemId === data.itemId && (t.status === 'pending' || t.status === 'polling'),
    ),
  )
  const [promptOpen, setPromptOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        updateItem(data.itemId, { content: reader.result, name: f.name })
      }
    }
    reader.readAsDataURL(f)
  }, [data.itemId, updateItem])

  const onUrl = useCallback(() => {
    const url = window.prompt('图片 URL', item?.content ?? '')
    if (url != null) updateItem(data.itemId, { content: url })
    setPromptOpen(false)
  }, [data.itemId, item?.content, updateItem])

  if (!item) return null

  return (
    <div
      className={cn(
        'relative w-full h-full rounded-lg border-2 border-border bg-card shadow-md overflow-hidden',
        selected && 'ring-2 ring-primary',
        activeTask && 'bragi-generating'
      )}
    >
      <NodeFloatingToolbar nodeId={nodeId} itemId={data.itemId} isVisible={selected} />
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={90}
        lineClassName="!border-primary"
        handleClassName="!w-2 !h-2 !bg-primary !border !border-background"
      />
      <Handle id="t" type="target" position={Position.Top}    className="bragi-handle" />
      <Handle id="l" type="target" position={Position.Left}   className="bragi-handle" />
      <Handle id="r" type="source" position={Position.Right}  className="bragi-handle" />
      <Handle id="b" type="source" position={Position.Bottom} className="bragi-handle" />

      {item.content ? (
        /\.(mp4|webm|mov)(\?|$)/i.test(item.content) ? (
          <video
            src={item.content}
            className="w-full h-full object-contain bg-black"
            controls
            playsInline
          />
        ) : (
          <img src={item.content} alt={item.name} className="w-full h-full object-contain bg-black/40" />
        )
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-muted/20 text-muted-foreground">
          <ImageIcon className="w-8 h-8 opacity-40" />
          <div className="flex gap-1">
            <button
              className="px-2 py-1 text-xs rounded bg-secondary hover:bg-secondary/80 flex items-center gap-1"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="w-3 h-3" /> 上传
            </button>
            <button
              className="px-2 py-1 text-xs rounded bg-secondary hover:bg-secondary/80 flex items-center gap-1"
              onClick={onUrl}
            >
              <LinkIcon className="w-3 h-3" /> URL
            </button>
          </div>
        </div>
      )}

      {item.content && selected && (
        <button
          className="absolute top-1 right-1 px-1.5 py-0.5 text-[10px] rounded bg-black/60 text-white hover:bg-black/80"
          onClick={() => fileRef.current?.click()}
        >替换</button>
      )}

      {activeTask && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white">
          <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
          <div className="text-[10px]">{activeTask.status === 'pending' ? '创建会话…' : '生成中…'}</div>
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />

      {promptOpen && null}

    </div>
  )
})
