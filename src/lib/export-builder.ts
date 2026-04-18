import { useAssetStore } from '@/stores/asset-store'
import { useTimelineStore } from '@/stores/timeline-store'
import type { VideoShot } from '@/types/backend'

export interface ExportData {
  shots: VideoShot[]
  metadata: {
    version: string
    exportedAt: string
    totalDuration: number
    shotCount: number
  }
}

export function buildExport(): ExportData {
  const assetStore = useAssetStore.getState()
  const timelineStore = useTimelineStore.getState()

  const shots: VideoShot[] = []

  // Build shots from keyframe track items
  const keyframeTrack = timelineStore.tracks.find((t) => t.type === 'keyframe')
  const keyframeItems = keyframeTrack
    ? [...keyframeTrack.items].sort((a, b) => a.startTime - b.startTime)
    : []

  for (const item of keyframeItems) {
    const asset = item.assetId ? assetStore.getAssetById(item.assetId) : undefined
    const beatMatch = item.label.match(/\d+/)
    const beatNumber = beatMatch ? parseInt(beatMatch[0]) : shots.length + 1

    shots.push({
      beat_number: beatNumber,
      duration_seconds: item.duration,
      generation_prompt: asset?.prompt || asset?.description || item.label,
      reference_keyframe_url: asset?.imageUrl,
    })
  }

  return {
    shots,
    metadata: buildMetadata(shots),
  }
}

function buildMetadata(shots: VideoShot[]) {
  return {
    version: '2.0',
    exportedAt: new Date().toISOString(),
    totalDuration: shots.reduce((sum, s) => sum + s.duration_seconds, 0),
    shotCount: shots.length,
  }
}

export function downloadExportJson(data: ExportData, filename = 'videoshot.json') {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
