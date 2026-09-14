import { v4 as uuid } from 'uuid'
import { toast } from 'sonner'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useProjectDB } from '@/stores/project-db'
import { usePrevisRunsStore, type PrevisRun } from '@/stores/previs-runs-store'
import { buildPrevisManifest, PrevisManifestError } from './build-manifest'

/**
 * Browser half of 画布「生成 3D 预演」: build the manifest from the current
 * selection, start the headless run on the dev server, drop a placeholder
 * video node wired to its sources, and poll until the low-poly previs mp4 and
 * the 3D 导演台 session link come back. Server half: vite-previs-plugin.ts.
 */

const POLL_MS = 5000
const polling = new Set<string>()

interface ServerStatus {
  status: 'running' | 'done' | 'error' | 'unknown'
  phase: string
  toolCalls: number
  mp4Url: string | null
  sessionUrl: string | null
  bundleUrl: string | null
  reportUrl: string | null
  notes: string | null
  error: string | null
}

async function postJson(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

function nodeSize(nodeId: string) {
  const n = useCanvasStore.getState().nodes.find((x) => x.id === nodeId)
  return {
    x: n?.position.x ?? 0,
    y: n?.position.y ?? 0,
    w: Number(n?.style?.width ?? n?.width ?? 320),
    h: Number(n?.style?.height ?? n?.height ?? 200),
  }
}

/**
 * Start a previs run for `videoNodeId` plus whatever else is selected on the
 * canvas (more beat videos → more beats; character / scene / prop nodes → extra
 * cast and set for videos whose storyboard row doesn't name them).
 */
export async function startPrevisFromSelection(videoNodeId: string): Promise<void> {
  const canvas = useCanvasStore.getState()
  const items = useCanvasItemStore.getState().items
  const selected = new Set(canvas.nodes.filter((n) => n.selected).map((n) => n.id))
  selected.add(videoNodeId)

  const videoNodeIds: string[] = []
  const assetNodeIds: string[] = []
  for (const id of selected) {
    const node = canvas.nodes.find((n) => n.id === id)
    const item = node?.data.itemId ? items[String(node.data.itemId)] : undefined
    if (!item) continue
    if (item.kind === 'video' && item.role !== 'beat-video-alternate') videoNodeIds.push(id)
    else if (item.kind === 'image') assetNodeIds.push(id)
  }
  // Keep the clicked video first among equals; the builder re-sorts by storyboard order.
  videoNodeIds.sort((a, b) => (a === videoNodeId ? -1 : b === videoNodeId ? 1 : 0))

  const db = useProjectDB.getState()
  const runId = uuid()
  let built
  try {
    built = buildPrevisManifest({
      runId,
      videoNodeIds,
      assetNodeIds,
      nodes: canvas.nodes,
      items,
      rows: useStoryboardStore.getState().rows,
      title: db.script.sessionTitle,
      aspectRatio: db.artDirection.defaultAspectRatio,
    })
  } catch (e) {
    if (e instanceof PrevisManifestError) {
      toast.error('无法生成 3D 预演', { description: e.message })
      return
    }
    throw e
  }
  const { manifest, shortId, images, warnings } = built

  const started = await postJson('/previs/run', { shortId, manifest, images })
  if (!started.ok) {
    toast.error('3D 预演没有启动', { description: String(started.data.error ?? `HTTP ${started.status}`) })
    return
  }

  // Placeholder result node to the right of the right-most source video.
  const anchor = videoNodeIds.map(nodeSize).reduce((best, s) => (s.x + s.w > best.x + best.w ? s : best))
  const firstVideo = items[String(canvas.nodes.find((n) => n.id === videoNodeIds[0])?.data.itemId)]
  const itemStore = useCanvasItemStore.getState()
  const itemId = itemStore.addItem({
    kind: 'video',
    name: `3D预演 · ${firstVideo?.name ?? shortId}${manifest.beats.length > 1 ? ` 等${manifest.beats.length}镜` : ''}`,
    content: '',
    role: 'beat-video-alternate',
    prompt: manifest.beats.map((b) => b.prompt).filter(Boolean).join('\n\n'),
    description: `3D 导演台低模预演 · 生成中（任务 ${shortId}）`,
    provider: 'storyai-director-studio',
    model: 'previs-mcp',
  })
  const nodeId = useCanvasStore.getState().addItemNode(itemId, 'video', { x: anchor.x + anchor.w + 80, y: anchor.y }, { width: 360, height: 220 })

  // Wire every source into the result so the derivation reads on canvas.
  const nodeOfItem = new Map(useCanvasStore.getState().nodes.map((n) => [String(n.data.itemId ?? ''), n.id]))
  const sources = new Set<string>(videoNodeIds)
  for (const a of manifest.assets) {
    const src = nodeOfItem.get(a.id)
    if (src) sources.add(src)
  }
  for (const src of sources) useCanvasStore.getState().addEdge(src, nodeId)

  usePrevisRunsStore.getState().addRun({
    shortId, itemId, nodeId, status: 'running', phase: '启动 Claude', toolCalls: 0, startedAt: Date.now(),
  })
  toast.success('已开始生成 3D 预演', {
    description: `${manifest.beats.length} 个镜头 · ${manifest.assets.length} 个素材 · 本地 Claude 正在 3D 导演台里搭场景（几分钟）` +
      (warnings.length ? `\n注意：${warnings.slice(0, 3).join('；')}` : ''),
  })
  void pollRun(shortId)
}

async function pollRun(shortId: string): Promise<void> {
  if (polling.has(shortId)) return
  polling.add(shortId)
  try {
    for (;;) {
      const run = usePrevisRunsStore.getState().runs[shortId]
      if (!run || run.status !== 'running') return
      if (!useCanvasItemStore.getState().items[run.itemId]) {
        // Result node was deleted: stop watching, leave the server run alone.
        usePrevisRunsStore.getState().removeRun(shortId)
        return
      }
      let status: ServerStatus | null = null
      try {
        const res = await fetch(`/previs/status?shortId=${shortId}`, { cache: 'no-store' })
        if (res.status === 404) {
          finishWithError(run, '服务端找不到这个任务（work 目录被清理了？）')
          return
        }
        if (res.ok) status = await res.json()
      } catch {
        /* dev server restarting — try again next tick */
      }
      if (status) {
        if (status.status === 'done' && status.mp4Url) {
          finishDone(run, status)
          return
        }
        if (status.status === 'error') {
          finishWithError(run, status.error ?? '未知错误', status)
          return
        }
        usePrevisRunsStore.getState().updateRun(shortId, { phase: status.phase, toolCalls: status.toolCalls })
      }
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  } finally {
    polling.delete(shortId)
  }
}

function finishDone(run: PrevisRun, status: ServerStatus) {
  const sessionUrl = status.sessionUrl ?? undefined
  const bundleUrl = status.bundleUrl ?? undefined
  const reportUrl = status.reportUrl ?? undefined
  useCanvasItemStore.getState().updateItem(run.itemId, {
    content: status.mp4Url!,
    sessionUrl,
    bundleUrl,
    reportUrl,
    description: `3D 导演台低模预演${status.notes ? ` · ${status.notes}` : ''}`,
  })
  usePrevisRunsStore.getState().updateRun(run.shortId, { status: 'done', phase: '完成', mp4Url: status.mp4Url!, sessionUrl, bundleUrl, reportUrl })
  toast.success('3D 预演已完成', {
    description: sessionUrl ? '节点上点「3D」可在 3D 导演台里继续编辑' : '（没有生成可编辑的会话包）',
    action: sessionUrl ? { label: '打开 3D 导演台', onClick: () => window.open(sessionUrl, '_blank', 'noopener') } : undefined,
  })
}

function finishWithError(run: PrevisRun, error: string, status?: Pick<ServerStatus, 'sessionUrl' | 'bundleUrl' | 'reportUrl'>) {
  const sessionUrl = status?.sessionUrl ?? undefined
  const bundleUrl = status?.bundleUrl ?? undefined
  const reportUrl = status?.reportUrl ?? undefined
  // A run can fail at render after staging/building succeeded and still leave an
  // openable session — keep the 3D link so the user can finish it by hand.
  useCanvasItemStore.getState().updateItem(run.itemId, { description: `3D 预演失败：${error}`, ...(sessionUrl ? { sessionUrl } : {}), ...(bundleUrl ? { bundleUrl } : {}), ...(reportUrl ? { reportUrl } : {}) })
  usePrevisRunsStore.getState().updateRun(run.shortId, { status: 'error', error, phase: '失败', sessionUrl, bundleUrl, reportUrl })
  toast.error('3D 预演失败', {
    description: error.slice(0, 300) + (sessionUrl ? '\n场景已搭好，可在 3D 导演台里打开继续' : ''),
    action: sessionUrl ? { label: '打开 3D 导演台', onClick: () => window.open(sessionUrl, '_blank', 'noopener') } : undefined,
  })
}

export async function cancelPrevisRun(shortId: string): Promise<void> {
  await postJson(`/previs/cancel?shortId=${shortId}`).catch(() => null)
  const run = usePrevisRunsStore.getState().runs[shortId]
  if (run) finishWithError(run, '已取消')
}

/** Resume polling for runs that were still going when the page was reloaded. */
export function resumePrevisRuns(): void {
  for (const run of Object.values(usePrevisRunsStore.getState().runs)) {
    if (run.status === 'running') void pollRun(run.shortId)
    // Results finished before the .previs.json download existed: every run with a
    // session also has a bundle, so backfill the link.
    else if (run.sessionUrl && !run.bundleUrl) {
      const bundleUrl = `/previs/bundle?shortId=${run.shortId}`
      usePrevisRunsStore.getState().updateRun(run.shortId, { bundleUrl })
      if (useCanvasItemStore.getState().items[run.itemId]) useCanvasItemStore.getState().updateItem(run.itemId, { bundleUrl })
    }
    // A report can appear after the node finished (older runs, reports built later).
    if (run.status === 'done' && !run.reportUrl) void backfillReport(run)
  }
}

async function backfillReport(run: PrevisRun): Promise<void> {
  try {
    const res = await fetch(`/previs/status?shortId=${run.shortId}`)
    if (!res.ok) return
    const status = (await res.json()) as ServerStatus
    if (!status.reportUrl) return
    usePrevisRunsStore.getState().updateRun(run.shortId, { reportUrl: status.reportUrl })
    if (useCanvasItemStore.getState().items[run.itemId]) useCanvasItemStore.getState().updateItem(run.itemId, { reportUrl: status.reportUrl })
  } catch {
    /* offline / dev server restarting — next load retries */
  }
}
