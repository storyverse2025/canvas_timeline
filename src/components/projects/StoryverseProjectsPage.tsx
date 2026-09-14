import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, Clapperboard, Download, Image as ImageIcon, Layers,
  Loader2, RefreshCw, Search, Video,
} from 'lucide-react'
import { toast } from 'sonner'
import { useReactFlow } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { useViewStore } from '@/stores/view-store'
import { fetchStoryverseProject, listStoryverseProjects } from '@/lib/storyverse-import/client'
import { applyStoryverseImport } from '@/lib/storyverse-import/apply-import'
import type { SvProjectSummary } from '@/lib/storyverse-import/types'

const PAGE_SIZE = 40

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso || '—'
  const sec = Math.round((Date.now() - t) / 1000)
  if (sec < 60) return `${sec} 秒前`
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时前`
  if (sec < 86400 * 30) return `${Math.round(sec / 86400)} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

/**
 * `have` is how many of `value` rows actually carry media. Lots of upstream
 * projects have 13 分镜 rows and 1 rendered storyboard image, so showing only
 * the row count promises pictures the database doesn't have.
 */
function Stat({ Icon, value, have, title }: { Icon: React.ElementType; value: number; have?: number; title: string }) {
  const partial = have !== undefined && have < value
  return (
    <span
      className={cn('inline-flex items-center gap-1 tabular-nums', value === 0 && 'opacity-30')}
      title={have !== undefined ? `${title}：${value} 行，其中 ${have} 个有图/有视频` : title}
    >
      <Icon className="w-3 h-3" />
      {have !== undefined ? (
        <span className={cn(partial && 'text-amber-500/90')}>
          {have}
          <span className="opacity-50">/{value}</span>
        </span>
      ) : (
        value
      )}
    </span>
  )
}

/**
 * StoryVerse 项目库 — the read-only mirror of
 * https://storyverse-monorepo-web.vercel.app/admin/projects.
 *
 * Lists every project in the production Supabase database sorted by 活跃时间
 * (updated_at desc) and imports the one you pick into 画布 / 分镜表 / 时间轴 in
 * a single click. Nothing here ever writes upstream — the dev-server bridge
 * only issues GETs.
 */
