import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { spawn, execFile } from 'child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, copyFileSync, statSync, rmSync, renameSync, createReadStream } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve, relative, isAbsolute } from 'path'
import sharp from 'sharp'

/**
 * 画布「生成 3D 预演」的服务端：把画布导出的 manifest 交给本地 headless Claude Code，
 * 由它在 storyai-director-studio 仓库里调用 previs MCP 搭低模动画，产物回到画布。
 *
 *   POST /previs/run      { manifest, shortId, images[] } → { shortId }
 *   GET  /previs/status?shortId=                          → PrevisRunStatus
 *   POST /previs/cancel?shortId=                          → { cancelled }
 *   GET  /previs/beats?shortId=                           → { beats: PrevisBeatClip[] }（按白模重拍用的每镜白模片段）
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

/**
 * 假人加上正面标记（脸上五官 + 胸前标识板）的那次 studio 改动的时间线
 * （storyai-director-studio PR #4，2026-09-26）。
 *
 * 早于这个时间渲出来的白模，假人是光溜溜的纯色人形，正面和背面一模一样 ——
 * 朝向信息根本不在素材里，出片一律把人转过来面朝镜头，换 prompt、换参考图、
 * 换模型都修不掉（2026-09-19 的 26 次对照实验）。所以这里只能提示「回导演台重渲」，
 * 这是服务端才知道的事实（白模是 studio 渲的），不放在客户端。
 */
const FACING_MARKERS_SINCE = Date.parse('2026-09-26T00:00:00Z')

/** Seedance 2.0 reference_video: 4–15 s per clip, web URL only (base64 is rejected). */
const REF_VIDEO_MIN_S = 4
const REF_VIDEO_MAX_S = 15
/** Mirror of the studio's draft PALETTE (src/staging/draft.ts), for runs without staging.json. */
const DRAFT_PALETTE = ['#4f8cff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff', '#f4a261', '#8ecae6', '#ffafcc']

/** staging.json 里一个人物在某个 beat 的表演数据。白模演的就是这些。 */
interface StagingBeatCharacter {
  start?: { anchor?: string | null } | null
  end?: { anchor?: string | null } | null
  pose?: string | null
  poseEnd?: string | null
  moveWindow?: [number, number] | null
  motion?: string | null
  motionWindow?: [number, number] | null
  actions?: string[] | null
}

interface StagingFile {
  fps?: number
  characters?: Record<string, { name?: string; color?: string }>
  beats?: {
    beat: number
    startFrame?: number
    durationFrames?: number
    duration?: number
    /** 这一镜要演什么，一句中文。白模就是照它搭的 —— prompt 里最该有的一句。 */
    goal?: string
    characters?: Record<string, StagingBeatCharacter>
    segments?: { t0: number; t1: number; shotSize?: string; subject?: string; partner?: string; cameraPreset?: string | null; cameraMotion?: { id?: string } | null }[]
  }[]
}

/**
 * 动作 id → 中文名。动作库目录在导演台仓库里（35 个 Mixamo 动作，带 displayName），
 * 手势/姿态那套小词表沿用导演台 report 的 ACT_CN。
 *
 * 为什么要做这件事：白模是灰模假人，Seedance 的 `video-ref` 只能稳住时间轴
 * （时长、剪辑点、帧对齐），**画面内容只是倾向**——几乎所有像素都要重绘时，
 * 模型会把动作整个重新解读（实测：白模里「踉跄后退」被演成「向镜头走近」）。
 * 能钉住内容的只有文字，所以白模里的动作必须翻成中文写进 prompt。
 */
const ACTION_CN: Record<string, string> = {
  hurry: '疾走', lower_prop: '放下道具', withdraw_hand: '缩手', raise_cup: '举杯', drop_cup: '放杯',
  recoil: '后缩', lean_forward: '前倾', tense: '紧绷', sit_down: '坐下', stand_up: '起身',
  kneel_down: '跪下', look_down: '低头', gaze_up: '抬眼', shout: '吼叫', talk: '说话',
  nod: '点头', shake_head: '摇头', turn_away: '转身', hand_chest: '手抚胸', reach: '伸手',
  raise_hand: '抬手', shield: '护挡', fidget: '小动作', look_partner: '注视对方', walk: '行走',
}

