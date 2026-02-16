import { memo, useState, useRef, useCallback } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { FileText, GripVertical } from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas-store'
import type { ScriptNodeData } from '@/types/canvas'

const scriptTypeColors: Record<string, string> = {
  dialogue: 'border-emerald-500/60 bg-emerald-500/10',
  narration: 'border-blue-500/60 bg-blue-500/10',
  action: 'border-orange-500/60 bg-orange-500/10',
  direction: 'border-purple-500/60 bg-purple-500/10',
}

export const ScriptNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as ScriptNodeData
  const colorClass = scriptTypeColors[d.scriptType] || scriptTypeColors.dialogue
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(d.content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const updateNode = useCanvasStore((s) => s.updateNode)

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('canvas-node-id', id)
    e.dataTransfer.effectAllowed = 'copy'
    e.stopPropagation()
  }, [id])

  const handleDoubleClick = useCallback(() => {
    setEditText(d.content)
    setIsEditing(true)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [d.content])

  const handleSave = useCallback(() => {
    setIsEditing(false)
    if (editText !== d.content) {
      updateNode(id, { content: editText } as Partial<ScriptNodeData>)
    }
  }, [editText, d.content, id, updateNode])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      setIsEditing(false)
      setEditText(d.content)
    }
  }, [handleSave, d.content])

  return (
    <div
      className={`min-w-[180px] max-w-[260px] rounded-lg border-2 ${colorClass} p-3 shadow-lg transition-shadow ${
        selected ? 'ring-2 ring-primary shadow-primary/20' : ''
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-primary !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Right} className="!bg-primary !w-2.5 !h-2.5" />

      <div className="flex items-center gap-1.5 mb-2">
        {/* Drag handle for timeline */}
        <div
          draggable
          onDragStart={handleDragStart}
          className="cursor-grab active:cursor-grabbing p-0.5 -ml-1 rounded hover:bg-white/10"
          title="Drag to timeline"
        >
          <GripVertical className="w-3 h-3 text-muted-foreground/60" />
        </div>
        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[10px] font-medium uppercase text-muted-foreground tracking-wider">
          {d.scriptType}
        </span>
        {d.beatNumber != null && (
          <span className="ml-auto text-[10px] bg-secondary px-1.5 py-0.5 rounded">
            Beat {d.beatNumber}
          </span>
        )}
      </div>

      {d.characterName && (
        <div className="text-xs font-semibold text-primary mb-1">{d.characterName}</div>
      )}

      {isEditing ? (
        <textarea
          ref={textareaRef}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          className="text-xs text-foreground/80 leading-relaxed w-full bg-background/50 rounded border border-border p-1 resize-none min-h-[60px] outline-none focus:ring-1 focus:ring-primary"
          rows={3}
        />
      ) : (
        <p
          className="text-xs text-foreground/80 line-clamp-3 leading-relaxed cursor-text"
          onDoubleClick={handleDoubleClick}
          title="Double-click to edit"
        >
          {d.content}
        </p>
      )}

      {d.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {d.tags.map((tag) => (
            <span
              key={tag.id}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground"
            >
              {tag.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
})
ScriptNode.displayName = 'ScriptNode'
