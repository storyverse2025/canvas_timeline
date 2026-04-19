import { cn } from '@/lib/utils'
import { useViewStore } from '@/stores/view-store'
import { AssetCanvas } from '@/components/canvas/AssetCanvas'
import { StoryboardTable } from '@/components/table/StoryboardTable'
import { MultiTrackTimeline } from '@/components/timeline/MultiTrackTimeline'
import { ShotEditorOverlay } from '@/components/shot-editor/ShotEditorOverlay'

export function MainPanel() {
  const activeTab = useViewStore((s) => s.activeTab)

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* All 3 views always mounted; CSS visibility toggled to preserve internal state */}
      <div className={cn('flex-1 overflow-hidden', activeTab !== 'canvas' && 'hidden')}>
        <AssetCanvas />
      </div>
      <div className={cn('flex-1 overflow-hidden', activeTab !== 'table' && 'hidden')}>
        <StoryboardTable />
      </div>
      <div className={cn('flex-1 overflow-hidden', activeTab !== 'timeline' && 'hidden')}>
        <MultiTrackTimeline />
      </div>
      {/* Shot editor overlay — shown above the active tab */}
      <ShotEditorOverlay />
    </div>
  )
}
