import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import { Loader2, CheckCircle2, XCircle, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export function LibtvTasksPanel() {
  const tasks = useLibtvTasksStore((s) => s.tasks)
  const removeTask = useLibtvTasksStore((s) => s.removeTask)
  const entries = Object.values(tasks).sort((a, b) => b.createdAt - a.createdAt)
  if (entries.length === 0) return null

  return (
    <div className="absolute bottom-16 right-4 z-10 w-[280px] max-h-[260px] overflow-auto rounded-md border border-border bg-card/95 backdrop-blur shadow-lg text-xs">
      <div className="px-3 py-2 border-b border-border font-medium flex items-center justify-between">
        <span>LibTV 任务 ({entries.length})</span>
      </div>
      {entries.map((t) => (
        <div key={t.id} className="px-3 py-2 border-b border-border last:border-0 flex items-start gap-2">
          <div className="mt-0.5">
            {t.status === 'pending' || t.status === 'polling' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
            ) : t.status === 'done' ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-destructive" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="truncate" title={t.prompt}>{t.prompt}</div>
            <div
              className={cn('text-[10px] mt-0.5 break-words', t.status === 'failed' ? 'text-destructive font-medium' : 'text-muted-foreground')}
              title={t.error ?? ''}
            >
              {t.status === 'pending' && '创建会话…'}
              {t.status === 'polling' && '生成中…'}
              {t.status === 'done' && '完成'}
              {t.status === 'failed' && `❌ ${(t.error ?? 'failed').slice(0, 200)}`}
            </div>
          </div>
          <button className="opacity-50 hover:opacity-100" onClick={() => removeTask(t.id)}>
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
