import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useAssetStore } from '@/stores/asset-store'
import { useChatStore } from '@/stores/chat-store'
import { useProjectDB } from '@/stores/project-db'
import { syncStoryboardToTimeline } from '@/lib/storyboard-timeline-sync'
import { mapBundleToCanvas, type MappedImport } from './mapper'
import type { SvBundle } from './types'

/**
 * Wipe the workspace and load a mapped StoryVerse project into it.
 *
 * Order matters:
 *   1. Clear every persisted store — the same sweep TopBar's 清空 does,
 *      INCLUDING useProjectDB.clearAll(). Skipping projectDB is what used to
 *      leave a stale storyboard sitting behind a freshly-imported canvas.
 *   2. newProject() so the import lands in its own server-side session slot
 *      instead of overwriting the snapshot the user was on.
 *   3. Write canvas items, canvas graph and storyboard rows.
 *   4. Rebuild the timeline. `initStoryboardTimelineLink`'s subscription does
 *      this on its own, but calling it directly makes the import atomic and
 *      lets the caller report track counts truthfully.
 */
export async function applyStoryverseImport(bundle: SvBundle): Promise<MappedImport> {
  const mapped = mapBundleToCanvas(bundle)

  const [libtvStore] = await Promise.all([import('@/stores/libtv-tasks-store')])

  useCanvasStore.getState().clearAll()
  useAssetStore.getState().setAssets([])
  useTimelineStore.getState().setTracks([])
  // `duration` is the timeline's persisted ruler length and setTracks([])
  // doesn't touch it, so a previous 3:30 session left the imported 1:31
  // storyboard sitting in two minutes of empty track. Zeroing it lets
  // syncStoryboardToTimeline size the ruler to what was actually imported.
  useTimelineStore.setState({ duration: 0, playheadTime: 0, isPlaying: false })
  useMappingStore.getState().clearLinks()
  useProjectDB.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
  useStoryboardStore.getState().clear()
  libtvStore.useLibtvTasksStore.setState({ tasks: {} })
  // The confirm dialog promises the chat history goes too. clearHistory()
  // resets messages to a single welcome line, so it MUST run before the
  // import summary is appended at the end of this function.
  useChatStore.getState().clearHistory()

  // Fresh session slot, labelled with the imported project's title so the
  // cross-machine session picker shows something meaningful.
  useProjectDB.getState().newProject()
  useProjectDB.getState().updateScript({
    sessionTitle: bundle.project.title,
    text: bundle.episodes.map((e) => e.script).filter(Boolean).join('\n\n'),
  })

  const itemsById: Record<string, (typeof mapped.items)[number]> = {}
  for (const item of mapped.items) itemsById[item.id] = item
  useCanvasItemStore.setState({ items: itemsById })
  useCanvasStore.setState({ nodes: mapped.nodes, edges: mapped.edges, selectedNodeIds: [] })
  useStoryboardStore.setState({ rows: mapped.rows })

  syncStoryboardToTimeline(mapped.rows)

  const s = mapped.summary
  useChatStore.getState().addMessage(
    'system',
    `已从 StoryVerse 导入「${bundle.project.title}」：${s.rows} 个分镜、${s.assets} 个素材、` +
      `${s.keyframes} 张故事板、${s.videos} 条镜头视频、${s.scripts} 份剧本。`,
  )

  return mapped
}
