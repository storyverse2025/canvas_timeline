import { useEffect, useRef } from 'react'
import { useTimelineStore } from '@/stores/timeline-store'

export function useTimelinePlayback() {
  const isPlaying = useTimelineStore((s) => s.isPlaying)
  const setPlayheadTime = useTimelineStore((s) => s.setPlayheadTime)
  const setIsPlaying = useTimelineStore((s) => s.setIsPlaying)
  const duration = useTimelineStore((s) => s.duration)
  const animRef = useRef<number>(0)
  const lastTimeRef = useRef(0)

  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(animRef.current)
      return
    }

    lastTimeRef.current = performance.now()

    const animate = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000
      lastTimeRef.current = now

      const currentTime = useTimelineStore.getState().playheadTime
      const newTime = currentTime + dt

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
  }, [isPlaying, duration, setPlayheadTime, setIsPlaying])
}
