import { useCallback, useRef, useState } from 'react'
import { X, FileText, Image, Music, GripVertical, Film } from 'lucide-react'
import { timeToPixels, pixelsToTime } from '@/lib/time-utils'
import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import type { Shot } from '@/types/timeline'

interface TimelineItemProps {
  shot: Shot
  zoom: number
}

export function TimelineItem({ shot, zoom }: TimelineItemProps) {
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartX = useRef(0)
  const resizeStartDuration = useRef(0)

  const removeShot = useTimelineStore((s) => s.removeShot)
  const resizeShot = useTimelineStore((s) => s.resizeShot)
  const unlinkNodeFromShot = useTimelineStore((s) => s.unlinkNodeFromShot)
  const setSelectedNodeIds = useCanvasStore((s) => s.setSelectedNodeIds)
  const getNodeById = useCanvasStore((s) => s.getNodeById)

  const left = timeToPixels(shot.startTime, zoom)
  const width = timeToPixels(shot.duration, zoom)

  const handleClick = () => {
    if (shot.linkedNodeIds.length > 0) {
      setSelectedNodeIds(shot.linkedNodeIds)
    }
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    removeShot(shot.id)
  }

  const handleUnlinkNode = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    unlinkNodeFromShot(shot.id, nodeId)
  }

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      setIsResizing(true)
      resizeStartX.current = e.clientX
      resizeStartDuration.current = shot.duration

      const handleMouseMove = (ev: MouseEvent) => {
        const dx = ev.clientX - resizeStartX.current
        const newDuration = resizeStartDuration.current + pixelsToTime(dx, zoom)
        resizeShot(shot.id, newDuration)
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [shot.id, shot.duration, zoom, resizeShot]
  )

  // Get node type icon
  const getNodeIcon = (nodeId: string) => {
    const node = getNodeById(nodeId)
    if (!node) return null
    switch (node.type) {
      case 'script': return <FileText className="w-2.5 h-2.5 text-emerald-400" />
      case 'visual': return <Image className="w-2.5 h-2.5 text-violet-400" />
      case 'audio': return <Music className="w-2.5 h-2.5 text-amber-400" />
      default: return null
    }
  }

  const getNodeLabel = (nodeId: string): string => {
    const node = getNodeById(nodeId)
    if (!node) return nodeId.slice(0, 6)
    const data = node.data as Record<string, unknown>
    return (data.label as string) || (data.content as string)?.slice(0, 20) || (data.characterName as string) || nodeId.slice(0, 6)
  }

  return (
    <div
      className={`absolute top-1 bottom-1 rounded-md border cursor-pointer select-none flex flex-col overflow-hidden transition-colors ${
        Boolean(shot.data?.videoUrl)
          ? 'bg-emerald-500/20 border-emerald-500/50 hover:bg-emerald-500/30'
          : 'bg-cyan-500/20 border-cyan-500/50 hover:bg-cyan-500/30'
      } ${isResizing ? 'opacity-80' : ''}`}
      style={{ left, width: Math.max(width, 40) }}
      onClick={handleClick}
      data-timeline-item={shot.id}
    >
      {/* Header row with label + delete */}
      <div className="flex items-center gap-1 px-1.5 pt-1 min-h-[18px]">
        <GripVertical className="w-2.5 h-2.5 text-muted-foreground/50 shrink-0" />
        {Boolean(shot.data?.videoUrl) && (
          <Film className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
        )}
        <span className="text-[10px] text-foreground/80 truncate flex-1 font-medium">
          {shot.label}
        </span>
        <span className="text-[9px] text-muted-foreground shrink-0">
          {shot.duration.toFixed(0)}s
        </span>
        <button
          className="w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-red-500/30 text-muted-foreground hover:text-red-400 shrink-0"
          onClick={handleDelete}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      </div>

      {/* Linked elements */}
      {shot.linkedNodeIds.length > 0 && (
        <div className="flex flex-wrap gap-0.5 px-1.5 pb-1 mt-0.5">
          {shot.linkedNodeIds.map((nodeId) => (
            <div
              key={nodeId}
              className="flex items-center gap-0.5 bg-secondary/60 rounded px-1 py-0.5 text-[8px] text-muted-foreground max-w-[80px]"
            >
              {getNodeIcon(nodeId)}
              <span className="truncate">{getNodeLabel(nodeId)}</span>
              <button
                className="hover:text-red-400 ml-0.5"
                onClick={(e) => handleUnlinkNode(e, nodeId)}
              >
                <X className="w-2 h-2" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-white/10"
        onMouseDown={handleResizeStart}
      />
    </div>
  )
}
