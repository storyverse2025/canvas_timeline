import { useEffect, useMemo, useRef, useState } from 'react'
import { useTimelineStore } from '@/stores/timeline-store'
import { useStoryboardStore } from '@/stores/storyboard-store'

export function StoryboardPlayer() {
  const rows = useStoryboardStore((s) => s.rows)
  const playhead = useTimelineStore((s) => s.playheadTime)
  const duration = useTimelineStore((s) => s.duration)
  const isPlaying = useTimelineStore((s) => s.isPlaying)
  const setPlayhead = useTimelineStore((s) => s.setPlayheadTime)
  const setIsPlaying = useTimelineStore((s) => s.setIsPlaying)

  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoReady, setVideoReady] = useState(false)

  // Precompute cumulative startTime for each row
  const timeline = useMemo(() => {
    let t = 0
    return rows.map((r) => {
      const start = t
      const end = t + (Number(r.duration) || 0)
      t = end
      return { row: r, start, end }
    })
  }, [rows])

  const activeIdx = timeline.findIndex((e) => playhead >= e.start && playhead < e.end)
  const active = activeIdx >= 0 ? timeline[activeIdx] : timeline[timeline.length - 1]
  const activeVideo = active?.row.beatVideoUrl
  const activeImage = active?.row.keyframeUrl || active?.row.reference_image

  // Track which row we're on to detect transitions
  const prevRowIdRef = useRef<string | null>(null)
  const shotChanged = active?.row.id !== prevRowIdRef.current
  if (shotChanged) {
    prevRowIdRef.current = active?.row.id ?? null
  }

  // Reset videoReady when shot changes
  useEffect(() => {
    if (shotChanged) setVideoReady(false)
  }, [active?.row.id])

  // Playback logic:
  // - For image-only shots: advance playhead by wall-clock (RAF)
  // - For video shots: let the video element drive timing
  const rafRef = useRef<number | null>(null)
  const lastTs = useRef<number | null>(null)

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTs.current = null
      return
    }

    // If current shot has video, don't use RAF — video drives playhead
    if (activeVideo && videoReady) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTs.current = null
      return
    }

    // Image-only shots or video still loading: use RAF
    const tick = (ts: number) => {
      if (lastTs.current == null) lastTs.current = ts
      const dt = (ts - lastTs.current) / 1000
      lastTs.current = ts
      const { playheadTime, duration: d, isPlaying: playing } = useTimelineStore.getState()
      if (!playing) return

      // Don't advance past current shot if it has a video that's still loading
      const curActive = timeline.find((e) => playheadTime >= e.start && playheadTime < e.end)
      if (curActive?.row.beatVideoUrl && !videoReady) {
        // Wait for video to load — keep RAF going but don't advance
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const next = playheadTime + dt
      if (next >= d) {
        setPlayhead(0)
        setIsPlaying(false)
        return
      }
      setPlayhead(next)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTs.current = null
    }
  }, [isPlaying, activeVideo, videoReady, timeline, setPlayhead, setIsPlaying])

  // Video event handlers — sync playhead from video currentTime
  const handleVideoCanPlay = () => {
    setVideoReady(true)
    if (isPlaying && videoRef.current) {
      videoRef.current.play().catch(() => {})
    }
  }

  const handleVideoTimeUpdate = () => {
    if (!videoRef.current || !active || !isPlaying) return
    const videoTime = videoRef.current.currentTime
    const newPlayhead = active.start + videoTime
    setPlayhead(Math.min(newPlayhead, active.end))
  }

  const handleVideoEnded = () => {
    if (!active) return
    // Move playhead to end of this shot → triggers next shot
    setPlayhead(active.end + 0.01)
    setVideoReady(false)
  }

  // Auto-play/pause video when isPlaying changes
  useEffect(() => {
    if (!videoRef.current || !activeVideo) return
    if (isPlaying && videoReady) {
      videoRef.current.play().catch(() => {})
    } else {
      videoRef.current.pause()
    }
  }, [isPlaying, videoReady, activeVideo])

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-black text-zinc-600 text-sm">
        分镜表为空 · 在聊天中生成分镜后即可在此预览
      </div>
    )
  }

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
      {activeVideo ? (
        <video
          ref={videoRef}
          key={active?.row.id}
          src={activeVideo}
          className="max-w-full max-h-full"
          loop={false}
          controls
          onCanPlay={handleVideoCanPlay}
          onTimeUpdate={handleVideoTimeUpdate}
          onEnded={handleVideoEnded}
        />
      ) : activeImage ? (
        <img
          key={active?.row.id}
          src={activeImage}
          alt={active?.row.shot_number}
          className="max-w-full max-h-full object-contain animate-[fadeIn_0.4s_ease]"
        />
      ) : (
        <div className="text-zinc-500 text-sm">
          {active?.row.shot_number} · {active?.row.visual_description || '(无参考图)'}
        </div>
      )}

      {/* Loading indicator for video */}
      {activeVideo && !videoReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* HUD */}
      <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-3 text-white pointer-events-none">
        <div className="bg-black/60 backdrop-blur px-2 py-1 rounded text-xs max-w-[70%]">
          <div className="font-medium">{active?.row.shot_number} · {active?.row.shot_size}</div>
          {active?.row.dialogue && (
            <div className="mt-0.5 text-zinc-200">{active.row.dialogue}</div>
          )}
        </div>
        <div className="bg-black/60 backdrop-blur px-2 py-1 rounded text-[10px] tabular-nums">
          {playhead.toFixed(1)}s / {duration.toFixed(1)}s · #{activeIdx + 1}/{rows.length}
        </div>
      </div>

      <style>{`@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }`}</style>
    </div>
  )
}
