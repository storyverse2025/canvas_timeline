import { useEffect, useMemo, useRef } from 'react'
import { useTimelineStore } from '@/stores/timeline-store'
import { useStoryboardStore } from '@/stores/storyboard-store'

export function StoryboardPlayer() {
  const rows = useStoryboardStore((s) => s.rows)
  const playhead = useTimelineStore((s) => s.playheadTime)
  const duration = useTimelineStore((s) => s.duration)
  const isPlaying = useTimelineStore((s) => s.isPlaying)
  const setPlayhead = useTimelineStore((s) => s.setPlayheadTime)
  const setIsPlaying = useTimelineStore((s) => s.setIsPlaying)

  // Precompute cumulative startTime for each row → find active row by playhead
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

  // Playback tick — advance playhead based on elapsed real time while isPlaying.
  const rafRef = useRef<number | null>(null)
  const lastTs = useRef<number | null>(null)
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastTs.current = null
      return
    }
    const tick = (ts: number) => {
      if (lastTs.current == null) lastTs.current = ts
      const dt = (ts - lastTs.current) / 1000
      lastTs.current = ts
      const { playheadTime, duration: d, isPlaying: playing } = useTimelineStore.getState()
      if (!playing) return
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
  }, [isPlaying, setPlayhead, setIsPlaying])

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-black text-zinc-600 text-sm">
        分镜表为空 · 在聊天中生成分镜后即可在此预览
      </div>
    )
  }

  const img = active?.row.reference_image || active?.row.aiImageUrl
  const video = active?.row.aiVideoUrl

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
      {video ? (
        <video
          key={active?.row.id}
          src={video}
          className="max-w-full max-h-full"
          autoPlay={isPlaying}
          muted
          loop={false}
        />
      ) : img ? (
        <img
          key={active?.row.id}
          src={img}
          alt={active?.row.shot_number}
          className="max-w-full max-h-full object-contain animate-[fadeIn_0.4s_ease]"
        />
      ) : (
        <div className="text-zinc-500 text-sm">
          {active?.row.shot_number} · {active?.row.visual_description || '(无参考图)'}
        </div>
      )}

      {/* HUD */}
      <div className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-3 text-white">
        <div className="bg-black/60 backdrop-blur px-2 py-1 rounded text-xs max-w-[70%]">
          <div className="font-medium">{active?.row.shot_number} · {active?.row.shot_size}</div>
          {active?.row.dialogue && (
            <div className="mt-0.5 text-zinc-200">💬 {active.row.dialogue}</div>
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
