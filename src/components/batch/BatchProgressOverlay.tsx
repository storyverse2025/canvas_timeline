import { X, Check, Loader2, AlertCircle, Clock } from 'lucide-react'
import type { BatchState } from '@/hooks/useBatchGenerate'

const STATUS_ICON = { pending: Clock, running: Loader2, done: Check, error: AlertCircle }
const STATUS_COLOR = { pending: 'text-zinc-500', running: 'text-amber-400', done: 'text-emerald-400', error: 'text-destructive' }

interface Props {
  batch: BatchState
  onClose: () => void
}

export function BatchProgressOverlay({ batch, onClose }: Props) {
  const pct = batch.totalCount > 0 ? Math.round((batch.completedCount / batch.totalCount) * 100) : 0
  const label = batch.type === 'keyframe' ? 'Keyframe' : 'Beat Video'

  return (
    <div className="absolute inset-0 z-20 bg-black/70 backdrop-blur-sm flex items-center justify-center">
      <div className="w-[400px] max-w-full bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3 max-h-[70vh] overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">批量生成 {label}</span>
          {!batch.isRunning && (
            <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{batch.completedCount}/{batch.totalCount}</span>
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          <span>{pct}%</span>
        </div>

        <div className="flex-1 overflow-auto flex flex-col gap-1">
          {batch.jobs.map((job) => {
            const Icon = STATUS_ICON[job.status]
            return (
              <div key={job.rowId} className="flex items-center gap-2 text-xs py-0.5">
                <Icon className={`w-3 h-3 shrink-0 ${STATUS_COLOR[job.status]} ${job.status === 'running' ? 'animate-spin' : ''}`} />
                <span className="flex-1">{job.shotNumber}</span>
                {job.error && <span className="text-destructive text-[10px] truncate max-w-[150px]">{job.error}</span>}
              </div>
            )
          })}
        </div>

        {batch.isRunning ? (
          <button className="w-full py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>
            后台运行
          </button>
        ) : (
          <button className="w-full py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90" onClick={onClose}>
            完成
          </button>
        )}
      </div>
    </div>
  )
}
