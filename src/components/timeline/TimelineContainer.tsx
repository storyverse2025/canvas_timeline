import { useRef } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TimelineRuler } from './TimelineRuler'
import { TimelineTrack } from './TimelineTrack'
import { TimelinePlayhead } from './TimelinePlayhead'
import { TimelineControls } from './TimelineControls'
import { useTimelineStore } from '@/stores/timeline-store'

export function TimelineContainer() {
  const shots = useTimelineStore((s) => s.shots)
  const zoom = useTimelineStore((s) => s.zoom)
  const duration = useTimelineStore((s) => s.duration)
  const addShot = useTimelineStore((s) => s.addShot)
  const scrollRef = useRef<HTMLDivElement>(null)

  const timelineWidth = Math.max(duration, 30) * 50 * zoom

  return (
    <div className="h-full flex flex-col bg-card/40 border-t border-border">
      {/* Header row */}
      <div className="flex items-center h-9 border-b border-border px-2 gap-2 shrink-0">
        <span className="text-xs font-medium text-muted-foreground">Shots</span>
        <span className="text-[10px] text-muted-foreground/60">({shots.length})</span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-[10px] gap-1 ml-1"
          onClick={() => addShot()}
        >
          <Plus className="w-3 h-3" />
          Add Shot
        </Button>
        <div className="flex-1" />
        <TimelineControls />
      </div>

      {/* Timeline body */}
      <div className="flex-1 overflow-hidden relative">
        <div className="flex h-full">
          {/* Track label */}
          <div className="w-[100px] shrink-0 border-r border-border bg-card/60">
            <div className="h-6 border-b border-border" /> {/* Ruler spacer */}
            <div className="h-16 flex items-center px-3 border-b border-border/50 text-xs font-medium text-muted-foreground">
              <span className="w-2 h-2 rounded-full mr-2 bg-cyan-500" />
              Shot Track
            </div>
          </div>

          {/* Scrollable timeline area */}
          <div className="flex-1 overflow-x-auto overflow-y-hidden" ref={scrollRef}>
            <div style={{ width: timelineWidth, minWidth: '100%' }} className="relative">
              <TimelineRuler width={timelineWidth} />
              <div className="relative">
                <TimelineTrack width={timelineWidth} />
                <TimelinePlayhead height={64} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
