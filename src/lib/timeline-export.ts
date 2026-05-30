/**
 * 把时间轴上每个分镜（有视频用视频、无视频用关键帧静帧）按顺序合拼成一段 MP4/WebM。
 *
 * 实现思路：用一张离屏 canvas 当合成器，canvas.captureStream() 给 MediaRecorder
 * 喂视频帧；视频源的音轨经 Web Audio 路由到 MediaStreamAudioDestinationNode，
 * 再把目标节点的音轨注入 stream 一起录。整段过程必须按 wall-clock 实时跑（MediaRecorder
 * 没法快进），所以导出时长 ≈ 时间轴总时长。
 *
 * 跨域素材：先 fetch 成 Blob 转 Object URL，绕开 canvas tainted 限制。
 */

import { useStoryboardStore } from '@/stores/storyboard-store'
import type { StoryboardRow } from '@/types/storyboard'

export interface ExportProgress {
  shotIndex: number
  totalShots: number
  elapsedSec: number
  totalSec: number
  phase: 'preparing' | 'recording' | 'finalizing'
  message?: string
}

export interface ExportOptions {
  width?: number
  height?: number
  fps?: number
  videoBitsPerSecond?: number
  signal?: AbortSignal
  onProgress?: (p: ExportProgress) => void
}

export interface ExportResult {
  blob: Blob
  ext: 'mp4' | 'webm'
  durationSec: number
}

const MIME_CANDIDATES: Array<{ mime: string; ext: 'mp4' | 'webm' }> = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
]

function pickMime(): { mime: string; ext: 'mp4' | 'webm' } {
  for (const c of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(c.mime)) return c
  }
  return { mime: '', ext: 'webm' }
}

// These hosts hand out signed URLs without CORS headers, so the browser can't
// fetch them directly. Route through the dev server's /asset-proxy middleware.
const PROXY_HOST_RE = /(?:^|\.)(?:volces\.com|bytepluses\.com|bytedanceapi\.com|byteimg\.com|byteoss\.com|fal\.media|fal\.run)$/i

function maybeProxy(url: string): string {
  try {
    const u = new URL(url, window.location.href)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url
    if (u.origin === window.location.origin) return url
    if (!PROXY_HOST_RE.test(u.hostname)) return url
    return `/asset-proxy?url=${encodeURIComponent(u.toString())}`
  } catch {
    return url
  }
}

async function urlToSameOriginBlob(url: string): Promise<string> {
  if (!url) return url
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  const fetched = maybeProxy(url)
  const resp = await fetch(fetched, { credentials: 'omit', mode: 'cors' })
  if (!resp.ok) throw new Error(`fetch ${url} → HTTP ${resp.status}`)
  const blob = await resp.blob()
  return URL.createObjectURL(blob)
}

function drawFit(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, media: CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number }) {
  const cw = canvas.width
  const ch = canvas.height
  const mw = (media as HTMLVideoElement).videoWidth || (media as HTMLImageElement).naturalWidth || (media as HTMLImageElement).width || cw
  const mh = (media as HTMLVideoElement).videoHeight || (media as HTMLImageElement).naturalHeight || (media as HTMLImageElement).height || ch
  if (!mw || !mh) return
  const scale = Math.min(cw / mw, ch / mh)
  const dw = mw * scale
  const dh = mh * scale
  const dx = (cw - dw) / 2
  const dy = (ch - dh) / 2
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, cw, ch)
  ctx.drawImage(media, dx, dy, dw, dh)
}

function drawErrorCard(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  shotLabel: string,
  errMsg: string,
  failedUrl: string,
  tickSec?: number,
) {
  ctx.fillStyle = '#7f1d1d'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const pad = Math.floor(canvas.height * 0.05)
  const lineH = Math.floor(canvas.height * 0.05)
  ctx.font = `bold ${Math.floor(canvas.height * 0.07)}px sans-serif`
  ctx.fillText(`⚠ ${shotLabel} 加载失败`, pad, pad)
  ctx.font = `${Math.floor(canvas.height * 0.035)}px sans-serif`
  ctx.fillText(errMsg.slice(0, 100), pad, pad + lineH * 2)
  ctx.fillStyle = '#fecaca'
  ctx.fillText(failedUrl.slice(0, 100), pad, pad + lineH * 3.2)
  if (failedUrl.length > 100) ctx.fillText(failedUrl.slice(100, 200), pad, pad + lineH * 4)
  if (tickSec !== undefined) {
    ctx.fillStyle = '#fff'
    ctx.font = `${Math.floor(canvas.height * 0.03)}px monospace`
    ctx.fillText(`t=${tickSec.toFixed(1)}s`, pad, canvas.height - pad - lineH)
  }
}

