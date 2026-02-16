import { useCallback } from 'react'
import { TimelineItem } from './TimelineItem'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'

interface TimelineTrackProps {
  width: number
}

export function TimelineTrack({ width }: TimelineTrackProps) {
  const shots = useTimelineStore((s) => s.shots)
  const zoom = useTimelineStore((s) => s.zoom)
  const addShot = useTimelineStore((s) => s.addShot)
  const linkNodeToShot = useTimelineStore((s) => s.linkNodeToShot)
  const addLinkToShot = useMappingStore((s) => s.addLinkToShot)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()

      // Handle drops from canvas nodes
      const canvasNodeId = e.dataTransfer.getData('canvas-node-id')
      if (canvasNodeId) {
        // Find the shot closest to drop position, or create a new one
        const rect = e.currentTarget.getBoundingClientRect()
        const x = e.clientX - rect.left
        const dropTime = x / (50 * zoom)

        let targetShot = shots.find(
          (s) => dropTime >= s.startTime && dropTime < s.startTime + s.duration
        )

        if (!targetShot) {
          // Create a new shot at the end
          const shotId = addShot()
          targetShot = useTimelineStore.getState().getShotById(shotId)
        }

        if (targetShot) {
          linkNodeToShot(targetShot.id, canvasNodeId)
          addLinkToShot(canvasNodeId, targetShot.id)
        }
        return
      }

      // Handle internal shot reorder (handled by items themselves)
    },
    [zoom, shots, addShot, linkNodeToShot, addLinkToShot]
  )

  const handleDragOver = (e: React.DragEvent) => {
    // Accept both canvas-node drops and internal reorders
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  return (
    <div
      className="h-16 relative border-b border-border/50 bg-cyan-500/5"
      style={{ width }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {shots.map((shot) => (
        <TimelineItem key={shot.id} shot={shot} zoom={zoom} />
      ))}
    </div>
  )
}
