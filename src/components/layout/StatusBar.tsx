import { useTimelineStore } from '@/stores/timeline-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useAssetStore } from '@/stores/asset-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useViewStore } from '@/stores/view-store'
import { formatTime } from '@/lib/time-utils'

export function StatusBar() {
  const playheadTime = useTimelineStore((s) => s.playheadTime)
  const duration = useTimelineStore((s) => s.duration)
  const trackCount = useTimelineStore((s) => s.tracks.length)
  const edgeCount = useCanvasStore((s) => s.edges.length)
  const assetCount = useAssetStore((s) => s.assets.length)
  const linkCount = useMappingStore((s) => s.links.length)
  const activeTab = useViewStore((s) => s.activeTab)
  const selectedAssetIds = useViewStore((s) => s.selectedAssetIds)

  return (
    <footer className="h-7 border-t border-border bg-card/60 flex items-center px-4 text-xs text-muted-foreground gap-4 shrink-0">
      {activeTab === 'canvas' && (
        <>
          <span>资产: {assetCount}</span>
          <span>连线: {edgeCount}</span>
          {selectedAssetIds.length > 0 && <span>已选: {selectedAssetIds.length}</span>}
        </>
      )}
      {activeTab === 'table' && (
        <>
          <span>资产: {assetCount}</span>
          {selectedAssetIds.length > 0 && <span>已选: {selectedAssetIds.length}</span>}
          <span>链接: {linkCount}</span>
        </>
      )}
      {activeTab === 'timeline' && (
        <>
          <span>时间: {formatTime(playheadTime)} / {formatTime(duration)}</span>
          <span>轨道: {trackCount}</span>
          <span>链接: {linkCount}</span>
        </>
      )}
      <div className="flex-1" />
      <span className="text-muted-foreground/60">StoryVerse Canvas v2.0</span>
    </footer>
  )
}
