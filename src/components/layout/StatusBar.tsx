import { useTimelineStore } from '@/stores/timeline-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useMappingStore } from '@/stores/mapping-store'
import { formatTime } from '@/lib/time-utils'

export function StatusBar() {
  const playheadTime = useTimelineStore((s) => s.playheadTime)
  const duration = useTimelineStore((s) => s.duration)
  const nodeCount = useCanvasStore((s) => s.nodes.length)
  const linkCount = useMappingStore((s) => s.links.length)

  return (
    <footer className="h-7 border-t border-border bg-card/60 flex items-center px-4 text-xs text-muted-foreground gap-4 shrink-0">
      <span>Time: {formatTime(playheadTime)} / {formatTime(duration)}</span>
      <span>Nodes: {nodeCount}</span>
      <span>Links: {linkCount}</span>
      <div className="flex-1" />
      <span className="text-muted-foreground/60">StoryVerse Canvas v0.1</span>
    </footer>
  )
}
