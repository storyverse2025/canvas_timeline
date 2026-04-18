import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { TopBar } from './TopBar'
import { StatusBar } from './StatusBar'
import { MainPanel } from './MainPanel'
import { RightPanel } from './RightPanel'
import { PreviewWindow } from '@/components/preview/PreviewWindow'
import { useUiStore } from '@/stores/ui-store'

export function AppShell() {
  const previewOpen = useUiStore((s) => s.previewOpen)

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
