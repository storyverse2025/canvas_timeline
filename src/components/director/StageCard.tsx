import { Loader2, Check, Clock, AlertCircle } from 'lucide-react'
import type { PipelineStage } from '@/lib/director-assistant'
import { cn } from '@/lib/utils'

const STATUS_ICON = {
  pending: Clock,
  running: Loader2,
  done: Check,
  error: AlertCircle,
}

const STATUS_COLOR = {
  pending: 'text-zinc-500',
  running: 'text-amber-400',
  done: 'text-emerald-400',
  error: 'text-destructive',
}

export function StageCard({ stage, isActive }: { stage: PipelineStage; isActive: boolean }) {
  return (
    <div className={cn(
      'rounded-md border p-3',
      isActive ? 'border-primary bg-primary/5' : 'border-border',
    )}>
      <div className="text-xs font-medium mb-2">{stage.label}</div>
      <div className="text-[10px] text-muted-foreground mb-2">{stage.description}</div>
      <div className="flex flex-col gap-1">
        {stage.steps.map((step) => {
          const Icon = STATUS_ICON[step.status]
          return (
            <div key={step.id} className="flex items-center gap-2 text-[11px]">
              <Icon className={cn('w-3 h-3 shrink-0', STATUS_COLOR[step.status], step.status === 'running' && 'animate-spin')} />
              <span className={step.status === 'done' ? 'text-foreground' : 'text-muted-foreground'}>{step.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