function drawTextCard(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, title: string, subtitle?: string) {
  ctx.fillStyle = '#111'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.floor(canvas.height * 0.06)}px sans-serif`
  ctx.fillText(title || '·', canvas.width / 2, canvas.height / 2 - canvas.height * 0.04)
  if (subtitle) {
    ctx.fillStyle = '#aaa'
    ctx.font = `${Math.floor(canvas.height * 0.035)}px sans-serif`
    ctx.fillText(subtitle.slice(0, 60), canvas.width / 2, canvas.height / 2 + canvas.height * 0.04)
  }
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function loadImage(url: string): Promise<{ img: HTMLImageElement; cleanup: () => void }> {
  // Try 1: fetch → blob URL (same-origin, never taints)
  try {
    const objUrl = await urlToSameOriginBlob(url)
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image()
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error('blob image load failed'))
      im.src = objUrl
    })
    return { img, cleanup: () => { if (objUrl !== url) URL.revokeObjectURL(objUrl) } }
  } catch (fetchErr) {
    // Try 2: direct load with crossOrigin='anonymous' — works if server returns
    // Access-Control-Allow-Origin headers, common for CDN-hosted assets.
    console.warn('[timeline-export] fetch-to-blob failed, trying direct CORS image:', url, fetchErr)
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image()
      im.crossOrigin = 'anonymous'
      im.onload = () => resolve(im)
      im.onerror = () => reject(new Error(`image load failed (CORS?): ${url.slice(0, 80)}`))
      im.src = url
    })
    return { img, cleanup: () => { /* noop */ } }
  }
}

async function renderImageShot(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  url: string,
  durationSec: number,
  signal?: AbortSignal,
): Promise<void> {
  const { img, cleanup } = await loadImage(url)
  try {
    // For static frames we still need to keep poking the canvas so captureStream
    // emits frames at the requested fps. Re-draw every ~100ms.
    const start = performance.now()
    const totalMs = durationSec * 1000
    while (performance.now() - start < totalMs) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      drawFit(ctx, canvas, img)
      await waitMs(Math.min(100, totalMs - (performance.now() - start)), signal)
    }
  } finally {
    cleanup()
  }
}

async function loadVideo(url: string): Promise<{ video: HTMLVideoElement; cleanup: () => void }> {
  // Try 1: fetch → blob URL
  let objUrl: string | null = null
  let usedDirect = false
  try {
    objUrl = await urlToSameOriginBlob(url)
  } catch (fetchErr) {
    console.warn('[timeline-export] video fetch-to-blob failed, loading directly with CORS:', url, fetchErr)
    usedDirect = true
  }
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.src = usedDirect ? url : objUrl!
  video.playsInline = true
  video.muted = false
  // Some Chromium builds skip frame decode for detached / display:none videos.
  video.style.position = 'fixed'
  video.style.left = '-99999px'
  video.style.width = '1px'
  video.style.height = '1px'
  document.body.appendChild(video)

  try {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => { cleanupListeners(); resolve() }
      const onErr = () => { cleanupListeners(); reject(new Error(`video load failed: ${url.slice(0, 80)}`)) }
      const cleanupListeners = () => {
        video.removeEventListener('loadeddata', onLoaded)
        video.removeEventListener('error', onErr)
      }
      video.addEventListener('loadeddata', onLoaded, { once: true })
      video.addEventListener('error', onErr, { once: true })
    })
  } catch (e) {
    video.remove()
    if (objUrl && objUrl !== url) URL.revokeObjectURL(objUrl)
    throw e
  }
  return {
    video,
    cleanup: () => {
      video.remove()
      if (objUrl && objUrl !== url) URL.revokeObjectURL(objUrl)
    },
  }
}

async function renderVideoShot(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  url: string,
  durationSec: number,
  audioCtx: AudioContext,
  audioDest: MediaStreamAudioDestinationNode,
  signal?: AbortSignal,
): Promise<void> {
  const { video, cleanup } = await loadVideo(url)
  let srcNode: MediaElementAudioSourceNode | null = null
  try {
    try {
      srcNode = audioCtx.createMediaElementSource(video)
      srcNode.connect(audioDest)
    } catch {
      // Some streams (DRM, already-bound) can't be hooked; just record silent video.
    }

    const playErr = await video.play().then(() => null).catch((e: Error) => e)
    if (playErr) {
      // Autoplay blocked — retry muted (audio still captured via MediaElementSource).
      console.warn('[timeline-export] video.play() failed, retrying muted:', playErr.message)
      video.muted = true
      await video.play().catch((e: Error) => {
        console.error('[timeline-export] muted play() also failed:', e.message)
      })
    }

    const start = performance.now()
    const totalMs = durationSec * 1000
    await new Promise<void>((resolve, reject) => {
      let rafId = 0
      let aborted = false
      const onAbort = () => {
        aborted = true
        cancelAnimationFrame(rafId)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const tick = () => {
        if (aborted) return
        drawFit(ctx, canvas, video)
        const elapsed = performance.now() - start
        if (video.ended || elapsed >= totalMs) {
          signal?.removeEventListener('abort', onAbort)
          resolve()
          return
        }
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
    })
  } finally {
    try { video.pause() } catch { /* noop */ }
    try { srcNode?.disconnect() } catch { /* noop */ }
    cleanup()
  }
}

export function hasExportableTimeline(): boolean {
  const rows = useStoryboardStore.getState().rows
  return rows.length > 0
}

export async function exportMergedVideo(opts: ExportOptions = {}): Promise<ExportResult> {
  const rows = useStoryboardStore.getState().rows
  if (rows.length === 0) throw new Error('时间轴为空')

  const totalSec = rows.reduce((s, r) => s + Math.max(0.1, Number(r.duration) || 1), 0)
  if (totalSec <= 0) throw new Error('时间轴总时长为 0')

  const width = opts.width ?? 1280
  const height = opts.height ?? 720
  const fps = opts.fps ?? 30
  const bitrate = opts.videoBitsPerSecond ?? 8_000_000
  const signal = opts.signal

  opts.onProgress?.({ shotIndex: 0, totalShots: rows.length, elapsedSec: 0, totalSec, phase: 'preparing' })

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  // Some Chromium builds drop captureStream frames if the canvas isn't in the DOM.
  canvas.style.position = 'fixed'
  canvas.style.left = '-99999px'
  canvas.style.width = '1px'
  canvas.style.height = '1px'
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 canvas 上下文')

  // Initial black frame
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)

  const stream = canvas.captureStream(fps)

  // Audio pipeline. Safari needs a user-gesture-initiated AudioContext —
  // since this is called from a click handler, that's already satisfied.
  const AudioCtor: typeof AudioContext = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
  const audioCtx = new AudioCtor()
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume() } catch { /* noop */ }
  }
  const audioDest = audioCtx.createMediaStreamDestination()
  // Keep the AAC encoder fed with a silent carrier — Chrome's MP4 muxer can
  // emit a corrupt/empty container if the audio track stays digitally silent.
  const silentGain = audioCtx.createGain()
  silentGain.gain.value = 0
  const silentOsc = audioCtx.createOscillator()
  silentOsc.connect(silentGain).connect(audioDest)
  silentOsc.start()
  for (const track of audioDest.stream.getAudioTracks()) {
    stream.addTrack(track)
  }

  const picked = pickMime()
  const recorderOpts: MediaRecorderOptions = picked.mime ? { mimeType: picked.mime, videoBitsPerSecond: bitrate } : { videoBitsPerSecond: bitrate }
  const recorder = new MediaRecorder(stream, recorderOpts)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }

  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })

  // Don't pass a timeslice — Chrome's MP4 MediaRecorder emits fragmented MP4
  // per timeslice and concatenating those produces an invalid ~15KB file.
  recorder.start()
  // Push a couple of fresh frames so captureStream definitely sees activity
  // before the first shot starts rendering.
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    await waitMs(33, signal)
  }
  opts.onProgress?.({ shotIndex: 0, totalShots: rows.length, elapsedSec: 0, totalSec, phase: 'recording' })

  let elapsedSec = 0
  try {
    for (let i = 0; i < rows.length; i++) {
      const row: StoryboardRow = rows[i]!
      const dur = Math.max(0.1, Number(row.duration) || 1)
      opts.onProgress?.({ shotIndex: i + 1, totalShots: rows.length, elapsedSec, totalSec, phase: 'recording', message: row.shot_number || `#${i + 1}` })

      try {
        if (row.beatVideoUrl) {
          await renderVideoShot(ctx, canvas, row.beatVideoUrl, dur, audioCtx, audioDest, signal)
        } else {
          const imgUrl = row.keyframeUrl || row.reference_image
          if (imgUrl) {
            await renderImageShot(ctx, canvas, imgUrl, dur, signal)
          } else {
            drawTextCard(ctx, canvas, row.shot_number || `#${i + 1}`, row.visual_description)
            await waitMs(dur * 1000, signal)
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        // Soft-fail one shot: paint a bright red error card so the failure is
        // immediately visible in the exported video instead of looking "all black".
        const failedUrl = row.beatVideoUrl || row.keyframeUrl || row.reference_image || ''
        console.error('[timeline-export] shot failed:', row.shot_number, failedUrl, e)
        drawErrorCard(ctx, canvas, row.shot_number || `#${i + 1}`, (e as Error).message, failedUrl)
        // Keep poking the canvas so captureStream sees motion (timestamp counter).
        const start = performance.now()
        const totalMs = dur * 1000
        while (performance.now() - start < totalMs) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          drawErrorCard(ctx, canvas, row.shot_number || `#${i + 1}`, (e as Error).message, failedUrl, (performance.now() - start) / 1000)
          await waitMs(Math.min(100, totalMs - (performance.now() - start)), signal)
        }
      }

      elapsedSec += dur
      opts.onProgress?.({ shotIndex: i + 1, totalShots: rows.length, elapsedSec, totalSec, phase: 'recording' })
    }
  } finally {
    opts.onProgress?.({ shotIndex: rows.length, totalShots: rows.length, elapsedSec, totalSec, phase: 'finalizing' })
    try { recorder.requestData() } catch { /* noop */ }
    try { recorder.stop() } catch { /* noop */ }
    await stopped
    stream.getTracks().forEach((t) => { try { t.stop() } catch { /* noop */ } })
    try { silentOsc.stop() } catch { /* noop */ }
    try { silentOsc.disconnect() } catch { /* noop */ }
    try { silentGain.disconnect() } catch { /* noop */ }
    try { await audioCtx.close() } catch { /* noop */ }
    try { canvas.remove() } catch { /* noop */ }
  }

  const blob = new Blob(chunks, { type: picked.mime || 'video/webm' })
  if (blob.size < 50 * 1024) {
    throw new Error(`录制失败：输出文件仅 ${blob.size} 字节（编码器可能未产生有效数据，请尝试刷新页面或更新 Chrome 后重试）`)
  }
  return { blob, ext: picked.ext, durationSec: totalSec }
}

