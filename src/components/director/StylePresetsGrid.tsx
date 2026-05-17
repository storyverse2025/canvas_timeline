import { useMemo, useState } from 'react'

import {
  STYLE_LIBRARY_DEFAULT_ID,
  isPhotorealRiskPreset,
  listStylePresets,
  styleDisplayLabel,
  type StyleCategory,
  type StylePresetDefinition,
} from '@/lib/style-library'
import { cn } from '@/lib/utils'

interface Props {
  value: string
  onChange: (id: string) => void
}

const CATEGORY_TABS: Array<{ id: StyleCategory | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: '2d', label: '2D 动漫' },
  { id: '3d', label: '3D 动画' },
  { id: 'live_action', label: '实拍质感' },
]

export function StylePresetsGrid({ value, onChange }: Props) {
  const [tab, setTab] = useState<StyleCategory | 'all'>('all')
  const all = useMemo(() => listStylePresets(), [])
  const filtered = useMemo(
    () => (tab === 'all' ? all : all.filter((p) => p.category === tab)),
    [all, tab],
  )

  // If the current value isn't in the library, fall back to default silently
  // — never crash the panel because someone has a legacy 'cinematic' preset.
  const effectiveValue = all.find((p) => p.style_id === value)?.style_id ?? STYLE_LIBRARY_DEFAULT_ID

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        {CATEGORY_TABS.map((t) => (
          <button
            key={t.id}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded border',
              tab === t.id
                ? 'border-primary bg-primary/15 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
            )}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="max-h-64 overflow-y-auto grid grid-cols-2 gap-1.5 pr-1">
        {filtered.map((p) => (
          <PresetCard
            key={p.style_id}
            preset={p}
            selected={effectiveValue === p.style_id}
            onSelect={() => onChange(p.style_id)}
          />
        ))}
      </div>
    </div>
  )
}

function PresetCard({
  preset,
  selected,
  onSelect,
}: {
  preset: StylePresetDefinition
  selected: boolean
  onSelect: () => void
}) {
  const risk = isPhotorealRiskPreset(preset.style_id)
  return (
    <button
      onClick={onSelect}
      title={preset.global_style_guide.goal}
      className={cn(
        'flex flex-col items-start gap-0.5 p-2 rounded border text-left text-[10px] leading-tight transition-colors',
        selected
          ? 'border-primary bg-primary/15 text-primary'
          : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
      )}
    >
      <span className="flex items-center gap-1 font-medium">
        <span>{CATEGORY_EMOJI[preset.category]}</span>
        <span className="line-clamp-2">{styleDisplayLabel(preset)}</span>
      </span>
      {risk && (
        <span className="text-[9px] text-amber-400/80">
          CG 风格化保护：避免被识别为真人
        </span>
      )}
    </button>
  )
}

const CATEGORY_EMOJI: Record<StyleCategory, string> = {
  '2d': '🎌',
  '3d': '🧊',
  live_action: '🎬',
}
