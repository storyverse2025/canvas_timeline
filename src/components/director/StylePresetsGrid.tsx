import { cn } from '@/lib/utils'

const PRESETS = [
  { id: 'cinematic', label: '电影感', emoji: '🎬' },
  { id: 'anime', label: '动漫风', emoji: '🎌' },
  { id: 'realistic', label: '写实', emoji: '📷' },
  { id: 'watercolor', label: '水彩', emoji: '🎨' },
  { id: 'pixel-art', label: '像素', emoji: '👾' },
  { id: '3d-render', label: '3D渲染', emoji: '🧊' },
  { id: 'comic', label: '漫画', emoji: '💬' },
  { id: 'oil-painting', label: '油画', emoji: '🖼️' },
  { id: 'gothic', label: '哥特', emoji: '🦇' },
  { id: 'cyberpunk', label: '赛博朋克', emoji: '🌃' },
]

interface Props {
  value: string
  onChange: (id: string) => void
}

export function StylePresetsGrid({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          className={cn(
            'flex flex-col items-center gap-0.5 p-2 rounded-md border text-[10px] transition-colors',
            value === p.id
              ? 'border-primary bg-primary/15 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/30',
          )}
          onClick={() => onChange(p.id)}
        >
          <span className="text-lg">{p.emoji}</span>
          <span>{p.label}</span>
        </button>
      ))}
    </div>
  )
}
