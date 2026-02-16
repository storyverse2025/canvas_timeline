import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Settings2, MessageSquare } from 'lucide-react'
import { NodeInspector } from '@/components/canvas/panels/NodeInspector'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { useUiStore } from '@/stores/ui-store'

export function RightPanel() {
  const tab = useUiStore((s) => s.rightPanelTab)
  const setTab = useUiStore((s) => s.setRightPanelTab)

  return (
    <div className="h-full flex flex-col bg-card/40 border-l border-border">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as 'inspector' | 'chat')}
        className="flex flex-col h-full"
      >
        <TabsList className="grid w-full grid-cols-2 bg-card/60 rounded-none border-b border-border h-9">
          <TabsTrigger value="inspector" className="text-xs gap-1.5 data-[state=active]:bg-secondary">
            <Settings2 className="w-3.5 h-3.5" />
            Inspector
          </TabsTrigger>
          <TabsTrigger value="chat" className="text-xs gap-1.5 data-[state=active]:bg-secondary">
            <MessageSquare className="w-3.5 h-3.5" />
            AI Agent
          </TabsTrigger>
        </TabsList>
        <TabsContent value="inspector" className="flex-1 overflow-auto m-0 p-0">
          <NodeInspector />
        </TabsContent>
        <TabsContent value="chat" className="flex-1 overflow-hidden m-0 p-0">
          <ChatPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
