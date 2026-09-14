import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, copyFileSync, statSync, rmSync, createReadStream } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve, relative, isAbsolute } from 'path'

/**
 * 画布「生成 3D 预演」的服务端：把画布导出的 manifest 交给本地 headless Claude Code，
 * 由它在 storyai-director-studio 仓库里调用 previs MCP 搭低模动画，产物回到画布。
 *
 *   POST /previs/run      { manifest, shortId, images[] } → { shortId }
 *   GET  /previs/status?shortId=                          → PrevisRunStatus
 *   POST /previs/cancel?shortId=                          → { cancelled }
 *
 * 为什么这样搭（详见 docs/plans/2026-09-13-canvas-previs-node.md）：
 * - MCP 的 Chrome 用独立 profile、加载 127.0.0.1:5173，用户浏览器看不到它的 IndexedDB，
 *   所以「会话」以项目包文件交接：studio/public/sessions/<id>.previs.json + `?bundle=` 深链。
 * - 参考图复制进 studio/public/canvas-import/<id>/，manifest 里写同源路径，
 *   studio 页面取图不碰 CORS / 自签证书 / nginx 对本机公网地址的 403。
 * - Claude 进程 detached + unref，vite 重启不会杀掉跑了一半的预演；
 *   状态全在 studio/work/<id>/ 的文件里，重启后照样能查。
 * - 只有一个 MCP Chrome、一个场景：同一时间只允许一个任务。
 */

const STUDIO_ROOT = resolve(process.env.PREVIS_STUDIO_ROOT || '/data/repos/storyai-director-studio')
const STUDIO_PUBLIC_URL = (process.env.PREVIS_STUDIO_PUBLIC_URL || 'http://studio.35.168.148.47.nip.io').replace(/\/+$/, '')
const STUDIO_APP_URL = process.env.PREVIS_APP_URL || 'http://127.0.0.1:5173/'
const WORK_DIR = join(STUDIO_ROOT, 'work')
const ACTIVE_FILE = join(WORK_DIR, '.canvas2previs-active.json')
const RESULT_TAG = 'CANVAS2PREVIS_RESULT'
/** Hard cap per run. A healthy 1–3 beat draft run takes ~5 min; anything past this is stuck and holding the single Chrome. */
const MAX_RUN_MS = Number(process.env.PREVIS_MAX_RUN_MIN || 60) * 60_000

function claudeBin(): string {
  if (process.env.PREVIS_CLAUDE_BIN) return process.env.PREVIS_CLAUDE_BIN
  const local = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : 'claude'
}

const SHORT_ID_RE = /^[0-9a-z]{8}$/
const FILE_RE = /^[\w.-]{1,80}$/

interface ImageCopy { source: string; file: string }
interface ActiveRun { shortId: string; pid: number; startedAt: number }

export interface PrevisRunStatus {
  shortId: string
  status: 'running' | 'done' | 'error' | 'unknown'
  phase: string
  toolCalls: number
  lastTool: string | null
  startedAt: number | null
  elapsedMs: number | null
  mp4Url: string | null
  sessionUrl: string | null
  /** Same-origin download of the .previs.json bundle (studio「场景文件 → 从本地加载项目」). */
  bundleUrl: string | null
  /** Self-contained director report (sv2previs write_report). */
  reportUrl: string | null
  notes: string | null
  error: string | null
}

const runDir = (shortId: string) => join(WORK_DIR, shortId)

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readActive(): ActiveRun | null {
  try {
    const active = JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')) as ActiveRun
    return active && isAlive(active.pid) ? active : null
  } catch {
    return null
  }
}

/** Resolve `child` under `root`, refusing anything that escapes it. */
function within(root: string, child: string): string {
  const target = resolve(root, child)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`路径越界：${child}`)
  return target
}

/** Put one canvas image where the studio page can fetch it same-origin. */
async function copyImage(img: ImageCopy, destDir: string): Promise<void> {
  if (!FILE_RE.test(img.file)) throw new Error(`非法文件名：${img.file}`)
  const dest = join(destDir, img.file)
  const src = img.source
  if (src.startsWith('/uploads/')) {
    const uploads = join(process.cwd(), 'public', 'uploads')
    const onDisk = within(uploads, decodeURIComponent(src.slice('/uploads/'.length).split('?')[0]))
    copyFileSync(onDisk, dest)
  } else if (src.startsWith('data:image/')) {
    const comma = src.indexOf(',')
    writeFileSync(dest, Buffer.from(src.slice(comma + 1), 'base64'))
  } else if (/^https?:\/\//i.test(src)) {
    const resp = await fetch(src)
    if (!resp.ok) throw new Error(`下载参考图失败 HTTP ${resp.status}：${src.slice(0, 80)}`)
    writeFileSync(dest, Buffer.from(await resp.arrayBuffer()))
  } else {
    throw new Error(`不支持的图片地址：${src.slice(0, 60)}`)
  }
}

