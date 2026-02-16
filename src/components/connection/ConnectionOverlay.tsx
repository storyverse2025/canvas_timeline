import { useEffect, useState } from 'react'
import { useMappingStore } from '@/stores/mapping-store'
import { useCanvasStore } from '@/stores/canvas-store'

interface ConnectionOverlayProps {
  containerRef: HTMLDivElement | null
}

interface LineCoords {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export function ConnectionOverlay({ containerRef }: ConnectionOverlayProps) {
  const links = useMappingStore((s) => s.links)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const [lines, setLines] = useState<LineCoords[]>([])

  // Only show connections for selected nodes
  const activeLinks = links.filter((l) => selectedNodeIds.includes(l.canvasNodeId))

  // Calculate line positions
  useEffect(() => {
    if (!containerRef || activeLinks.length === 0) {
      setLines([])
      return
    }

    const newLines: LineCoords[] = []
    const containerRect = containerRef.getBoundingClientRect()

    for (const link of activeLinks) {
      // Find canvas node element
      const nodeEl = containerRef.querySelector(`[data-id="${link.canvasNodeId}"]`)
      // Find timeline shot element (now uses data-timeline-item on shot containers)
      const timelineEl = document.querySelector(`[data-timeline-item="${link.timelineItemId}"]`)

      if (nodeEl && timelineEl) {
        const nodeRect = nodeEl.getBoundingClientRect()
        const timelineRect = timelineEl.getBoundingClientRect()

        newLines.push({
          id: link.id,
          x1: nodeRect.right - containerRect.left,
          y1: nodeRect.top + nodeRect.height / 2 - containerRect.top,
          x2: timelineRect.left + timelineRect.width / 2 - containerRect.left,
          y2: timelineRect.top - containerRect.top,
        })
      }
    }

    setLines(newLines)
  }, [containerRef, activeLinks, selectedNodeIds])

  if (lines.length === 0) return null

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-30"
      style={{ width: '100%', height: '100%' }}
    >
      <defs>
        <marker
          id="arrowhead"
          markerWidth="6"
          markerHeight="4"
          refX="6"
          refY="2"
          orient="auto"
        >
          <polygon points="0 0, 6 2, 0 4" fill="hsl(172, 66%, 50%)" opacity="0.6" />
        </marker>
      </defs>
      {lines.map((line) => (
        <line
          key={line.id}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke="hsl(172, 66%, 50%)"
          strokeWidth="1.5"
          strokeDasharray="6,4"
          opacity="0.5"
          markerEnd="url(#arrowhead)"
        />
      ))}
    </svg>
  )
}
