import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { TopBar } from './TopBar'
import { StatusBar } from './StatusBar'
import { MainPanel } from './MainPanel'
import { RightPanel } from './RightPanel'
import { PreviewWindow } from '@/components/preview/PreviewWindow'
import { useUiStore } from '@/stores/ui-store'
import { useEffect } from 'react'
import { fetchAvatarCatalog } from '@/lib/virtual-avatar-library/client'

export function AppShell() {
  const previewOpen = useUiStore((s) => s.previewOpen)

  // Prime the virtual-avatar catalog once so the keyframe / shoot resolver sees
  // it at generation time even if the casting dialog was never opened. Best
  // effort — an empty / missing catalog just leaves real-person mode inactive.
  useEffect(() => {
    void fetchAvatarCatalog().catch(() => {})
  }, [])

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <TopBar />
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={70} minSize={40}>
            <MainPanel />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <RightPanel />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar />
      {previewOpen && <PreviewWindow />}
    </div>
  )
}
