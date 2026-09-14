/**
 * vite-timeline-export-plugin: server-side timeline concat via ffmpeg.
 *
 * Replaces the browser-side MediaRecorder + canvas.captureStream approach
 * (src/lib/timeline-export.ts). That path produces VFR MP4s where freeze
 * frames between clips show up as "looks like a slideshow", and the avg
 * framerate doesn't match the declared framerate (VLC refuses to play some).
 *
 * Server-side ffmpeg concat is 10-50× faster (no realtime wait), produces
 * CFR MP4 that every player handles, and preserves source quality.
 *
 * API: POST /timeline/export-server
 *   body: {
 *     rows: [
 *       { duration_seconds: 4, video_url: "https://..." }                 // video clip
 *       | { duration_seconds: 3, image_url: "https://..." }               // image → static video
 *     ],
 *     width: 1280, height: 720, fps: 24,
 *     audio_url?: "https://..."   // optional background audio
 *   }
 *   response: video/mp4 binary stream
 *
 * Each clip is normalized (scaled + re-encoded at consistent fps+codec)
 * to a temp working file, then concat-demuxed losslessly. End-to-end the
 * server emits a single libx264 yuv420p AAC MP4 with -movflags +faststart.
 */

import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { spawn } from 'child_process'
import { mkdir, writeFile, readFile, rm, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

interface TimelineRow {
  shot_number?: string
  duration_seconds: number
  video_url?: string
  image_url?: string
  trim_start_s?: number   // optional: trim N seconds off the start of the source video
}

interface ExportReq {
  rows: TimelineRow[]
  width?: number
  height?: number
  fps?: number
  audio_url?: string
  videoBitsPerSecond?: number
  crf?: number  // libx264 CRF; lower = higher quality. Default 20
}

async function readJsonBody(req: IncomingMessage): Promise<ExportReq> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendError(res: ServerResponse, status: number, msg: string) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: msg }))
}

async function downloadTo(url: string, dest: string): Promise<void> {
  // Handle file:// directly + simple http(s) fetch.
  if (url.startsWith('file://')) {
    const path = url.slice('file://'.length)
    const buf = await readFile(path)
    await writeFile(dest, buf)
    return
  }
  const r = await fetch(url)
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  await writeFile(dest, buf)
}

function ffmpegRun(args: string[], label: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (b) => { stderr += b.toString() })
    proc.on('error', (e) => reject(new Error(`ffmpeg ${label}: spawn failed — ${e.message}`)))
    proc.on('close', (code) => resolve({ code: code ?? 1, stderr }))
  })
}

/**
 * Build a single normalized clip file for one timeline row.
 * - video_url: re-encode to width×height @ fps, libx264 yuv420p, trim to duration
 * - image_url: ffmpeg generates a still-loop video of duration_seconds
 */
async function buildClip(
  row: TimelineRow, idx: number, workDir: string,
  width: number, height: number, fps: number, crf: number,
): Promise<string> {
  const outPath = join(workDir, `clip-${String(idx).padStart(4, '0')}.mp4`)
  const dur = row.duration_seconds
  const trim = row.trim_start_s ?? 0
  if (row.video_url) {
    const srcPath = join(workDir, `src-${String(idx).padStart(4, '0')}.mp4`)
    await downloadTo(row.video_url, srcPath)
    // Normalize: scale + pad to exact WxH, fps to target, x264 yuv420p, audio AAC.
    // -ss before -i for fast seek (drop accurate if needed; trim_start_s ≥ 0).
    const args = [
      '-y',
      ...(trim > 0 ? ['-ss', String(trim)] : []),
      '-i', srcPath,
      '-t', String(dur),
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
      '-c:a', 'aac', '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath,
    ]
    const { code, stderr } = await ffmpegRun(args, `clip ${idx} (video)`)
    if (code !== 0) throw new Error(`ffmpeg clip ${idx} failed: ${stderr.split('\n').slice(-3).join(' ')}`)
    return outPath
  }
  if (row.image_url) {
    const srcPath = join(workDir, `img-${String(idx).padStart(4, '0')}.png`)
    await downloadTo(row.image_url, srcPath)
    const args = [
      '-y', '-loop', '1', '-framerate', String(fps),
      '-i', srcPath,
      '-t', String(dur),
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-shortest',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
      '-c:a', 'aac', '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath,
    ]
    const { code, stderr } = await ffmpegRun(args, `clip ${idx} (image)`)
    if (code !== 0) throw new Error(`ffmpeg clip ${idx} (image) failed: ${stderr.split('\n').slice(-3).join(' ')}`)
    return outPath
  }
  throw new Error(`row ${idx}: neither video_url nor image_url provided`)
}