let motionLabels: Record<string, string> | null = null
function motionLabel(id: string): string {
  if (!motionLabels) {
    motionLabels = {}
    try {
      const cat = JSON.parse(readFileSync(join(STUDIO_ROOT, 'src', 'previs-app', 'library', 'xyq', 'catalog.json'), 'utf8')) as {
        motions?: { id?: string; displayName?: string; name?: string }[]
      }
      for (const m of cat.motions ?? []) {
        if (m.id) motionLabels[m.id] = m.displayName || m.name || m.id
      }
    } catch { /* 目录读不到就退回 slug，照样比没有强 */ }
  }
  // 兜底：asset_library_motion_jump_attack → jump attack
  return motionLabels[id] ?? id.replace(/^asset_library_motion_/, '').replace(/_/g, ' ')
}

function actionLabel(id: string): string {
  return ACTION_CN[id] ?? id.replace(/_/g, ' ')
}

/**
 * 数一帧里各个假人的颜色占了多少像素 → 这一帧真正出场的是谁。
 *
 * 为什么不信 staging 的 `subject`/`partner`：2026-09-26 在 beat 3 实测，它和白模渲出来的
 * 画面对不上（seg1 标的是鬼面客，画面里占主导的却是蓝色假人；seg3 反过来）。按元数据喂
 * 角色图就会喂错人。假人是纯色的，直接从画面数颜色对任何项目都成立。
 */
export async function castInFrame(
  framePath: string,
  characters: { key: string; color: string }[],
  minRatio = 0.002,
): Promise<string[]> {
  // 按**色相**匹配，不按 RGB 距离：白模有明暗变化，渲出来的像素和调色板 hex 差很远，
  // 按距离匹配几乎全落空（实测 6 帧里 5 帧检出 0%）。色相对亮度变化不敏感。
  const hueOf = (r: number, g: number, b: number) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
    if (d === 0) return { hue: -1, sat: 0, val: max }
    const hue = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return { hue: hue * 60, sat: d / max, val: max }
  }
  const hueGap = (a: number, b: number) => {
    const d = Math.abs(a - b) % 360
    return d > 180 ? 360 - d : d
  }
  try {
    const { data, info } = await sharp(framePath).resize(320, null, { fit: 'inside' })
      .raw().toBuffer({ resolveWithObject: true })
    const total = info.width * info.height
    const hit = new Map(characters.map((c) => [c.key, 0]))
    const targets = characters.map((c) => {
      const hex = c.color.replace('#', '')
      const t = hueOf(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16))
      return { key: c.key, hue: t.hue }
    })
    for (let i = 0; i < data.length; i += info.channels) {
      const px = hueOf(data[i], data[i + 1], data[i + 2])
      if (px.hue < 0 || px.sat < 0.25 || px.val < 40) continue   // 灰/暗像素不参与
      let best: { key: string; gap: number } | null = null
      for (const t of targets) {
        const gap = hueGap(px.hue, t.hue)
        if (gap < 22 && (!best || gap < best.gap)) best = { key: t.key, gap }
      }
      if (best) hit.set(best.key, (hit.get(best.key) ?? 0) + 1)
    }
    return characters.filter((c) => (hit.get(c.key) ?? 0) / total >= minRatio).map((c) => c.key)
  } catch {
    return []   // 数不出来就别硬猜，调用方会退回 staging 的 subject/partner
  }
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    execFile('ffmpeg', args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) =>
      err ? fail(new Error(`ffmpeg 失败：${String(stderr).slice(-300) || err.message}`)) : ok())
  })
}

/**
 * Per-beat blockout clips for 「按白模重拍」: cut each beat's time interval out of
 * the episode, normalise it for Seedance (24 fps H.264 yuv420p, no audio, padded
 * to ≥4 s / trimmed to ≤15 s) and publish it on the studio's public host —
 * BytePlus can't reach the canvas (IP allowlist) and rejects inline video.
 * Also returns the character colours and shot segments the prompt needs.
 */
