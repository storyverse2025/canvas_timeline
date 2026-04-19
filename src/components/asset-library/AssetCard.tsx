import { Image as ImageIcon, MapPin, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Element } from '@/stores/project-db'

const ROLE_LABELS: Record<string, string> = {
  character: '角色', prop: '道具', scene: '场景',
  keyframe: 'KF', 'beat-video': 'Video', script: '剧本', unknown: '',
}
const ROLE_COLORS: Record<string, string> = {
  character: 'bg-purple-500/20 text-purple-300',
  prop: 'bg-amber-500/20 text-amber-300',
  scene: 'bg-emerald-500/20 text-emerald-300',
  keyframe: 'bg-blue-500/20 text-blue-300',
  'beat-video': 'bg-pink-500/20 text-pink-300',
}

interface Props {
  element: Element
  onLocate?: () => void
  onDragStart?: (e: React.DragEvent) => void
}

export function AssetCard({ element, onLocate, onDragStart }: Props) {
  const isImage = element.kind === 'image' && element.content
  const roleLabel = ROLE_LABELS[element.role] ?? ''
  const roleColor = ROLE_COLORS[element.role] ?? 'bg-zinc-500/20 text-zinc-300'

  return (
    <div
      className="group relative rounded-md border border-border bg-card overflow-hidden cursor-grab active:cursor-grabbing"
      draggable={!!onDragStart}
      onDragStart={onDragStart}
    >
      <div className="aspect-square bg-muted flex items-center justify-center overflow-hidden">
        {isImage ? (
          <img src={element.content} alt={element.name} className="w-full h-full object-cover" />
        ) : (
          <ImageIcon className="w-6 h-6 text-muted-foreground" />
        )}
      </div>
      <div className="p-1.5">
        <div className="text-[10px] font-medium truncate">{element.name}</div>
        {roleLabel && (
          <span className={cn('text-[9px] px-1 py-0.5 rounded mt-0.5 inline-block', roleColor)}>
            {roleLabel}
          </span>
        )}
      </div>
      {onLocate && (
        <button
          className="absolute top-1 right-1 p-1 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => { e.stopPropagation(); onLocate() }}
          title="定位到画布"
        >
          <MapPin className="w-3 h-3" />
        </button>
      )}
      {onDragStart && (
        <div className="absolute top-1 left-1 p-0.5 rounded bg-black/40 text-white opacity-0 group-hover:opacity-100 transition-opacity">
          <GripVertical className="w-3 h-3" />
        </div>
      )}
    </div>
  )
}
