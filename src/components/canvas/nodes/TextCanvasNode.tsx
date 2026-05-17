import { memo, useEffect, useRef, useState, useCallback } from 'react'
import { Handle, Position, NodeResizer, useNodeId } from '@xyflow/react'
import { NodeFloatingToolbar } from '../NodeFloatingToolbar'
import { cn } from '@/lib/utils'
import { useCanvasItemStore, type CanvasItemRole } from '@/stores/canvas-item-store'

export interface TextNodeData {
  itemId: string;
}

interface Props {
  data: TextNodeData;
  selected: boolean;
}

const ROLE_CYCLE: (CanvasItemRole | undefined)[] = [undefined, 'style', 'system']
// Only style + system are user-cycleable from a text node; 'keyframe' is set
// programmatically by director-agent on image items and never appears here.
const ROLE_STYLES: Partial<Record<NonNullable<CanvasItemRole>, { border: string; ring: string; chipBg: string; chipText: string; label: string }>> = {
  style:  { border: 'border-purple-400', ring: 'ring-purple-400', chipBg: 'bg-purple-500/90', chipText: 'text-white',  label: '全局风格' },
  system: { border: 'border-blue-400',   ring: 'ring-blue-400',   chipBg: 'bg-blue-500/90',   chipText: 'text-white',  label: '系统提示' },
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

  const cycleRole = useCallback(() => {
    if (!item) return
    const idx = ROLE_CYCLE.indexOf(item.role)
    const next = ROLE_CYCLE[(idx + 1) % ROLE_CYCLE.length]
    updateItem(data.itemId, { role: next })
  }, [item, data.itemId, updateItem])

  if (!item) return null

  const roleSkin = item.role ? ROLE_STYLES[item.role] : null

  return (
    <div
      className={cn(
        'relative w-full h-full rounded-lg border-2 bg-card shadow-md',
        roleSkin ? roleSkin.border : 'border-border',
        selected && (roleSkin ? `ring-2 ${roleSkin.ring}` : 'ring-2 ring-primary'),
      )}
      onDoubleClick={startEdit}
    >
      <NodeFloatingToolbar nodeId={nodeId} itemId={data.itemId} isVisible={selected} />
      <button
        type="button"
        title="切换角色：普通 → 全局风格 → 系统提示"
        onClick={(e) => { e.stopPropagation(); cycleRole() }}
        className={cn(
          'absolute -top-2 -left-2 z-10 px-1.5 py-0.5 rounded text-[10px] font-medium border shadow-sm select-none cursor-pointer',
          roleSkin ? `${roleSkin.chipBg} ${roleSkin.chipText} border-transparent` : 'bg-card text-muted-foreground border-border hover:text-foreground',
        )}
      >
        {roleSkin ? roleSkin.label : 'T'}
      </button>
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
