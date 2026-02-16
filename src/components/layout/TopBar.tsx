import { useCallback } from 'react'
import { Save, FolderOpen, Wand2, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/ui-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useChatStore } from '@/stores/chat-store'
import { PipelineStepper } from './PipelineStepper'

export function TopBar() {
  const previewOpen = useUiStore((s) => s.previewOpen)
  const togglePreview = useUiStore((s) => s.togglePreview)

  const handleSave = useCallback(() => {
    const state = {
      canvas: {
        nodes: useCanvasStore.getState().nodes,
        edges: useCanvasStore.getState().edges,
      },
      timeline: {
        shots: useTimelineStore.getState().shots,
      },
      mapping: {
        links: useMappingStore.getState().links,
      },
      savedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `storyverse-project-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    useChatStore.getState().addMessage('system', 'Project saved to file')
  }, [])

  const handleLoad = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const state = JSON.parse(text)

        if (state.canvas?.nodes) {
          useCanvasStore.getState().setNodes(state.canvas.nodes)
          useCanvasStore.getState().setEdges(state.canvas.edges || [])
        }
        if (state.timeline?.shots) {
          useTimelineStore.getState().setShots(state.timeline.shots)
        }
        if (state.mapping?.links) {
          useMappingStore.getState().setLinks(state.mapping.links)
        }

        useChatStore.getState().addMessage('system',
          `Project loaded from ${file.name} (saved ${state.savedAt || 'unknown'})`)
      } catch (err) {
        useChatStore.getState().addMessage('system',
          `Failed to load project: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    }
    input.click()
  }, [])

  return (
    <header className="h-12 border-b border-border bg-card/80 backdrop-blur flex items-center px-4 gap-3 shrink-0">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center">
          <Wand2 className="w-3.5 h-3.5 text-primary" />
        </div>
        <span className="font-semibold text-sm whitespace-nowrap">StoryVerse Canvas</span>
      </div>

      <div className="h-5 w-px bg-border mx-1" />

      <PipelineStepper />

      <div className="flex-1" />

      <Button variant="ghost" size="sm" onClick={togglePreview} className="gap-1.5">
        {previewOpen ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        Preview
      </Button>

      <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleSave}>
        <Save className="w-4 h-4" />
        Save
      </Button>

      <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleLoad}>
        <FolderOpen className="w-4 h-4" />
        Load
      </Button>
    </header>
  )
}
