import { useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeToPixels, pixelsToTime } from '@/lib/time-utils'
import { useViewStore } from '@/stores/view-store'
import type { TimelineItem, TrackType } from '@/types/timeline'
import type { Asset } from '@/types/asset'

const TRACK_COLORS: Record<TrackType, string> = {
  keyframe:  'bg-violet-600/80 border-violet-400/60 hover:bg-violet-600/90',
  bgm:       'bg-amber-600/80 border-amber-400/60 hover:bg-amber-600/90',
  dialogue:  'bg-emerald-600/80 border-emerald-400/60 hover:bg-emerald-600/90',
  video:     'bg-blue-600/80 border-blue-400/60 hover:bg-blue-600/90',
}

interface Props {
  item: TimelineItem
  zoom: number
  asset?: Asset
  onDelete: () => void
  onResize: (newDuration: number) => void
  onMove: (newStartTime: number) => void
}

export function TrackItemClip({ item, zoom, asset, onDelete, onResize, onMove }: Props) {
  const selectedAssetIds = useViewStore((s) => s.selectedAssetIds)
  const setSelectedAssetIds = useViewStore((s) => s.setSelectedAssetIds)

  const isSelected = item.assetId ? selectedAssetIds.includes(item.assetId) : false
  const x = timeToPixels(item.startTime, zoom)
  const width = Math.max(timeToPixels(item.duration, zoom), 20)
  const colorClass = TRACK_COLORS[item.type] ?? TRACK_COLORS.video

  const dragStartX = useRef(0)
  const dragStartTime = useRef(0)
  const resizeStartX = useRef(0)
  const resizeStartDuration = useRef(0)

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (item.assetId) {
      setSelectedAssetIds([item.assetId])
    }
  }, [item.assetId, setSelectedAssetIds])

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragStartX.current = e.clientX
    dragStartTime.current = item.startTime

    const onMove_ = (ev: MouseEvent) => {
      const dx = ev.clientX - dragStartX.current
      const dt = pixelsToTime(dx, zoom)
      const newStart = Math.max(0, dragStartTime.current + dt)
      onMove(newStart)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove_)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove_)
    document.addEventListener('mouseup', onUp)
  }, [item.startTime, zoom, onMove])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeStartX.current = e.clientX
    resizeStartDuration.current = item.duration

    const onMove_ = (ev: MouseEvent) => {
      const dx = ev.clientX - resizeStartX.current
      const dt = pixelsToTime(dx, zoom)
      const newDuration = Math.max(1, resizeStartDuration.current + dt)
      onResize(newDuration)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove_)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove_)
    document.addEventListener('mouseup', onUp)
  }, [item.duration, zoom, onResize])

  return (
    <div
      className={cn(
        'absolute top-1 bottom-1 rounded border flex items-center overflow-hidden select-none cursor-grab active:cursor-grabbing group/clip',
        colorClass,
        isSelected && 'ring-2 ring-white ring-offset-1 ring-offset-background'
      )}
      style={{ left: x, width }}
      onClick={handleClick}
      onMouseDown={handleDragStart}
      title={item.label}
    >
      {/* Thumbnail for keyframe clips (asset-backed) */}
      {item.type === 'keyframe' && asset?.thumbnailUrl && (
        <img
          src={asset.thumbnailUrl}
          alt=""
          className="h-full w-8 object-cover shrink-0 opacity-60"
        />
      )}

      {/* Storyboard reference image (data-backed, e.g. 分镜 track items) */}
      {!asset?.thumbnailUrl && typeof item.data?.imageUrl === 'string' && (
        <img
          src={item.data.imageUrl as string}
          alt=""
          className="h-full object-cover shrink-0 opacity-80"
          style={{ width: Math.min(width - 30, 80) }}
        />
      )}

      {/* Label */}
      <span className="text-[10px] font-medium text-white/90 truncate px-1.5 flex-1 pointer-events-none">
        {item.label}
      </span>

      {/* Delete button */}
      <button
        className="opacity-0 group-hover/clip:opacity-100 transition-opacity shrink-0 p-0.5 hover:bg-white/20 rounded mr-0.5"
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
        onClick={(e) => { e.stopPropagation(); onDelete() }}
      >
        <X className="w-2.5 h-2.5 text-white/80" />
      </button>

      {/* Resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize bg-white/20 opacity-0 group-hover/clip:opacity-100 transition-opacity"
        onMouseDown={handleResizeStart}
      />
    </div>
  )
}
