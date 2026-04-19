import { useCallback, useState } from 'react'
import { Save, FolderOpen, Wand2, Eye, EyeOff, LayoutGrid, Table2, Film, Trash, Clapperboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'
import { useViewStore } from '@/stores/view-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useAssetStore } from '@/stores/asset-store'
import { useChatStore } from '@/stores/chat-store'
import { ScriptInputDialog } from '@/components/director/ScriptInputDialog'

const TABS = [
  { id: 'canvas', label: '画布', Icon: LayoutGrid },
  { id: 'table',  label: '表格', Icon: Table2 },
  { id: 'timeline', label: '时间轴', Icon: Film },
] as const

export function TopBar() {
  const [directorOpen, setDirectorOpen] = useState(false)
  const previewOpen = useUiStore((s) => s.previewOpen)
  const togglePreview = useUiStore((s) => s.togglePreview)
  const activeTab = useViewStore((s) => s.activeTab)
  const setActiveTab = useViewStore((s) => s.setActiveTab)

  const handleSave = useCallback(() => {
    const state = {
      version: 2,
      assets: useAssetStore.getState().assets,
      canvas: {
        nodes: useCanvasStore.getState().nodes,
        edges: useCanvasStore.getState().edges,
      },
      timeline: {
        tracks: useTimelineStore.getState().tracks,
        duration: useTimelineStore.getState().duration,
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
    useChatStore.getState().addMessage('system', '项目已保存')
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

        if (state.version === 2) {
          // New format
          if (state.assets) useAssetStore.getState().setAssets(state.assets)
          if (state.canvas?.nodes) {
            useCanvasStore.getState().setNodes(state.canvas.nodes)
            useCanvasStore.getState().setEdges(state.canvas.edges || [])
          }
          if (state.timeline?.tracks) {
            useTimelineStore.getState().setTracks(state.timeline.tracks)
          }
        } else {
          // Legacy v1 format — just restore canvas nodes/edges
          if (state.canvas?.nodes) {
            useCanvasStore.getState().setNodes(state.canvas.nodes)
            useCanvasStore.getState().setEdges(state.canvas.edges || [])
          }
        }

        if (state.mapping?.links) {
          useMappingStore.getState().setLinks(state.mapping.links)
        }

        useChatStore.getState().addMessage('system',
          `项目已加载：${file.name}（保存于 ${state.savedAt || '未知时间'}）`)
      } catch (err) {
        useChatStore.getState().addMessage('system',
          `加载失败：${err instanceof Error ? err.message : '未知错误'}`)
      }
    }
    input.click()
  }, [])

  const handleClear = useCallback(() => {
    if (!window.confirm('清空所有内容？画布节点、资产、时间轴、分镜表都会被清空，此操作不可撤销。')) return
    useCanvasStore.getState().clearAll()
    useAssetStore.getState().setAssets([])
    useTimelineStore.getState().setTracks([])
    // Dynamically import stores that may not be in the original imports
    import('@/stores/canvas-item-store').then((m) => m.useCanvasItemStore.setState({ items: {} }))
    import('@/stores/storyboard-store').then((m) => m.useStoryboardStore.getState().clear())
    import('@/stores/libtv-tasks-store').then((m) =>
      m.useLibtvTasksStore.setState({ tasks: {} })
    )
    useChatStore.getState().addMessage('system', '已清空所有内容')
  }, [])

  return (
    <>
    <header className="h-12 border-b border-border bg-card/80 backdrop-blur flex items-center px-4 gap-3 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-6 h-6 rounded bg-primary/20 flex items-center justify-center">
          <Wand2 className="w-3.5 h-3.5 text-primary" />
        </div>
        <span className="font-semibold text-sm whitespace-nowrap">StoryVerse Canvas</span>
      </div>

      <div className="h-5 w-px bg-border mx-1 shrink-0" />

      {/* Center: Tab switcher */}
      <div className="flex items-center gap-0.5 bg-secondary/50 rounded-lg p-0.5">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-colors',
              activeTab === id
                ? 'bg-background text-foreground shadow-sm font-medium'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <Button variant="ghost" size="sm" onClick={() => setDirectorOpen(true)} className="gap-1.5 text-primary">
        <Clapperboard className="w-4 h-4" />
        导演助手
      </Button>

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

      <Button variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={handleClear}>
        <Trash className="w-4 h-4" />
        Clear
      </Button>

    </header>
    {directorOpen && <ScriptInputDialog onClose={() => setDirectorOpen(false)} />}
    </>
  )
}
