import { useEffect, useState } from 'react'
import { X, History, Loader2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { listAllSessions, loadSessionById, type SessionListItem } from '@/lib/session-backup'

interface Props {
  onClose: () => void
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  const sec = Math.round((Date.now() - t) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

/**
 * Lists every server-side session snapshot (one per IP). Picking a row
 * confirms with the user, then overwrites IDB with the chosen snapshot
 * and reloads so Zustand re-hydrates from IDB.
 *
 * The current device's session is highlighted so the user knows which
 * one they're already on.
 */
export function SessionPickerDialog({ onClose }: Props) {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setSessions(await listAllSessions())
      } catch (e) {
        setError((e as Error).message)
      }
    })()
  }, [])

  const handleLoad = async (s: SessionListItem) => {
    const sizeLabel = fmtSize(s.sizeBytes)
    const ok = window.confirm(
      `Load session from ${s.ip} (saved ${fmtRelative(s.savedAt)}, ${sizeLabel})?\n\n` +
        `This will OVERWRITE your current canvas, items, storyboard, and project — ` +
        `the existing IDB state for those stores will be replaced and the page will reload.\n\n` +
        `Continue?`,
    )
    if (!ok) return
    setLoadingId(s.id)
    try {
      const r = await loadSessionById(s.id)
      toast.success(`Restored ${r.restoredKeys.length} store(s) · reloading…`, {
        description: r.restoredKeys.join(', '),
      })
      setTimeout(() => window.location.reload(), 600)
    } catch (e) {
      setLoadingId(null)
      toast.error('Load failed', { description: String((e as Error).message).slice(0, 200) })
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[640px] max-w-full max-h-[80vh] bg-card border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-sm font-medium">
            <History className="w-4 h-4 text-primary" />
            服务器端会话快照 (per-IP)
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-4 py-2 text-[10px] text-muted-foreground border-b border-border/50 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-500" />
          <div>
            每次画布 / 表格 / 项目变动会自动保存到服务器 (per-IP)。
            选择一条记录后会覆盖本机当前状态并刷新页面，慎选。
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {error ? (
            <div className="p-6 text-xs text-destructive">读取列表失败：{error}</div>
          ) : sessions === null ? (
            <div className="p-6 flex items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              读取会话列表…
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-6 text-xs text-muted-foreground text-center">
              服务器还没有任何会话快照。
              <div className="mt-1 opacity-60">至少在本机做过一次会触发自动备份的操作 (改动画布/表格/项目) 之后才会出现。</div>
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-muted-foreground bg-muted/30 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">来源 IP</th>
                  <th className="text-left px-3 py-2 font-medium">标题预览</th>
                  <th className="text-left px-3 py-2 font-medium">保存时间</th>
                  <th className="text-right px-3 py-2 font-medium">大小</th>
                  <th className="text-right px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-t border-border/40 hover:bg-accent/30">
                    <td className="px-3 py-2 font-mono text-foreground/70 whitespace-nowrap">{s.ip}</td>
                    <td className="px-3 py-2 truncate max-w-[220px]" title={s.previewTitle}>
                      {s.previewTitle}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap" title={s.savedAt}>
                      {fmtRelative(s.savedAt)}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{fmtSize(s.sizeBytes)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        className="px-2 py-1 text-[10px] rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
                        disabled={loadingId !== null}
                        onClick={() => handleLoad(s)}
                      >
                        {loadingId === s.id ? <Loader2 className="inline w-3 h-3 animate-spin" /> : '加载并刷新'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