async function handleBeats(req: IncomingMessage, res: ServerResponse) {
  const shortId = new URL(req.url ?? '', 'http://x').searchParams.get('shortId') ?? ''
  if (!SHORT_ID_RE.test(shortId)) return sendJson(res, 400, { error: 'shortId 不合法' })
  const dir = runDir(shortId)
  let manifest: { assets?: { key: string; name: string; category: string }[]; beats?: { beat: number; shotId: string; duration: number; continuity?: { characterPositions?: { characterId: string }[] } }[] }
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'canvas-manifest.json'), 'utf8'))
  } catch {
    return sendJson(res, 404, { error: `没有任务 ${shortId}` })
  }
  const episode = [join(dir, 'out', 'episode.mp4'), join(process.cwd(), 'public', 'uploads', `previs-${shortId}.mp4`)].find((p) => existsSync(p))
  if (!episode) return sendJson(res, 409, { error: '这个预演还没有渲染出白模视频' })
  let staging: StagingFile | null = null
  try { staging = JSON.parse(readFileSync(join(dir, 'staging.json'), 'utf8')) } catch { /* older / failed runs */ }

  const fps = staging?.fps || 30
  const manifestChars = (manifest.assets ?? []).filter((a) => a.category === 'character')
  const publishDir = join(STUDIO_ROOT, 'public', 'canvas-import', shortId, 'blockout')
  mkdirSync(publishDir, { recursive: true })
  const episodeMtime = statSync(episode).mtimeMs

  let cursor = 0
  const beats = []
  for (const mb of manifest.beats ?? []) {
    const sb = staging?.beats?.find((b) => b.beat === mb.beat)
    const start = sb?.startFrame !== undefined ? sb.startFrame / fps : cursor
    const duration = sb?.durationFrames ? sb.durationFrames / fps : sb?.duration || mb.duration
    cursor = start + duration

    const file = `beat${String(mb.beat).padStart(2, '0')}.mp4`
    const target = join(publishDir, file)
    if (!existsSync(target) || statSync(target).mtimeMs < episodeMtime) {
      const take = Math.min(duration, REF_VIDEO_MAX_S)
      const pad = Math.max(0, REF_VIDEO_MIN_S - take)
      const tmp = `${target}.tmp.mp4`
      await ffmpeg([
        '-v', 'error', '-y', '-ss', start.toFixed(3), '-i', episode, '-t', take.toFixed(3),
        '-vf', `fps=24${pad ? `,tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}` : ''},format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', '-movflags', '+faststart', tmp,
      ])
      renameSync(tmp, target)
    }

    const keys = sb?.characters ? Object.keys(sb.characters) : (mb.continuity?.characterPositions ?? []).map((p) => p.characterId)
    const characters = keys.map((key) => {
      const sc = staging?.characters?.[key]
      const idx = manifestChars.findIndex((a) => a.key === key)
      const bc = sb?.characters?.[key]
      const clampWindow = (w?: [number, number] | null) =>
        Array.isArray(w) && w.length === 2 && w[1] > w[0]
          ? ([Math.max(0, w[0]), Math.min(w[1], REF_VIDEO_MAX_S)] as [number, number])
          : null
      return {
        key,
        name: sc?.name ?? manifestChars[idx]?.name ?? key,
        color: sc?.color ?? DRAFT_PALETTE[Math.max(0, idx) % DRAFT_PALETTE.length],
        // 表演数据：白模里这个人做了什么、什么时候做。prompt 要把它写成中文，
        // 否则模型只会照着灰模自由发挥。
        motion: bc?.motion ? motionLabel(bc.motion) : null,
        motionWindow: clampWindow(bc?.motionWindow),
        moveWindow: clampWindow(bc?.moveWindow),
        moved: Boolean(bc?.start?.anchor && bc?.end?.anchor && bc.start.anchor !== bc.end.anchor),
        actions: (bc?.actions ?? []).map(actionLabel),
        pose: bc?.pose ?? null,
        poseEnd: bc?.poseEnd ?? null,
      }
    })
    // Second copy under the canvas's own /uploads/ so the canvas page (HTTPS) can
    // play the clip — the studio host is plain HTTP and would be blocked as mixed
    // content. Seedance still gets the studio URL; it can't reach /uploads/.
    // 每个镜头一张定帧：按 staging 的 segment（=硬切边界）取中点帧，没有 segment 时
    // 退回头/中/尾。为什么按镜头取而不是按时间等分：一个 beat 里往往有几次硬切，
    // 每个镜头的机位和景别都不同，按时间切会取到镜头中间的无意义位置，也覆盖不全。
    // 构图必须来自白模，不能来自关键帧 —— 关键帧自带另一套构图。
    const take = Math.min(duration, REF_VIDEO_MAX_S)
    const segs = (sb?.segments ?? []).filter((g) => g.t1 > g.t0 && g.t0 < take)
    const frameAt = segs.length
      ? segs.map((g) => Math.min(take - 0.1, (g.t0 + Math.min(g.t1, take)) / 2))
      : [0.2, take / 2, Math.max(0.3, take - 0.3)]
    const frameUrls: string[] = []
    const framePaths: string[] = []
    for (const [i, at] of frameAt.entries()) {
      const frameFile = `beat${String(mb.beat).padStart(2, '0')}-frame${i}.png`
      const framePath = join(publishDir, frameFile)
      if (!existsSync(framePath) || statSync(framePath).mtimeMs < statSync(target).mtimeMs) {
        const tmpFrame = `${framePath}.tmp.png`
        await ffmpeg(['-v', 'error', '-y', '-ss', at.toFixed(2), '-i', target, '-frames:v', '1', tmpFrame])
        renameSync(tmpFrame, framePath)
      }
      const localFrameFile = `previs-${shortId}-beat${String(mb.beat).padStart(2, '0')}-frame${i}.png`
      const localFramePath = join(process.cwd(), 'public', 'uploads', localFrameFile)
      if (!existsSync(localFramePath) || statSync(localFramePath).mtimeMs < statSync(framePath).mtimeMs) {
        copyFileSync(framePath, localFramePath)
      }
      frameUrls.push(`/uploads/${localFrameFile}`)
      framePaths.push(framePath)
    }

    const localFile = `previs-${shortId}-beat${String(mb.beat).padStart(2, '0')}.mp4`
    const localPath = join(process.cwd(), 'public', 'uploads', localFile)
    if (!existsSync(localPath) || statSync(localPath).mtimeMs < statSync(target).mtimeMs) {
      mkdirSync(dirname(localPath), { recursive: true })
      copyFileSync(target, localPath)
    }
    beats.push({
      beat: mb.beat,
      // 白模素材的年龄：客户端据此提醒「这段白模没有朝向标记」。
      // 按**片段**的时间算，不是 episode —— 片段可以被单独换掉（重渲某一镜时
      // 直接覆盖这里的 mp4），那时 episode 还是旧的，按 episode 判会误报。
      renderedAt: Math.round(statSync(target).mtimeMs),
      facingMarkers: statSync(target).mtimeMs >= FACING_MARKERS_SINCE,
      shotId: mb.shotId,
      start,
      duration,
      // 「Beat 8. 」这种前缀对模型没用，去掉只留内容。
      goal: (sb?.goal ?? '').replace(/^Beat\s*\d+[.:、]?\s*/i, '').trim() || null,
      localUrl: `/uploads/${localFile}`,
      frameUrls,
      // 每张定帧对应的镜头信息：景别用来锁住定帧的景别，主体/对手决定这一帧喂谁的角色图。
      frameShots: await Promise.all(frameAt.map(async (at, i) => ({
        /** 这一帧在 beat 里的秒数。客户端据此算出每个人物的出镜时段。 */
        at,
        shotSize: segs[i]?.shotSize ?? null,
        subject: segs[i]?.subject ?? null,
        partner: segs[i]?.partner ?? null,
        // 真正出场的是谁：直接从画面数假人颜色。staging 的 subject/partner 和渲出来的
        // 画面对不上（beat 3 实测），按它喂角色图会喂错人。
        present: framePaths[i] ? await castInFrame(framePaths[i], characters) : [],
      }))),
      clipUrl: `${STUDIO_PUBLIC_URL}/canvas-import/${shortId}/blockout/${file}?v=${Math.round(statSync(target).mtimeMs)}`,
      characters,
      segments: (sb?.segments ?? []).map((g) => ({
        t0: g.t0,
        t1: Math.min(g.t1, REF_VIDEO_MAX_S),
        shotSize: g.shotSize ?? null,
        cameraMotion: g.cameraMotion?.id ?? null,
        cameraPreset: g.cameraPreset ?? null,
        subject: g.subject ?? null,
        // 这一段谁在画面里。定帧那一步据此只喂在场人物的角色图 —— 不然模型会把
        // 所有给过角色图的人都塞进每一张定帧（实测：单人镜头被画成一群蒙面人）。
        partner: g.partner ?? null,
      })).filter((g) => g.t0 < REF_VIDEO_MAX_S),
    })
  }
  if (beats.length === 0) return sendJson(res, 409, { error: '预演里没有 beat' })

  // Seedance fetches the clip itself; fail here with a readable reason instead of a vague task failure.
  try {
    const probe = await fetch(beats[0].clipUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`)
  } catch (e) {
    return sendJson(res, 503, { error: `白模片段的公网地址访问不到（${(e as Error).message}）：Seedance 只能从公网 URL 读参考视频，确认 3D 导演台（${STUDIO_PUBLIC_URL}）在运行` })
  }
  sendJson(res, 200, { shortId, beats })
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
      server.middlewares.use('/previs/beats', wrap('GET', handleBeats))
    },
  }
}
