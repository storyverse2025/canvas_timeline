import { useCallback, useEffect, useRef, useState } from 'react'

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'recorded' | 'error'

export interface UseVoiceRecorderResult {
  state: RecorderState
  blob: Blob | null
  durationMs: number
  error: string | null
  start: () => Promise<void>
  stop: () => void
  reset: () => void
}

/**
 * Microphone-recording hook. Wraps MediaRecorder + getUserMedia. Returns the
 * captured Blob (audio/webm in Chromium, audio/ogg in Firefox) plus a duration
 * estimate. Releases mic tracks on stop/unmount. The backend accepts webm/ogg
 * directly, so no client-side WAV transcoding is required.
 */
export function useVoiceRecorder(): UseVoiceRecorderResult {
  const [state, setState] = useState<RecorderState>('idle')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [durationMs, setDurationMs] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef<number>(0)

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setBlob(null)
    setDurationMs(0)
    chunksRef.current = []

    if (typeof navigator === 'undefined') {
      setState('error')
      setError('No navigator (SSR context?)')
      return
    }
    // navigator.mediaDevices is undefined in non-secure contexts. Browsers only
    // expose the mic API over https:// or http://localhost / http://127.0.0.1.
    // The dev server binds 0.0.0.0 so a LAN IP / hostname hit silently blocks it.
    if (!window.isSecureContext) {
      setState('error')
      const where = typeof window !== 'undefined' ? window.location.host : ''
      setError(`麦克风需要安全上下文。请用 http://localhost:8080 或 https:// 打开（当前: ${where}）`)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error')
      setError('Browser does not support getUserMedia (try Chrome/Edge/Firefox)')
      return
    }
    setState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mr = new MediaRecorder(stream)
      recorderRef.current = mr
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      mr.onstop = () => {
        const mime = mr.mimeType || 'audio/webm'
        const out = new Blob(chunksRef.current, { type: mime })
        setBlob(out)
        setDurationMs(Date.now() - startedAtRef.current)
        cleanupStream()
        setState('recorded')
      }
      mr.onerror = () => {
        cleanupStream()
        setState('error')
        setError('MediaRecorder failed mid-recording')
      }
      startedAtRef.current = Date.now()
      mr.start()
      setState('recording')
    } catch (err) {
      cleanupStream()
      setState('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [cleanupStream])

  const stop = useCallback(() => {
    const mr = recorderRef.current
    if (mr && mr.state !== 'inactive') {
      try {
        mr.stop()
      } catch (err) {
        cleanupStream()
        setState('error')
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [cleanupStream])

  const reset = useCallback(() => {
    cleanupStream()
    recorderRef.current = null
    chunksRef.current = []
    setBlob(null)
    setDurationMs(0)
    setError(null)
    setState('idle')
  }, [cleanupStream])

  useEffect(() => () => cleanupStream(), [cleanupStream])

  return { state, blob, durationMs, error, start, stop, reset }
}
