import { useState, useCallback } from 'react'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { TopBar } from './TopBar'
import { StatusBar } from './StatusBar'
import { CreativeCanvas } from '@/components/canvas/CreativeCanvas'
import { TimelineContainer } from '@/components/timeline/TimelineContainer'
import { RightPanel } from './RightPanel'
import { PreviewWindow } from '@/components/preview/PreviewWindow'
import { ConnectionOverlay } from '@/components/connection/ConnectionOverlay'
import { useUiStore } from '@/stores/ui-store'

export function AppShell() {
  const previewOpen = useUiStore((s) => s.previewOpen)
  const [canvasRef, setCanvasRef] = useState<HTMLDivElement | null>(null)

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <TopBar />
      <div className="flex-1 flex flex-col overflow-hidden relative">
        <ResizablePanelGroup direction="vertical" className="flex-1">
          <ResizablePanel defaultSize={65} minSize={30}>
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel defaultSize={65} minSize={30}>
                <div className="relative h-full" ref={setCanvasRef}>
                  <CreativeCanvas />
                  <ConnectionOverlay containerRef={canvasRef} />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} minSize={20} maxSize={50}>
                <RightPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={35} minSize={15} maxSize={50}>
            <TimelineContainer />
          </ResizablePanel>
        </ResizablePanelGroup>
        {previewOpen && <PreviewWindow />}
      </div>
      <StatusBar />
    </div>
  )
}
