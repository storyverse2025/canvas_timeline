import { useRef } from 'react'
import { useViewStore } from '@/stores/view-store'
import { AssetCanvas } from '@/components/canvas/AssetCanvas'
import { StoryboardTable } from '@/components/table/StoryboardTable'
import { MultiTrackTimeline } from '@/components/timeline/MultiTrackTimeline'
import { ShotEditorOverlay } from '@/components/shot-editor/ShotEditorOverlay'

/**
 * Tab mounting strategy:
 *
 * AssetCanvas stays permanently mounted — ReactFlow's `fitView`/viewport
 * state lives in its own provider and resets on unmount, which would
 * yank the user's pan/zoom every time they tab back. It also already
 * filters off-screen nodes via `onlyRenderVisibleElements` so its idle
 * memory cost is bounded.
 *
 * StoryboardTable + MultiTrackTimeline are mounted ONLY after they've
 * been visited at least once, and only RENDER when active. Without this,
 * the table eagerly created N `<video preload="auto">` elements per row
 * (one per beat-video) at app startup — for a 30-row storyboard that
 * meant ~30 mp4s being streamed + decoded into GPU memory while the
 * user was still on the canvas tab, regularly crashing Chrome with OOM.
 *
 * Once visited, the panel stays mounted so its scroll position + local
 * UI state survive subsequent tab switches. The hidden-via-CSS toggle
 * (instead of unmount) preserves <video>/<audio> playback position too.
 */
export function MainPanel() {
  const activeTab = useViewStore((s) => s.activeTab)
  const visited = useRef<Set<string>>(new Set(['canvas']))
  visited.current.add(activeTab)

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      <div className={activeTab === 'canvas' ? 'flex-1 overflow-hidden' : 'hidden'}>
        <AssetCanvas />
      </div>
      {visited.current.has('table') && (
        <div className={activeTab === 'table' ? 'flex-1 overflow-hidden' : 'hidden'}>
          <StoryboardTable />
        </div>
      )}
      {visited.current.has('timeline') && (
        <div className={activeTab === 'timeline' ? 'flex-1 overflow-hidden' : 'hidden'}>
          <MultiTrackTimeline />
        </div>
      )}
      <ShotEditorOverlay />
    </div>
  )
}
