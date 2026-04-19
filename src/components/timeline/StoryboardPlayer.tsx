import { useEffect, useMemo, useRef, useCallback } from 'react'
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
  // Set of row IDs whose video has finished playing — prevents replay on re-render
  const playedRef = useRef(new Set<string>())

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

  // Reset played set when playhead goes back to 0 (replay from start)
  const prevPlayhead = useRef(playhead)
  if (playhead < prevPlayhead.current - 1) {
    playedRef.current.clear()
  }
  prevPlayhead.current = playhead

  const activeIdx = timeline.findIndex((e) => playhead >= e.start && playhead < e.end)
  const active = activeIdx >= 0 ? timeline[activeIdx] : timeline[timeline.length - 1]
  const activeRowId = active?.row.id
  // Skip video if this row was already played
  const alreadyPlayed = activeRowId ? playedRef.current.has(activeRowId) : false
  const activeVideo = !alreadyPlayed ? active?.row.beatVideoUrl : undefined
  const activeImage = active?.row.keyframeUrl || active?.row.reference_image

  // Use refs so callbacks always see latest values without re-triggering effects
  const activeRef = useRef(active)
  activeRef.current = active
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying

  // Track video ready state per row — reset when row changes
  const videoReadyForRef = useRef<string | null>(null)
  const isVideoReady = videoReadyForRef.current === activeRowId && !!activeVideo

  // ─── Playback tick (RAF) for image-only shots ──────────────────
  const rafRef = useRef<number | null>(null)
  const lastTs = useRef<number | null>(null)

  const stopRaf = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    lastTs.current = null
  }

  useEffect(() => {
    if (!isPlaying) { stopRaf(); return }

    // If video is ready and playing, video drives playhead — skip RAF
    if (activeVideo && isVideoReady) { stopRaf(); return }

    const tick = (ts: number) => {
      if (lastTs.current == null) lastTs.current = ts
      const dt = (ts - lastTs.current) / 1000
      lastTs.current = ts
      if (!isPlayingRef.current) return

      const cur = activeRef.current
      // If current shot has video waiting to load, pause playhead
      if (cur?.row.beatVideoUrl && videoReadyForRef.current !== cur.row.id) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const { playheadTime, duration: d } = useTimelineStore.getState()
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
    return stopRaf
  }, [isPlaying, activeVideo, isVideoReady, setPlayhead, setIsPlaying])

  // ─── Video event handlers ─────────────────────────────────────
  const handleCanPlay = useCallback(() => {
    const cur = activeRef.current
    if (!cur) return
    videoReadyForRef.current = cur.row.id
    // Force re-render to switch from RAF to video-driven mode
    setPlayhead(useTimelineStore.getState().playheadTime)
    if (isPlayingRef.current && videoRef.current) {
      videoRef.current.play().catch(() => {})
    }
  }, [setPlayhead])

  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current || !isPlayingRef.current) return
    const cur = activeRef.current
    if (!cur) return
    const newPlayhead = cur.start + videoRef.current.currentTime
    // Only update if still within this shot's range
    if (newPlayhead >= cur.start && newPlayhead <= cur.end + 0.1) {
      setPlayhead(newPlayhead)
    }
  }, [setPlayhead])

  const handleEnded = useCallback(() => {
    const cur = activeRef.current
    if (!cur) return
    // Mark this row as played so it won't replay on re-render
    playedRef.current.add(cur.row.id)
    videoReadyForRef.current = null
    // Advance to next shot
    const nextTime = cur.end + 0.01
    const totalDur = useTimelineStore.getState().duration
    if (nextTime >= totalDur) {
      playedRef.current.clear()
      setPlayhead(0)
      setIsPlaying(false)
    } else {
      setPlayhead(nextTime)
    }
  }, [setPlayhead, setIsPlaying])

  // Auto-play video when it becomes ready and we're playing
  useEffect(() => {
    if (!videoRef.current || !activeVideo) return
    if (isPlaying && isVideoReady) {
      videoRef.current.play().catch(() => {})
    } else if (!isPlaying) {
      videoRef.current.pause()
    }
  }, [isPlaying, isVideoReady, activeVideo])

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
          key={activeRowId}
          src={activeVideo}
          className="max-w-full max-h-full"
          loop={false}
          controls
          onCanPlay={handleCanPlay}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
        />
      ) : activeImage ? (
        <img
          key={activeRowId}
          src={activeImage}
          alt={active?.row.shot_number}
          className="max-w-full max-h-full object-contain animate-[fadeIn_0.4s_ease]"
        />
      ) : (
        <div className="text-zinc-500 text-sm">
          {active?.row.shot_number} · {active?.row.visual_description || '(无参考图)'}
        </div>
      )}

      {/* Loading indicator */}
      {activeVideo && !isVideoReady && (
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