/**
 * Concat-demuxer joins clips losslessly (no re-encode) when all clips share
 * codec params — which they do because buildClip normalized them.
 */
async function concatClips(clipPaths: string[], outPath: string, workDir: string): Promise<void> {
  const listPath = join(workDir, 'concat-list.txt')
  const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
  await writeFile(listPath, listContent, 'utf8')
  const args = [
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ]
  const { code, stderr } = await ffmpegRun(args, 'concat')
  if (code !== 0) throw new Error(`ffmpeg concat failed: ${stderr.split('\n').slice(-3).join(' ')}`)
}

async function handleExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ExportReq
  try { body = await readJsonBody(req) } catch (e) { return sendError(res, 400, `bad json: ${(e as Error).message}`) }
  if (!body.rows || !Array.isArray(body.rows) || body.rows.length === 0)
    return sendError(res, 400, 'rows must be a non-empty array')
  const width = body.width ?? 1280
  const height = body.height ?? 720
  const fps = body.fps ?? 24
  const crf = body.crf ?? 20

  const jobId = randomUUID().slice(0, 8)
  const workDir = join(tmpdir(), `timeline-export-${jobId}`)
  await mkdir(workDir, { recursive: true })

  console.log(`[timeline-export] job ${jobId} starting: ${body.rows.length} rows @ ${width}x${height}/${fps}fps`)

  try {
    const clipPaths: string[] = []
    for (let i = 0; i < body.rows.length; i++) {
      const t0 = Date.now()
      const p = await buildClip(body.rows[i]!, i, workDir, width, height, fps, crf)
      const st = await stat(p)
      console.log(`[timeline-export] job ${jobId} clip ${i+1}/${body.rows.length} (${body.rows[i]!.duration_seconds}s) → ${(st.size/1024).toFixed(0)} KB in ${Date.now()-t0}ms`)
      clipPaths.push(p)
    }
    const finalPath = join(workDir, `timeline-${jobId}.mp4`)
    const concatT0 = Date.now()
    await concatClips(clipPaths, finalPath, workDir)
    const finalStat = await stat(finalPath)
    console.log(`[timeline-export] job ${jobId} concat done in ${Date.now()-concatT0}ms → ${(finalStat.size/1024/1024).toFixed(2)} MB`)

    res.statusCode = 200
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Length', String(finalStat.size))
    res.setHeader('Content-Disposition', `attachment; filename="timeline-${jobId}.mp4"`)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Timeline-Job-Id', jobId)
    const stream = createReadStream(finalPath)
    stream.pipe(res)
    stream.on('close', async () => {
      try { await rm(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
      console.log(`[timeline-export] job ${jobId} streamed + cleaned up`)
    })
  } catch (e) {
    console.error(`[timeline-export] job ${jobId} failed:`, e)
    try { await rm(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return sendError(res, 500, (e as Error).message)
  }
}

export function timelineExportPlugin(): Plugin {
  return {
    name: 'vite-timeline-export-plugin',
    configureServer(server) {
      server.middlewares.use('/timeline/export-server', (req, res, next) => {
        if (req.method !== 'POST') return next()
        handleExport(req as IncomingMessage, res as ServerResponse).catch((e) => {
          console.error('[timeline-export] uncaught:', e)
          sendError(res as ServerResponse, 500, (e as Error).message)
        })
      })
    },
  }
}
