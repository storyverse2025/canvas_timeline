import { useMemo } from 'react'
import { useTimelineStore } from '@/stores/timeline-store'
import { formatTime, timeToPixels } from '@/lib/time-utils'

interface TimelineRulerProps {
  width: number
}

export function TimelineRuler({ width }: TimelineRulerProps) {
  const duration = useTimelineStore((s) => s.duration)
  const zoom = useTimelineStore((s) => s.zoom)
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime)

  const ticks = useMemo(() => {
    const result: { time: number; x: number; major: boolean }[] = []
    // Choose interval based on zoom
    let interval = 1
    if (zoom < 0.3) interval = 10
    else if (zoom < 0.6) interval = 5
    else if (zoom < 1.5) interval = 2

    for (let t = 0; t <= duration; t += interval) {
      result.push({
        time: t,
        x: timeToPixels(t, zoom),
        major: t % (interval * 5) === 0 || interval >= 5,
      })
    }
    return result
  }, [duration, zoom])

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = x / (50 * zoom)
    setPlayheadTime(Math.max(0, Math.min(duration, time)))
  }

  return (
    <div
      className="h-6 border-b border-border bg-card/80 relative cursor-pointer select-none"
      style={{ width }}
      onClick={handleClick}
    >
      {ticks.map(({ time, x, major }) => (
        <div key={time} className="absolute top-0 h-full" style={{ left: x }}>
          <div className={`w-px ${major ? 'h-full bg-border' : 'h-2 bg-border/50 mt-auto absolute bottom-0'}`} />
          {major && (
            <span className="absolute top-0.5 left-1 text-[9px] text-muted-foreground whitespace-nowrap">
              {formatTime(time)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
