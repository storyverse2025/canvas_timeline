import { cn } from '@/lib/utils'
import type { ElementRole } from '@/stores/project-db'

const CATEGORIES: { value: ElementRole | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'character', label: '角色' },
  { value: 'scene', label: '场景' },
  { value: 'prop', label: '道具' },
  { value: 'keyframe', label: 'KF' },
]

interface Props {
  value: ElementRole | 'all'
  onChange: (v: ElementRole | 'all') => void
}

export function CategoryFilter({ value, onChange }: Props) {
  return (
    <div className="flex gap-1 px-2 py-1.5">
      {CATEGORIES.map((c) => (
        <button
          key={c.value}
          className={cn(
            'text-[10px] px-2 py-0.5 rounded-full border transition-colors',
            value === c.value
              ? 'border-primary bg-primary/15 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
          )}
          onClick={() => onChange(c.value)}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}