export function StoryverseProjectsPage() {
  const [projects, setProjects] = useState<SvProjectSummary[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [localizeVideos, setLocalizeVideos] = useState(false)
  const setActiveTab = useViewStore((s) => s.setActiveTab)
  const reactFlow = useReactFlow()
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (nextOffset: number, q: string) => {
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    setLoading(true)
    setError(null)
    try {
      const r = await listStoryverseProjects({ limit: PAGE_SIZE, offset: nextOffset, q }, ctl.signal)
      setProjects(r.projects)
      setTotal(r.total)
      setOffset(r.offset)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError((e as Error).message)
      setProjects([])
    } finally {
      if (!ctl.signal.aborted) setLoading(false)
    }
  }, [])

  // Initial fetch + debounced search in one effect. The list is 800+ projects,
  // so filtering happens server-side rather than over whatever page happens to
  // be loaded. The first run fires immediately; typing debounces.
  const mounted = useRef(false)
  useEffect(() => {
    const delay = mounted.current ? 300 : 0
    mounted.current = true
    const t = setTimeout(() => { void load(0, query) }, delay)
    return () => clearTimeout(t)
  }, [query, load])

  useEffect(() => () => abortRef.current?.abort(), [])

  const handleImport = useCallback(async (p: SvProjectSummary) => {
    if (importingId) return
    const missing: string[] = []
    if (p.frameImages < p.frames) missing.push(`${p.frames - p.frameImages} 个分镜在线上没有分镜图`)
    if (p.shotVideos < p.shots) missing.push(`${p.shots - p.shotVideos} 个镜头在线上没有视频`)
    const ok = window.confirm(
      `导入「${p.title}」？\n\n` +
        `将写入 ${p.frames} 个分镜 / ${p.assets} 个素材 / ` +
        `${p.frameImages} 张分镜图 / ${p.shotVideos} 条镜头视频。\n` +
        (missing.length ? `（${missing.join('；')}——导入后这些格子会是空的）\n` : '') +
        `\n` +
        `⚠️ 当前画布、分镜表、时间轴、聊天记录会被清空并替换（不可撤销）。\n` +
        `当前会话的服务器快照会保留，导入后会进入一个新的会话槽。\n\n` +
        `StoryVerse 数据库为只读访问，导入不会修改线上任何记录。`,
    )
    if (!ok) return

    setImportingId(p.id)
    setProgress('读取项目数据并下载素材…')
    try {
      const bundle = await fetchStoryverseProject(p.id, { localizeVideos })
      setProgress('写入画布 / 分镜表 / 时间轴…')
      const mapped = await applyStoryverseImport(bundle)
      const s = mapped.summary
      toast.success(`已导入「${bundle.project.title}」`, {
        description:
          `${s.rows} 个分镜 · ${s.assets} 个素材 · ${s.keyframes} 张分镜图 · ` +
          `${s.videos} 条视频 · ${s.linkedSlots} 个角色/道具/场景引用` +
          (s.referenceOnlyImages ? ` · ${s.referenceOnlyImages} 张历史版本参考图` : ''),
      })
      setActiveTab('canvas')
      // AssetCanvas's own NewNodeAutoFit can't help here: it fires while the
      // canvas tab is still display:none, so ReactFlow measures a 0×0 viewport
      // and the freshly imported graph ends up off-screen. Refit once the tab
      // is actually laid out.
      setTimeout(() => reactFlow.fitView({ duration: 400, padding: 0.2 }), 250)
    } catch (e) {
      toast.error('导入失败', { description: String((e as Error).message).slice(0, 300) })
    } finally {
      setImportingId(null)
      setProgress('')
    }
  }, [importingId, localizeVideos, setActiveTab, reactFlow])

  const pageLabel = useMemo(() => {
    if (!projects?.length) return ''
    const from = offset + 1
    const to = offset + projects.length
    return total ? `${from}–${to} / 约 ${total}` : `${from}–${to}`
  }, [projects, offset, total])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Clapperboard className="w-4 h-4 text-primary" />
          StoryVerse 项目库
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目标题…"
            className="w-full h-8 pl-8 pr-3 text-xs rounded-md bg-secondary/50 border border-border focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer" title="默认保留线上签名链接（有效期到 2031 年）。勾选后把视频一并下载到本地 /uploads，导入会明显变慢。">
          <input
            type="checkbox"
            checked={localizeVideos}
            onChange={(e) => setLocalizeVideos(e.target.checked)}
            className="accent-primary"
          />
          视频也下载到本地
        </label>
        <button
          onClick={() => void load(offset, query)}
          disabled={loading}
          className="h-8 px-2.5 text-xs rounded-md border border-border hover:bg-secondary/60 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          刷新
        </button>
      </div>

      {/* Read-only banner */}
      <div className="px-4 py-2 text-[10px] text-muted-foreground border-b border-border/50 flex items-start gap-1.5 shrink-0">
        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-500" />
        <div>
          按<span className="text-foreground/80">活跃时间</span>排序，直接读取线上 Supabase（<span className="font-mono">只读 GET</span>，不会写入或修改任何线上记录）。
          点击「导入」会把该项目的素材、提示词、分镜与镜头视频写入本地画布 / 分镜表 / 时间轴，并<span className="text-foreground/80">清空当前工作区</span>。
          「分镜」「镜头」两列显示的是<span className="text-foreground/80">有图 / 有视频的数量 ÷ 总行数</span>——线上很多项目是直接从参考图出视频的，本来就没有渲染过分镜图，导入不会凭空造出来。
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-6 text-xs text-destructive">
            读取项目列表失败：{error}
            <div className="mt-2 text-muted-foreground">
              请确认 .env 里的 <span className="font-mono">SUPABASE_URL</span> /
              <span className="font-mono"> SUPABASE_SERVICE_ROLE_KEY</span> 已配置，并且 vite dev server 已重启。
            </div>
          </div>
        ) : projects === null ? (
          <div className="p-10 flex items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            读取项目列表…
          </div>
        ) : projects.length === 0 ? (
          <div className="p-10 text-xs text-muted-foreground text-center">
            {query ? `没有标题匹配「${query}」的项目。` : '数据库里还没有项目。'}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase text-muted-foreground bg-muted/30 sticky top-0 z-10">
              <tr>
                <th className="text-left px-4 py-2 font-medium">项目</th>
                <th className="text-left px-3 py-2 font-medium w-28">状态</th>
                <th className="text-left px-3 py-2 font-medium w-56">内容</th>
                <th className="text-left px-3 py-2 font-medium w-28">最近活跃</th>
                <th className="text-right px-4 py-2 font-medium w-28">操作</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const empty = p.frames === 0 && p.assets === 0
                const busy = importingId === p.id
                return (
                  <tr key={p.id} className="border-b border-border/40 hover:bg-secondary/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-foreground truncate max-w-[420px]" title={p.title}>
                        {p.title}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground/60">{p.id}</div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{p.status || '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <Stat Icon={Layers} value={p.episodes} title="集数" />
                        <Stat Icon={ImageIcon} value={p.frames} have={p.frameImages} title="分镜" />
                        <Stat Icon={Video} value={p.shots} have={p.shotVideos} title="镜头" />
                        <Stat Icon={Clapperboard} value={p.assets} title="素材（角色/场景/道具）" />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap" title={p.updatedAt}>
                      {fmtRelative(p.updatedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => void handleImport(p)}
                        disabled={!!importingId || empty}
                        title={empty ? '这个项目还没有分镜或素材可导入' : '导入到画布 / 分镜表 / 时间轴'}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors',
                          'bg-primary/10 text-primary hover:bg-primary/20',
                          'disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground',
                        )}
                      >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                        {busy ? '导入中' : '导入'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer / pagination */}
      <div className="h-9 border-t border-border px-4 flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
        <span>{pageLabel}</span>
        {importingId && progress && (
          <span className="inline-flex items-center gap-1.5 text-primary">
            <Loader2 className="w-3 h-3 animate-spin" />
            {progress}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void load(Math.max(0, offset - PAGE_SIZE), query)}
          disabled={loading || offset === 0}
          className="px-2 py-0.5 rounded border border-border hover:bg-secondary/60 disabled:opacity-40"
        >
          上一页
        </button>
        <button
          onClick={() => void load(offset + PAGE_SIZE, query)}
          disabled={loading || !projects || projects.length < PAGE_SIZE}
          className="px-2 py-0.5 rounded border border-border hover:bg-secondary/60 disabled:opacity-40"
        >
          下一页
        </button>
      </div>
    </div>
  )
}
