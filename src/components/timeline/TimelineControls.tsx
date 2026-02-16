import { useEffect, useRef } from 'react'
import { Play, Pause, SkipBack, Magnet, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTimelineStore } from '@/stores/timeline-store'
import { formatTime } from '@/lib/time-utils'

export function TimelineControls() {
  const isPlaying = useTimelineStore((s) => s.isPlaying)
  const setIsPlaying = useTimelineStore((s) => s.setIsPlaying)
  const playheadTime = useTimelineStore((s) => s.playheadTime)
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime)
  const duration = useTimelineStore((s) => s.duration)
  const zoom = useTimelineStore((s) => s.zoom)
  const setZoom = useTimelineStore((s) => s.setZoom)
  const snapEnabled = useTimelineStore((s) => s.snapEnabled)
  const toggleSnap = useTimelineStore((s) => s.toggleSnap)
  const animRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)

  useEffect(() => {
    if (!isPlaying) return
    lastTimeRef.current = performance.now()

    const animate = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000
      lastTimeRef.current = now
      const newTime = playheadTime + dt
      if (newTime >= duration) {
        setPlayheadTime(0)
        setIsPlaying(false)
        return
      }
      setPlayheadTime(newTime)
      animRef.current = requestAnimationFrame(animate)
    }

    animRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animRef.current)
  }, [isPlaying, playheadTime, duration, setPlayheadTime, setIsPlaying])

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground font-mono mr-2 w-[80px]">
          {formatTime(playheadTime)}
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPlayheadTime(0)}>
              <SkipBack className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setIsPlaying(!isPlaying)}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isPlaying ? 'Pause' : 'Play'}</TooltipContent>
        </Tooltip>

        <div className="w-px h-4 bg-border mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={snapEnabled ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7"
              onClick={toggleSnap}
            >
              <Magnet className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Snap {snapEnabled ? 'On' : 'Off'}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(zoom * 0.8)}>
              <ZoomOut className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom Out</TooltipContent>
        </Tooltip>

        <span className="text-[10px] text-muted-foreground w-[32px] text-center">
          {Math.round(zoom * 100)}%
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setZoom(zoom * 1.25)}>
              <ZoomIn className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom In</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
