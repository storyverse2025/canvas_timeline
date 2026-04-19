import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CanvasAssetsTab } from './CanvasAssetsTab'
import { GenerationHistoryTab } from './GenerationHistoryTab'
import { MyAssetsTab } from './MyAssetsTab'

export function AssetLibraryPanel() {
  return (
    <Tabs defaultValue="canvas" className="flex flex-col h-full">
      <TabsList className="grid w-full grid-cols-3 bg-card/60 rounded-none border-b border-border h-8 shrink-0">
        <TabsTrigger value="canvas" className="text-[10px] data-[state=active]:bg-secondary">
          画布资产
        </TabsTrigger>
        <TabsTrigger value="history" className="text-[10px] data-[state=active]:bg-secondary">
          生成历史
        </TabsTrigger>
        <TabsTrigger value="mine" className="text-[10px] data-[state=active]:bg-secondary">
          我的创建
        </TabsTrigger>
      </TabsList>
      <TabsContent value="canvas" className="flex-1 overflow-hidden m-0 p-0">
        <CanvasAssetsTab />
      </TabsContent>
      <TabsContent value="history" className="flex-1 overflow-hidden m-0 p-0">
        <GenerationHistoryTab />
      </TabsContent>
      <TabsContent value="mine" className="flex-1 overflow-hidden m-0 p-0">
        <MyAssetsTab />
      </TabsContent>
    </Tabs>
  )
}
