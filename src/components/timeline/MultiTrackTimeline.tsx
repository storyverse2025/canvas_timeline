import { useEffect, useRef } from 'react'
import { Plus, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTimelineStore } from '@/stores/timeline-store'
import { timeToPixels } from '@/lib/time-utils'
import { TimelineRuler } from './TimelineRuler'
import { TimelineControls } from './TimelineControls'
import { TimelinePlayhead } from './TimelinePlayhead'
import { MultiTrackRow, TRACK_HEIGHT } from './MultiTrackRow'
import { StoryboardPlayer } from './StoryboardPlayer'
import type { TrackType } from '@/types/timeline'

const LABEL_WIDTH = 130

const TRACK_TYPE_COLORS: Record<TrackType, string> = {
  keyframe: 'text-violet-400',
  bgm:      'text-amber-400',
  dialogue: 'text-emerald-400',
  video:    'text-blue-400',
}

export function MultiTrackTimeline() {
  const tracks = useTimelineStore((s) => s.tracks)
  const duration = useTimelineStore((s) => s.duration)
  const zoom = useTimelineStore((s) => s.zoom)
  const addTrack = useTimelineStore((s) => s.addTrack)
  const updateTrack = useTimelineStore((s) => s.updateTrack)
  const initDefaultTracks = useTimelineStore((s) => s.initDefaultTracks)

  // Initialize default tracks on first render
  useEffect(() => {
    initDefaultTracks()
  }, [initDefaultTracks])

  const totalWidth = Math.max(timeToPixels(duration, zoom) + 100, 800)
  const totalHeight = tracks.length * TRACK_HEIGHT

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full bg-background select-none">
        {/* Controls bar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
          <TimelineControls />
        </div>

        {/* Big preview player */}
        <div className="h-[45%] min-h-[200px] border-b border-border shrink-0 bg-black">
          <StoryboardPlayer />
        </div>

        {/* Main layout: labels + scrollable area */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Track labels (fixed left column) */}
          <div
            className="shrink-0 border-r border-border bg-card/50 flex flex-col"
            style={{ width: LABEL_WIDTH }}
          >
            {/* Ruler spacer */}
            <div className="h-6 border-b border-border bg-card/80" />

            {/* Per-track labels */}
            {tracks.map((track) => (
              <div
                key={track.id}
                className={cn(
                  'flex items-center justify-between px-2 border-b border-border/40',
                  TRACK_TYPE_COLORS[track.type]
                )}
                style={{ height: TRACK_HEIGHT }}
              >
                <span className="text-[11px] font-medium truncate flex-1">{track.label}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={cn(
                        'p-0.5 rounded hover:bg-white/10 transition-colors shrink-0',
                        track.muted && 'opacity-40'
                      )}
                      onClick={() => updateTrack(track.id, { muted: !track.muted })}
                    >
                      {track.muted
                        ? <VolumeX className="w-3 h-3" />
                        : <Volume2 className="w-3 h-3" />
                      }
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{track.muted ? '取消静音' : '静音'}</TooltipContent>
                </Tooltip>
              </div>
            ))}

            {/* Add video track button */}
            <div className="px-2 py-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full h-7 text-[11px] text-muted-foreground hover:text-foreground gap-1"
                    onClick={() => addTrack('video')}
                  >
                    <Plus className="w-3 h-3" />
                    添加视频轨道
                  </Button>
                </TooltipTrigger>
                <TooltipContent>添加新视频轨道</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Scrollable timeline area */}
          <div className="flex-1 overflow-auto relative" id="timeline-scroll-area">
            <div style={{ width: totalWidth, position: 'relative' }}>
              {/* Ruler */}
              <TimelineRuler width={totalWidth} />

              {/* Track rows */}
              <div className="relative">
                {tracks.map((track) => (
                  <MultiTrackRow
                    key={track.id}
                    track={track}
                    zoom={zoom}
                    totalWidth={totalWidth}
                  />
                ))}

                {/* Playhead spans all rows */}
                {totalHeight > 0 && (
                  <TimelinePlayhead height={totalHeight} />
                )}
              </div>

              {/* Empty state */}
              {tracks.length === 0 && (
                <div className="flex items-center justify-center h-40 text-muted-foreground/40 text-sm">
                  初始化轨道中...
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