/**
 * Server-side export: POST the timeline manifest to /timeline/export-server,
 * receive a finished MP4 stream back. 10-50× faster than the MediaRecorder
 * path AND produces a proper CFR MP4 (no slideshow-y freeze frames; every
 * player handles it).
 *
 * Falls back to client-side `exportMergedVideo` only if the server endpoint
 * returns 404 (e.g. dev server didn't load the plugin).
 */
export async function exportMergedVideoServerSide(opts: ExportOptions = {}): Promise<ExportResult> {
  const rows = useStoryboardStore.getState().rows
  if (!rows.length) throw new Error('timeline is empty')

  opts.onProgress?.({
    shotIndex: 0, totalShots: rows.length, elapsedSec: 0,
    totalSec: rows.reduce((s, r) => s + Math.max(0.1, Number(r.duration) || 1), 0),
    phase: 'preparing', message: 'POSTing manifest to server',
  })

  const manifest = {
    rows: rows.map((r) => ({
      shot_number: r.shot_number,
      duration_seconds: Math.max(0.1, Number(r.duration) || 1),
      video_url: r.beatVideoUrl || undefined,
      image_url: !r.beatVideoUrl ? (r.keyframeUrl || r.reference_image || undefined) : undefined,
    })),
    width: opts.width ?? 1280,
    height: opts.height ?? 720,
    fps: opts.fps ?? 24,
    videoBitsPerSecond: opts.videoBitsPerSecond,
  }

  opts.onProgress?.({
    shotIndex: 0, totalShots: rows.length, elapsedSec: 0,
    totalSec: manifest.rows.reduce((s, r) => s + r.duration_seconds, 0),
    phase: 'recording', message: 'ffmpeg running on server…',
  })

  const r = await fetch('/timeline/export-server', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
    signal: opts.signal,
  })
  if (r.status === 404) {
    console.warn('[timeline-export] server endpoint missing; falling back to client MediaRecorder')
    return exportMergedVideo(opts)
  }
  if (!r.ok) {
    const errText = await r.text().catch(() => `HTTP ${r.status}`)
    throw new Error(`server export failed (${r.status}): ${errText.slice(0, 300)}`)
  }
  const blob = await r.blob()
  opts.onProgress?.({
    shotIndex: rows.length, totalShots: rows.length,
    elapsedSec: manifest.rows.reduce((s, r) => s + r.duration_seconds, 0),
    totalSec: manifest.rows.reduce((s, r) => s + r.duration_seconds, 0),
    phase: 'finalizing',
  })
  const durationSec = manifest.rows.reduce((s, row) => s + row.duration_seconds, 0)
  return { blob, ext: 'mp4', durationSec }
}


export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