function mcpConfig(): unknown {
  return {
    mcpServers: {
      previs: {
        command: process.execPath,
        args: [join(STUDIO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(STUDIO_ROOT, 'mcp', 'previs-mcp', 'src', 'index.ts')],
        env: {
          PREVIS_APP_URL: STUDIO_APP_URL,
          PREVIS_AUTOSTART_DEV: '1',
          // No DISPLAY on this box: a headed Chrome fails and the bundled-Chromium
          // fallback isn't installed. Headless system Chrome works (verified).
          PREVIS_HEADLESS: '1',
          PREVIS_REPO_ROOT: STUDIO_ROOT,
          PREVIS_PROFILE_DIR: join(homedir(), '.cache', 'previs-mcp-profile'),
        },
      },
    },
  }
}

function runPrompt(shortId: string): string {
  return [
    `canvas2previs：画布导出的 manifest 在 work/${shortId}/canvas-manifest.json，shortId=${shortId}。`,
    '先用 Skill 工具加载 canvas2previs，按它无人值守执行（不要提问，只改 work/ 下文件）。',
    '选项：必须生成白模布景（import_manifest generateBlockout=true，失败的 set 用 generate_blockout 补做），人物和机位要落在白模地面上；render_episode quality=draft；save_project_bundle 到 ' + `${shortId}/out/session.previs.json。`,
    `会话最后一行必须是 ${RESULT_TAG} 结果行。`,
  ].join('\n')
}

async function handleRun(req: IncomingMessage, res: ServerResponse) {
  if (!existsSync(join(STUDIO_ROOT, 'mcp', 'previs-mcp', 'src', 'index.ts'))) {
    return sendJson(res, 503, { error: `找不到 3D 导演台仓库：${STUDIO_ROOT}` })
  }
  const active = readActive()
  if (active) return sendJson(res, 409, { error: '已有一个 3D 预演在跑，完成或取消后再试', shortId: active.shortId })

  const body = await readBody(req)
  const shortId = String(body.shortId ?? '')
  const manifest = body.manifest as { project?: { id?: string }; beats?: unknown[] } | undefined
  const images = (Array.isArray(body.images) ? body.images : []) as ImageCopy[]
  if (!SHORT_ID_RE.test(shortId)) return sendJson(res, 400, { error: 'shortId 不合法' })
  if (!manifest?.project?.id || String(manifest.project.id).replace(/[^0-9a-zA-Z]/g, '').slice(0, 8).toLowerCase() !== shortId) {
    return sendJson(res, 400, { error: 'manifest.project.id 与 shortId 不一致' })
  }
  if (!Array.isArray(manifest.beats) || manifest.beats.length === 0) return sendJson(res, 400, { error: 'manifest 没有 beat' })

  const dir = runDir(shortId)
  if (existsSync(join(dir, 'claude.jsonl'))) return sendJson(res, 409, { error: `任务 ${shortId} 已存在` })
  mkdirSync(join(dir, 'out'), { recursive: true })

  const importDir = join(STUDIO_ROOT, 'public', 'canvas-import', shortId)
  mkdirSync(importDir, { recursive: true })
  try {
    for (const img of images) await copyImage(img, importDir)
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    rmSync(importDir, { recursive: true, force: true })
    return sendJson(res, 400, { error: (e as Error).message })
  }

  writeFileSync(join(dir, 'canvas-manifest.json'), JSON.stringify(manifest, null, 2))
  const cfgPath = join(dir, 'mcp-config.json')
  writeFileSync(cfgPath, JSON.stringify(mcpConfig(), null, 2))

  const out = openSync(join(dir, 'claude.jsonl'), 'a')
  const err = openSync(join(dir, 'claude.stderr.log'), 'a')
  const child = spawn(
    claudeBin(),
    [
      '-p', runPrompt(shortId),
      '--output-format', 'stream-json', '--verbose',
      '--mcp-config', cfgPath, '--strict-mcp-config',
      // File access for work/ only. `//` = absolute-path rule (Claude writes with absolute paths, which
      // `work/**` didn't match), and Edit rules cover Write too — Write(path) rules are ignored.
      '--allowedTools', 'mcp__previs', 'Skill', 'Read', 'Glob', 'Grep', `Edit(/${WORK_DIR}/**)`,
      '--permission-mode', 'dontAsk',
    ],
    { cwd: STUDIO_ROOT, detached: true, stdio: ['ignore', out, err], env: { ...process.env } },
  )
  closeSync(out)
  closeSync(err)
  if (!child.pid) return sendJson(res, 500, { error: '启动 claude 失败' })
  child.unref()

  const startedAt = Date.now()
  writeFileSync(ACTIVE_FILE, JSON.stringify({ shortId, pid: child.pid, startedAt } satisfies ActiveRun))
  writeFileSync(join(dir, 'canvas-run.json'), JSON.stringify({ shortId, pid: child.pid, startedAt, beats: manifest.beats.length }))
  const pid = child.pid
  setTimeout(() => {
    if (isAlive(pid) && !existsSync(join(dir, 'cancelled.json'))) {
      console.warn(`[previs] ${shortId} exceeded ${MAX_RUN_MS / 60000} min, stopping`)
      stopRun(shortId, pid, 'timeout')
    }
  }, MAX_RUN_MS).unref()
  console.log(`[previs] started canvas2previs ${shortId} pid=${child.pid}`)
  sendJson(res, 200, { shortId, startedAt })
}

const PHASE_BY_TOOL: Array<[RegExp, string]> = [
  [/app_status|restart_app/, '连接 3D 导演台'],
  [/import_manifest/, '导入素材并生成白模布景'],
  [/generate_blockout/, '生成白模布景'],
  [/anchors|list_parts|transform_part_group/, '看布景定锚点'],
  [/staging|beat_ranges/, '写分镜计划'],
  [/build_scene|validate_scene/, '建场'],
  [/contact_sheet|screenshot|render_still|set_object_transform|add_camera_motion|update_object/, '自检与修正'],
  [/render_/, '渲染'],
  [/save_project_bundle/, '保存会话'],
]

/** Read the stream-json transcript and derive progress + final result. */
export function summarizeTranscript(jsonl: string): {
  toolCalls: number
  lastTool: string | null
  phase: string
  resultText: string | null
  isError: boolean
} {
  let toolCalls = 0
  let lastTool: string | null = null
  let phase = '启动 Claude'
  let resultText: string | null = null
  let isError = false
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let evt: { type?: string; message?: { content?: Array<{ type?: string; name?: string }> }; result?: string; is_error?: boolean; subtype?: string }
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    if (evt.type === 'assistant') {
      for (const part of evt.message?.content ?? []) {
        if (part.type !== 'tool_use' || !part.name) continue
        toolCalls++
        lastTool = part.name
        const short = part.name.replace(/^mcp__previs__/, '')
        // wait_job belongs to whatever long job came before it.
        if (short === 'wait_job') continue
        for (const [re, label] of PHASE_BY_TOOL) if (re.test(short)) { phase = label; break }
      }
    } else if (evt.type === 'result') {
      resultText = typeof evt.result === 'string' ? evt.result : ''
      isError = Boolean(evt.is_error) || (evt.subtype !== undefined && evt.subtype !== 'success')
    }
  }
  return { toolCalls, lastTool, phase, resultText, isError }
}

