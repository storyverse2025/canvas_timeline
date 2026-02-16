import { Loader2, Check } from 'lucide-react'
import type { SkillProgress as SkillProgressType } from '@/types/chat'

interface SkillProgressProps {
  progress: SkillProgressType
}

export function SkillProgress({ progress }: SkillProgressProps) {
  return (
    <div className="border-t border-border px-3 py-2 bg-secondary/30">
      <div className="flex items-center gap-2 mb-1.5">
        <Loader2 className="w-3 h-3 animate-spin text-primary" />
        <span className="text-[11px] font-medium">{progress.label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {progress.step}/{progress.total}
        </span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: progress.total }, (_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < progress.step
                ? 'bg-primary'
                : i === progress.step
                ? 'bg-primary/50 animate-pulse'
                : 'bg-secondary'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
