import type { PipelineState } from '@/lib/director-assistant'
import { StageCard } from './StageCard'

interface Props {
  state: PipelineState
}

export function DirectorPipelineProgress({ state }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">进度</span>
        <span className="font-mono">{state.progress}%</span>
      </div>
      <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${state.progress}%` }}
        />
      </div>

      <div className="flex flex-col gap-2">
        {state.stages.map((stage, i) => (
          <StageCard key={stage.id} stage={stage} isActive={i === state.currentStage} />
        ))}
      </div>

      {state.issues.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
          <div className="text-[10px] font-medium text-amber-300 mb-1">自检发现 {state.issues.length} 个问题</div>
          {state.issues.map((issue, i) => (
            <div key={i} className="text-[10px] text-amber-200/80">• {issue}</div>
          ))}
        </div>
      )}

      {state.fixes.length > 0 && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
          <div className="text-[10px] font-medium text-emerald-300 mb-1">已修复</div>
          {state.fixes.map((fix, i) => (
            <div key={i} className="text-[10px] text-emerald-200/80">• {fix}</div>
          ))}
        </div>
      )}
    </div>
  )
}
