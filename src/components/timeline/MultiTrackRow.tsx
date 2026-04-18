import { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { pixelsToTime, timeToPixels } from '@/lib/time-utils'
import { useTimelineStore } from '@/stores/timeline-store'
import { useAssetStore } from '@/stores/asset-store'
import { TrackItemClip } from './TrackItemClip'
import type { Track } from '@/types/timeline'

const TRACK_HEIGHT = 48

interface Props {
  track: Track
  zoom: number
  totalWidth: number
}

export function MultiTrackRow({ track, zoom, totalWidth }: Props) {
  const addItem = useTimelineStore((s) => s.addItem)
  const removeItem = useTimelineStore((s) => s.removeItem)
  const updateItem = useTimelineStore((s) => s.updateItem)
  const moveItem = useTimelineStore((s) => s.moveItem)
  const getAssetById = useAssetStore((s) => s.getAssetById)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('asset-id') || e.dataTransfer.types.includes('text/plain')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const assetId = e.dataTransfer.getData('asset-id')
    if (!assetId) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const startTime = Math.max(0, pixelsToTime(x, zoom))
    const asset = getAssetById(assetId)

    addItem(track.id, {
      assetId,
      startTime,
      duration: 5,
      label: asset?.name ?? '新片段',
    })
  }, [track.id, zoom, addItem, getAssetById])

  return (
    <div
      className={cn(
        'relative border-b border-border/40 bg-card/30 hover:bg-card/40 transition-colors',
      )}
      style={{ height: TRACK_HEIGHT, width: totalWidth }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Grid lines every ~50px */}
      <div className="absolute inset-0 pointer-events-none opacity-10"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, transparent, transparent ${timeToPixels(5, zoom) - 1}px, hsl(var(--border)) ${timeToPixels(5, zoom)}px)`,
        }}
      />

      {track.items.map((item) => {
        const asset = item.assetId ? getAssetById(item.assetId) : undefined
        return (
          <TrackItemClip
            key={item.id}
            item={item}
            zoom={zoom}
            asset={asset}
            onDelete={() => removeItem(item.id)}
            onResize={(dur) => updateItem(item.id, { duration: dur })}
            onMove={(start) => updateItem(item.id, { startTime: start })}
          />
        )
      })}
    </div>
  )
}

export { TRACK_HEIGHT }
