import { useCallback, useRef } from 'react'
import { useTimelineStore } from '@/stores/timeline-store'
import { timeToPixels, pixelsToTime } from '@/lib/time-utils'

interface TimelinePlayheadProps {
  height: number
}

export function TimelinePlayhead({ height }: TimelinePlayheadProps) {
  const playheadTime = useTimelineStore((s) => s.playheadTime)
  const zoom = useTimelineStore((s) => s.zoom)
  const duration = useTimelineStore((s) => s.duration)
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime)
  const isDragging = useRef(false)

  const x = timeToPixels(playheadTime, zoom)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return
        const parent = (e.target as HTMLElement).parentElement
        if (!parent) return
        const rect = parent.getBoundingClientRect()
        const px = ev.clientX - rect.left
        const time = pixelsToTime(px, zoom)
        setPlayheadTime(Math.max(0, Math.min(duration, time)))
      }

      const handleMouseUp = () => {
        isDragging.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [zoom, duration, setPlayheadTime]
  )

  return (
    <div
      className="absolute top-0 z-20 pointer-events-none"
      style={{ left: x, height }}
    >
      {/* Head triangle */}
      <div
        className="relative -left-[6px] w-3 h-3 bg-red-500 pointer-events-auto cursor-col-resize"
        style={{ clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }}
        onMouseDown={handleMouseDown}
      />
      {/* Line */}
      <div className="w-px bg-red-500 h-full -mt-px ml-[5px]" />
    </div>
  )
}
