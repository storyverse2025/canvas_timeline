import { useEffect } from 'react'
import { useTimelineStore } from '@/stores/timeline-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useUiStore } from '@/stores/ui-store'

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      const timelineStore = useTimelineStore.getState()
      const canvasStore = useCanvasStore.getState()
      const uiStore = useUiStore.getState()

      // Space: Play/Pause
      if (e.code === 'Space') {
        e.preventDefault()
        timelineStore.setIsPlaying(!timelineStore.isPlaying)
      }

      // Delete/Backspace: Remove selected nodes
      if (e.code === 'Delete' || e.code === 'Backspace') {
        const selected = canvasStore.selectedNodeIds
        if (selected.length > 0) {
          e.preventDefault()
          selected.forEach((id) => canvasStore.removeNode(id))
        }
      }

      // Ctrl/Cmd + S: Snap toggle
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault()
        timelineStore.toggleSnap()
      }

      // Ctrl/Cmd + P: Toggle preview
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyP') {
        e.preventDefault()
        uiStore.togglePreview()
      }

      // Home: Go to start
      if (e.code === 'Home') {
        e.preventDefault()
        timelineStore.setPlayheadTime(0)
      }

      // End: Go to end
      if (e.code === 'End') {
        e.preventDefault()
        timelineStore.setPlayheadTime(timelineStore.duration)
      }

      // Arrow Left/Right: Move playhead
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        const step = e.shiftKey ? 5 : 1
        timelineStore.setPlayheadTime(Math.max(0, timelineStore.playheadTime - step))
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault()
        const step = e.shiftKey ? 5 : 1
        timelineStore.setPlayheadTime(Math.min(timelineStore.duration, timelineStore.playheadTime + step))
      }

      // +/- : Zoom
      if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault()
        timelineStore.setZoom(timelineStore.zoom * 1.25)
      }
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault()
        timelineStore.setZoom(timelineStore.zoom * 0.8)
      }

      // 1: Switch to Inspector tab
      if (e.code === 'Digit1' && e.altKey) {
        e.preventDefault()
        uiStore.setRightPanelTab('inspector')
      }

      // 2: Switch to Chat tab
      if (e.code === 'Digit2' && e.altKey) {
        e.preventDefault()
        uiStore.setRightPanelTab('chat')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
