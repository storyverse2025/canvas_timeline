import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import type { VideoShot } from '@/types/backend'
import type { ScriptNodeData, VisualAssetNodeData } from '@/types/canvas'

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
  const canvasStore = useCanvasStore.getState()
  const timelineStore = useTimelineStore.getState()

  const shots: VideoShot[] = []

  // Sort shots by start time (they should already be ordered)
  const sortedShots = [...timelineStore.shots].sort((a, b) => a.startTime - b.startTime)

  for (const shot of sortedShots) {
    let keyframeUrl: string | undefined
    let prompt = ''
    let dialogue: string | undefined

    for (const nodeId of shot.linkedNodeIds) {
      const node = canvasStore.nodes.find((n) => n.id === nodeId)
      if (!node) continue

      if (node.type === 'visual') {
        const data = node.data as unknown as VisualAssetNodeData
        keyframeUrl = data.imageUrl
        prompt = data.prompt || data.label
      }

      if (node.type === 'script') {
        const data = node.data as unknown as ScriptNodeData
        dialogue = data.characterName
          ? `${data.characterName}: ${data.content}`
          : data.content
      }
    }

    const beatMatch = shot.label.match(/\d+/)
    const beatNumber = beatMatch ? parseInt(beatMatch[0]) : shots.length + 1

    shots.push({
      beat_number: beatNumber,
      duration_seconds: shot.duration,
      generation_prompt: prompt || shot.label,
      dialogue,
      reference_keyframe_url: keyframeUrl,
    })
  }

  return {
    shots,
    metadata: buildMetadata(shots),
  }
}

function buildMetadata(shots: VideoShot[]) {
  return {
    version: '1.0',
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