export function parseResultLine(text: string): Record<string, unknown> | null {
  const lines = text.split('\n').filter((l) => l.includes(RESULT_TAG))
  const last = lines[lines.length - 1]
  if (!last) return null
  const json = last.slice(last.indexOf(RESULT_TAG) + RESULT_TAG.length).trim()
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** work/-relative path from the result line, confined to this run's directory. */
function runFile(shortId: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel) return null
  try {
    const p = within(WORK_DIR, rel)
    return relative(runDir(shortId), p).startsWith('..') ? null : p
  } catch {
    return null
  }
}

function handleStatus(req: IncomingMessage, res: ServerResponse) {
  const shortId = new URL(req.url ?? '', 'http://x').searchParams.get('shortId') ?? ''
  if (!SHORT_ID_RE.test(shortId)) return sendJson(res, 400, { error: 'shortId 不合法' })
  const dir = runDir(shortId)
  const transcript = join(dir, 'claude.jsonl')
  if (!existsSync(transcript)) return sendJson(res, 404, { error: `没有任务 ${shortId}` })

  const meta = (() => {
    try { return JSON.parse(readFileSync(join(dir, 'canvas-run.json'), 'utf8')) as ActiveRun } catch { return null }
  })()
  const summary = summarizeTranscript(readFileSync(transcript, 'utf8'))
  let alive = meta ? isAlive(meta.pid) : false
  if (alive && meta && summary.resultText === null && Date.now() - meta.startedAt > MAX_RUN_MS && !existsSync(join(dir, 'cancelled.json'))) {
    stopRun(shortId, meta.pid, 'timeout')
  }
  alive = meta ? isAlive(meta.pid) : false
  const status: PrevisRunStatus = {
    shortId,
    status: 'running',
    phase: summary.phase,
    toolCalls: summary.toolCalls,
    lastTool: summary.lastTool,
    startedAt: meta?.startedAt ?? null,
    elapsedMs: meta ? Date.now() - meta.startedAt : null,
    mp4Url: null,
    sessionUrl: null,
    bundleUrl: null,
    reportUrl: null,
    notes: null,
    error: null,
  }

  if (existsSync(join(dir, 'cancelled.json')) && summary.resultText === null) {
    let reason = 'cancelled'
    try { reason = JSON.parse(readFileSync(join(dir, 'cancelled.json'), 'utf8')).reason ?? reason } catch { /* default */ }
    const label = reason === 'timeout' ? `超过 ${MAX_RUN_MS / 60000} 分钟未完成，已停止` : '已取消'
    status.status = alive ? 'running' : 'error'
    status.phase = alive ? '正在停止' : label
    if (!alive) {
      status.error = label
      clearActive(shortId)
    }
    return sendJson(res, 200, status)
  }

  if (summary.resultText === null) {
    if (!alive) {
      status.status = 'error'
      let stderr = ''
      try { stderr = readFileSync(join(dir, 'claude.stderr.log'), 'utf8').slice(-400) } catch { /* none */ }
      status.error = `Claude 进程已退出但没有给出结果${stderr ? `：${stderr}` : ''}`
      clearActive(shortId)
    }
    return sendJson(res, 200, status)
  }

  clearActive(shortId)
  const result = parseResultLine(summary.resultText)

  // Hand the artifacts over: mp4 into the canvas uploads, bundle into studio/public/sessions.
  // Done even for a failed run — a run that staged and built but couldn't render still
  // leaves a session the user can open and finish by hand in the 3D 导演台.
  const mp4 = runFile(shortId, result?.episode) ?? join(runDir(shortId), 'out', 'episode.mp4')
  const bundle = runFile(shortId, result?.bundle) ?? join(runDir(shortId), 'out', 'session.previs.json')
  if (result?.status === 'done' && existsSync(mp4)) {
    const target = join(process.cwd(), 'public', 'uploads', `previs-${shortId}.mp4`)
    if (!existsSync(target) || statSync(target).size !== statSync(mp4).size) copyFileSync(mp4, target)
    status.mp4Url = `/uploads/previs-${shortId}.mp4`
  }
  if (existsSync(bundle)) {
    const target = join(STUDIO_ROOT, 'public', 'sessions', `${shortId}.previs.json`)
    mkdirSync(dirname(target), { recursive: true })
    if (!existsSync(target) || statSync(target).size !== statSync(bundle).size) copyFileSync(bundle, target)
    status.sessionUrl = `${STUDIO_PUBLIC_URL}/?bundle=${encodeURIComponent(`/sessions/${shortId}.previs.json`)}`
    status.bundleUrl = `/previs/bundle?shortId=${shortId}`
  }
  const report = runFile(shortId, result?.report) ?? join(runDir(shortId), 'out', 'report.html')
  if (existsSync(report)) status.reportUrl = `/previs/report?shortId=${shortId}`

  if (!result || result.status !== 'done') {
    status.status = 'error'
    status.error = result
      ? `${String(result.stage ?? '')} 失败：${String(result.error ?? '未知错误')}`
      : summary.isError ? `Claude 运行出错：${summary.resultText.slice(-300)}` : '没有找到结果行'
    return sendJson(res, 200, status)
  }
  status.notes = typeof result.notes === 'string' ? result.notes : null
  if (!status.mp4Url) {
    status.status = 'error'
    status.error = '预演完成但找不到 episode.mp4'
  } else {
    status.status = 'done'
    status.phase = '完成'
  }
  sendJson(res, 200, status)
}

