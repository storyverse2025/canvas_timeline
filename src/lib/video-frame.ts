/**
 * Extract still frames from a video URL in the browser.
 *
 * Used by the storyboard bridge-row pipeline so the director-agent can see
 * the actual last frame of clip N and the first frame of clip N+1 when
 * judging whether a transition needs a bridging row.
 *
 * Browser-only. CORS-sensitive: when the video host doesn't return
 * Access-Control-Allow-Origin, the canvas tainting check throws on
 * toDataURL — we catch and return undefined rather than crash the caller,
 * because the bridge verb degrades gracefully to text-only.
 *
 * Frames are returned as JPEG data URLs at moderate quality. Apimart
 * compresses the upload again anyway; we don't try to be cute with PNG.
 */

const MAX_EDGE = 768
const JPEG_QUALITY = 0.82

export interface FrameExtractOptions {
  /** "first" → t = 0. "last" → t = duration - epsilon. "middle" → midpoint. */
  position: 'first' | 'last' | 'middle'
  /** Override the timeout in ms. Default 8s. */
  timeoutMs?: number
}

/**
 * Extract a single still frame from a video URL.
 *
 * Returns a JPEG data URL, or undefined when the browser can't reach the
 * frame for any reason (CORS, decode failure, missing duration metadata,
 * timeout). Callers should always handle the undefined case.
 */
export async function extractVideoFrame(
  videoUrl: string,
  opts: FrameExtractOptions,
): Promise<string | undefined> {
  if (!videoUrl) return undefined
  if (typeof document === 'undefined') return undefined

  const timeoutMs = opts.timeoutMs ?? 8000
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  // Off-DOM <video> won't decode in some browsers; attach hidden.
  video.style.position = 'fixed'
  video.style.left = '-9999px'
  video.style.top = '-9999px'
  video.style.width = '1px'
  video.style.height = '1px'
  document.body.appendChild(video)

  try {
    return await new Promise<string | undefined>((resolve) => {
      let settled = false
      const finish = (out: string | undefined) => {
        if (settled) return
        settled = true
        resolve(out)
      }
      const timer = window.setTimeout(() => finish(undefined), timeoutMs)

      const seek = () => {
        const dur = Number.isFinite(video.duration) ? video.duration : NaN
        if (!dur || dur <= 0) {
          window.clearTimeout(timer)
          finish(undefined)
          return
        }
        let target: number
        if (opts.position === 'first') target = 0
        else if (opts.position === 'middle') target = dur / 2
        // last: back off ~0.05s; many codecs can't seek to the absolute final
        // frame (decoder needs the next packet that doesn't exist).
        else target = Math.max(0, dur - 0.05)
        try {
          video.currentTime = target
        } catch {
          window.clearTimeout(timer)
          finish(undefined)
        }
      }

      const draw = () => {
        try {
          const vw = video.videoWidth
          const vh = video.videoHeight
          if (!vw || !vh) {
            window.clearTimeout(timer)
            finish(undefined)
            return
          }
          const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh))
          const cw = Math.max(1, Math.round(vw * scale))
          const ch = Math.max(1, Math.round(vh * scale))
          const canvas = document.createElement('canvas')
          canvas.width = cw
          canvas.height = ch
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            window.clearTimeout(timer)
            finish(undefined)
            return
          }
          ctx.drawImage(video, 0, 0, cw, ch)
          let out: string | undefined
          try {
            out = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
          } catch {
            // Canvas was tainted by a CORS-blocked frame.
            out = undefined
          }
          window.clearTimeout(timer)
          finish(out)
        } catch {
          window.clearTimeout(timer)
          finish(undefined)
        }
      }

      video.addEventListener('loadedmetadata', seek, { once: true })
      video.addEventListener('seeked', draw, { once: true })
      video.addEventListener('error', () => {
        window.clearTimeout(timer)
        finish(undefined)
      }, { once: true })

      video.src = videoUrl
      // Some browsers need an explicit load() after src assignment.
      try { video.load() } catch { /* ignore */ }
    })
  } finally {
    try {
      video.removeAttribute('src')
      video.load()
    } catch { /* ignore */ }
    try {
      document.body.removeChild(video)
    } catch { /* already gone */ }
  }
}

export const extractFirstFrame = (url: string, timeoutMs?: number) =>
  extractVideoFrame(url, { position: 'first', timeoutMs })

export const extractLastFrame = (url: string, timeoutMs?: number) =>
  extractVideoFrame(url, { position: 'last', timeoutMs })
