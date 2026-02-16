import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { X, Play, Pause, SkipBack, SkipForward, Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/ui-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useCanvasStore } from '@/stores/canvas-store'
import type { VisualAssetNodeData, ScriptNodeData } from '@/types/canvas'

interface ShotPlayback {
  shotId: string
  label: string
  videoUrl?: string
  imageUrl?: string
  dialogue?: { speaker?: string; text: string }
  narration?: string
  duration: number
  globalStart: number // cumulative start time in the full sequence
}

export function PreviewWindow() {
  const togglePreview = useUiStore((s) => s.togglePreview)
  const shots = useTimelineStore((s) => s.shots)
  const nodes = useCanvasStore((s) => s.nodes)

  const videoRef = useRef<HTMLVideoElement>(null)
  const timerRef = useRef<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [expanded, setExpanded] = useState(false)

  // Build playback list from shots
  const playbackList: ShotPlayback[] = useMemo(() => {
    let globalStart = 0
    return shots.map((shot) => {
      const entry: ShotPlayback = {
        shotId: shot.id,
        label: shot.label,
        videoUrl: shot.data?.videoUrl as string | undefined,
        duration: shot.duration,
        globalStart,
      }

      // Find linked visual (keyframe/scene) for fallback image
      for (const nodeId of shot.linkedNodeIds) {
        const node = nodes.find((n) => n.id === nodeId)
        if (node?.type === 'visual') {
          const data = node.data as unknown as VisualAssetNodeData
          if (data.imageUrl && !entry.imageUrl) {
            entry.imageUrl = data.imageUrl
          }
        }
        if (node?.type === 'script') {
          const data = node.data as unknown as ScriptNodeData
          if (data.scriptType === 'dialogue' && !entry.dialogue) {
            entry.dialogue = { speaker: data.characterName, text: data.content }
          }
          if (data.scriptType === 'narration' && !entry.narration) {
            entry.narration = data.content
          }
        }
      }

      globalStart += shot.duration
      return entry
    })
  }, [shots, nodes])

  const totalDuration = useMemo(
    () => playbackList.reduce((s, p) => s + p.duration, 0),
    [playbackList]
  )

  const current = playbackList[currentIndex]

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // Handle advancing to next shot
  const goToNext = useCallback(() => {
    if (currentIndex < playbackList.length - 1) {
      setCurrentIndex((i) => i + 1)
    } else {
      // End of sequence
      setPlaying(false)
      setCurrentIndex(0)
      setCurrentTime(0)
    }
  }, [currentIndex, playbackList.length])

  // When current shot changes, start playback
  useEffect(() => {
    if (!current || !playing) return

    // Clean up any existing timer
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (current.videoUrl && videoRef.current) {
      // Video shot - let the <video> element handle playback
      videoRef.current.src = current.videoUrl
      videoRef.current.currentTime = 0
      videoRef.current.play().catch(() => {})
    } else {
      // Image-only shot - use a timer to advance after duration
      const startMs = Date.now()
      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startMs) / 1000
        setCurrentTime(current.globalStart + elapsed)
        if (elapsed >= current.duration) {
          if (timerRef.current) clearInterval(timerRef.current)
          timerRef.current = null
          goToNext()
        }
      }, 100)
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [current, playing, goToNext])

  const handleVideoTimeUpdate = () => {
    if (videoRef.current && current) {
      setCurrentTime(current.globalStart + videoRef.current.currentTime)
    }
  }

  const handleVideoEnded = () => {
    goToNext()
  }

  const handlePlay = () => {
    setPlaying(true)
    if (currentIndex >= playbackList.length) {
      setCurrentIndex(0)
      setCurrentTime(0)
    }
  }

  const handlePause = () => {
    setPlaying(false)
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause()
    }
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const handlePrev = () => {
    handlePause()
    setCurrentIndex((i) => Math.max(0, i - 1))
    const prev = playbackList[Math.max(0, currentIndex - 1)]
    if (prev) setCurrentTime(prev.globalStart)
  }

  const handleNext = () => {
    handlePause()
    if (currentIndex < playbackList.length - 1) {
      setCurrentIndex((i) => i + 1)
      const next = playbackList[currentIndex + 1]
      if (next) setCurrentTime(next.globalStart)
    }
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    const targetTime = fraction * totalDuration

    // Find which shot this falls in
    for (let i = 0; i < playbackList.length; i++) {
      const p = playbackList[i]
      if (targetTime >= p.globalStart && targetTime < p.globalStart + p.duration) {
        handlePause()
        setCurrentIndex(i)
        setCurrentTime(targetTime)
        if (p.videoUrl && videoRef.current) {
          videoRef.current.src = p.videoUrl
          videoRef.current.currentTime = targetTime - p.globalStart
        }
        break
      }
    }
  }

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const hasVideos = playbackList.some((p) => p.videoUrl)

  return (
    <div
      className={`absolute z-40 rounded-lg border border-border bg-card shadow-2xl overflow-hidden flex flex-col ${
        expanded
          ? 'inset-4'
          : 'bottom-4 right-4 w-[420px]'
      }`}
    >
      {/* Header */}
      <div className="flex items-center h-8 px-3 border-b border-border bg-card/80 shrink-0">
        <span className="text-[11px] font-medium flex-1">
          Preview {current ? `- ${current.label}` : ''}
        </span>
        <span className="text-[10px] text-muted-foreground mr-2 font-mono">
          {formatTime(currentTime)} / {formatTime(totalDuration)}
        </span>
        <Button variant="ghost" size="icon" className="h-5 w-5 mr-1" onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={togglePreview}>
          <X className="w-3 h-3" />
        </Button>
      </div>

      {/* Video / Image display */}
      <div className="aspect-video bg-black relative flex items-center justify-center overflow-hidden">
        {/* Hidden video element for shots with video */}
        <video
          ref={videoRef}
          className={`w-full h-full object-contain ${current?.videoUrl ? '' : 'hidden'}`}
          onTimeUpdate={handleVideoTimeUpdate}
          onEnded={handleVideoEnded}
          playsInline
          muted={false}
        />

        {/* Fallback image for shots without video */}
        {current && !current.videoUrl && current.imageUrl && (
          <img
            src={current.imageUrl}
            alt={current.label}
            className="w-full h-full object-contain"
          />
        )}

        {/* No content placeholder */}
        {(!current || (!current.videoUrl && !current.imageUrl)) && (
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-secondary/50 flex items-center justify-center mx-auto mb-2">
              <Play className="w-5 h-5 text-muted-foreground/40 ml-0.5" />
            </div>
            <p className="text-xs text-muted-foreground">
              {playbackList.length === 0
                ? 'No shots to preview'
                : hasVideos
                  ? 'Click play to start'
                  : 'No videos generated yet - run Step 5'}
            </p>
          </div>
        )}

        {/* Dialogue / narration overlay */}
        {current && (current.dialogue || current.narration) && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/70 backdrop-blur-sm p-3">
            {current.dialogue && (
              <>
                {current.dialogue.speaker && (
                  <div className="text-[10px] text-primary font-semibold mb-0.5">
                    {current.dialogue.speaker}
                  </div>
                )}
                <p className="text-xs text-white leading-relaxed">{current.dialogue.text}</p>
              </>
            )}
            {!current.dialogue && current.narration && (
              <p className="text-xs text-white/80 italic leading-relaxed">{current.narration}</p>
            )}
          </div>
        )}

        {/* Shot number indicator */}
        {current && (
          <div className="absolute top-2 left-2 bg-black/60 rounded px-1.5 py-0.5 text-[9px] text-white/70">
            {currentIndex + 1} / {playbackList.length}
          </div>
        )}
      </div>

      {/* Timeline scrubber */}
      <div
        className="h-6 bg-secondary/30 relative cursor-pointer border-t border-border shrink-0"
        onClick={handleSeek}
      >
        {/* Shot segments */}
        {playbackList.map((p, i) => (
          <div
            key={p.shotId}
            className={`absolute top-0 bottom-0 border-r border-border/30 flex items-center justify-center ${
              i === currentIndex ? 'bg-cyan-500/30' : p.videoUrl ? 'bg-emerald-500/15' : 'bg-secondary/20'
            }`}
            style={{
              left: `${(p.globalStart / totalDuration) * 100}%`,
              width: `${(p.duration / totalDuration) * 100}%`,
            }}
          >
            <span className="text-[7px] text-muted-foreground/60 truncate px-0.5">
              {p.videoUrl ? '▶' : '◻'} {i + 1}
            </span>
          </div>
        ))}

        {/* Playhead */}
        {totalDuration > 0 && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
            style={{ left: `${(currentTime / totalDuration) * 100}%` }}
          />
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-2 px-3 py-1.5 border-t border-border shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handlePrev}>
          <SkipBack className="w-3.5 h-3.5" />
        </Button>
        {playing ? (
          <Button variant="default" size="icon" className="h-8 w-8" onClick={handlePause}>
            <Pause className="w-4 h-4" />
          </Button>
        ) : (
          <Button variant="default" size="icon" className="h-8 w-8" onClick={handlePlay}>
            <Play className="w-4 h-4 ml-0.5" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleNext}>
          <SkipForward className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  )
}