function clearActive(shortId: string) {
  try {
    const active = JSON.parse(readFileSync(ACTIVE_FILE, 'utf8')) as ActiveRun
    if (active.shortId === shortId) rmSync(ACTIVE_FILE, { force: true })
  } catch { /* nothing active */ }
}

/** SIGTERM the run's process group (claude + MCP server + Chrome), SIGKILL after 15 s if still alive. */
function stopRun(shortId: string, pid: number, reason: 'cancelled' | 'timeout') {
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig) // detached → its own process group
    } catch {
      try { process.kill(pid, sig) } catch { /* already gone */ }
    }
  }
  writeFileSync(join(runDir(shortId), 'cancelled.json'), JSON.stringify({ at: Date.now(), reason }))
  signal('SIGTERM')
  // Claude finishes the in-flight tool call before exiting on SIGTERM; don't let a
  // stuck MCP call keep the single-run lock forever. The active lock itself is
  // released by readActive() once the pid is really gone.
  setTimeout(() => { if (isAlive(pid)) signal('SIGKILL') }, 15_000).unref()
}

/** Stream the run's bundle as a download (published copy in studio/public/sessions). */
function handleBundle(req: IncomingMessage, res: ServerResponse) {
  const shortId = new URL(req.url ?? '', 'http://x').searchParams.get('shortId') ?? ''
  if (!SHORT_ID_RE.test(shortId)) return sendJson(res, 400, { error: 'shortId 不合法' })
  const file = join(STUDIO_ROOT, 'public', 'sessions', `${shortId}.previs.json`)
  if (!existsSync(file)) return sendJson(res, 404, { error: '这个预演没有会话包' })
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(statSync(file).size),
    'Content-Disposition': `attachment; filename="previs-${shortId}.previs.json"`,
    'Cache-Control': 'no-store',
  })
  createReadStream(file).pipe(res)
}

