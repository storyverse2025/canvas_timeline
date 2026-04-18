import { memo, useEffect, useRef, useState, useCallback } from 'react'
import { Handle, Position, NodeResizer, useNodeId } from '@xyflow/react'
import { NodeFloatingToolbar } from '../NodeFloatingToolbar'
import { cn } from '@/lib/utils'
import { useCanvasItemStore } from '@/stores/canvas-item-store'

export interface TextNodeData {
  itemId: string;
}

interface Props {
  data: TextNodeData;
  selected: boolean;
}

export const TextCanvasNode = memo(function TextCanvasNode({ data, selected }: Props) {
  const nodeId = useNodeId() ?? ''
  const item = useCanvasItemStore((s) => s.items[data.itemId])
  const updateItem = useCanvasItemStore((s) => s.updateItem)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item?.content ?? '')
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) setDraft(item?.content ?? '')
  }, [item?.content, editing])

  const startEdit = useCallback(() => {
    setDraft(item?.content ?? '')
    setEditing(true)
    setTimeout(() => areaRef.current?.focus(), 0)
  }, [item?.content])

  const commit = useCallback(() => {
    setEditing(false)
    if (draft !== item?.content) updateItem(data.itemId, { content: draft })
  }, [draft, item?.content, data.itemId, updateItem])

  if (!item) return null

  return (
    <div
      className={cn(
        'relative w-full h-full rounded-lg border-2 border-border bg-card shadow-md',
        selected && 'ring-2 ring-primary'
      )}
      onDoubleClick={startEdit}
    >
      <NodeFloatingToolbar nodeId={nodeId} itemId={data.itemId} isVisible={selected} />
      <NodeResizer
        isVisible={selected}
        minWidth={140}
        minHeight={80}
        lineClassName="!border-primary"
        handleClassName="!w-2 !h-2 !bg-primary !border !border-background"
      />
      <Handle id="t" type="target" position={Position.Top}    className="bragi-handle" />
      <Handle id="l" type="target" position={Position.Left}   className="bragi-handle" />
      <Handle id="r" type="source" position={Position.Right}  className="bragi-handle" />
      <Handle id="b" type="source" position={Position.Bottom} className="bragi-handle" />

      {editing ? (
        <textarea
          ref={areaRef}
          className="w-full h-full p-3 text-sm bg-transparent outline-none resize-none rounded-lg"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setEditing(false); setDraft(item.content) }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit()
          }}
        />
      ) : (
        <div className="w-full h-full p-3 text-sm whitespace-pre-wrap overflow-auto cursor-text">
          {item.content || <span className="text-muted-foreground italic">双击编辑文本…</span>}
        </div>
      )}

    </div>
  )
})
