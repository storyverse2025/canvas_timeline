import { useEffect } from 'react'
import { useMappingStore } from '@/stores/mapping-store'
import { useCanvasStore } from '@/stores/canvas-store'

export function useConnectionHighlighter() {
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const links = useMappingStore((s) => s.links)

  useEffect(() => {
    // Remove previous highlights
    document.querySelectorAll('[data-timeline-item]').forEach((el) => {
      el.classList.remove('ring-2', 'ring-primary', 'ring-offset-1')
    })

    // Add highlights to linked timeline items
    for (const nodeId of selectedNodeIds) {
      const nodeLinks = links.filter((l) => l.canvasNodeId === nodeId)
      for (const link of nodeLinks) {
        const el = document.querySelector(`[data-timeline-item="${link.timelineItemId}"]`)
        if (el) {
          el.classList.add('ring-2', 'ring-primary', 'ring-offset-1')
        }
      }
    }

    return () => {
      document.querySelectorAll('[data-timeline-item]').forEach((el) => {
        el.classList.remove('ring-2', 'ring-primary', 'ring-offset-1')
      })
    }
  }, [selectedNodeIds, links])
}