/** The report is self-contained HTML (inline images), so it can be served as-is. */
function handleReport(req: IncomingMessage, res: ServerResponse) {
  const shortId = new URL(req.url ?? '', 'http://x').searchParams.get('shortId') ?? ''
  if (!SHORT_ID_RE.test(shortId)) return sendJson(res, 400, { error: 'shortId 不合法' })
  const file = join(runDir(shortId), 'out', 'report.html')
  if (!existsSync(file)) return sendJson(res, 404, { error: '这个预演没有导演报告' })
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  createReadStream(file).pipe(res)
}

function handleCancel(req: IncomingMessage, res: ServerResponse) {
  const shortId = new URL(req.url ?? '', 'http://x').searchParams.get('shortId') ?? ''
  if (!SHORT_ID_RE.test(shortId)) return sendJson(res, 400, { error: 'shortId 不合法' })
  let meta: ActiveRun | null = null
  try { meta = JSON.parse(readFileSync(join(runDir(shortId), 'canvas-run.json'), 'utf8')) } catch { /* none */ }
  if (!meta || !isAlive(meta.pid)) {
    clearActive(shortId)
    return sendJson(res, 200, { cancelled: false })
  }
  stopRun(shortId, meta.pid, 'cancelled')
  sendJson(res, 200, { cancelled: true })
}

export function previsPlugin(): Plugin {
  return {
    name: 'canvas-previs',
    configureServer(server) {
      const wrap = (method: string, fn: (req: IncomingMessage, res: ServerResponse) => unknown) =>
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== method) return sendJson(res, 405, { error: `${method} only` })
          try {
            await fn(req, res)
          } catch (e) {
            console.error('[previs]', (e as Error).message)
            if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message })
          }
        }
      server.middlewares.use('/previs/run', wrap('POST', handleRun))
      server.middlewares.use('/previs/status', wrap('GET', handleStatus))
      server.middlewares.use('/previs/cancel', wrap('POST', handleCancel))
      server.middlewares.use('/previs/bundle', wrap('GET', handleBundle))
      server.middlewares.use('/previs/report', wrap('GET', handleReport))
    },
  }
}
