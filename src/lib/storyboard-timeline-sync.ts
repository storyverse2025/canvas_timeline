import { v4 as uuid } from 'uuid'
import { useTimelineStore } from '@/stores/timeline-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import type { StoryboardRow } from '@/types/storyboard'
import type { Track } from '@/types/timeline'

const STORYBOARD_TRACK_LABEL = '分镜'

/**
 * One-way hard link: storyboard rows → timeline "分镜" track.
 * Replaces the entire track every time so it stays in sync.
 */
export function syncStoryboardToTimeline(rows: StoryboardRow[]) {
  const state = useTimelineStore.getState()
  let tracks = state.tracks
  if (tracks.length === 0) {
    state.initDefaultTracks()
    tracks = useTimelineStore.getState().tracks
  }

  let track = tracks.find((t) => t.label === STORYBOARD_TRACK_LABEL)
  if (!track) {
    const id = state.addTrack('keyframe', STORYBOARD_TRACK_LABEL)
    track = useTimelineStore.getState().tracks.find((t) => t.id === id)
    if (!track) return
  }
  const trackId = track.id

  let cursor = 0
  const items = rows.map((r) => {
    const dur = Math.max(0.1, Number(r.duration) || 1)
    const item = {
      id: `sb-${r.id}`,
      trackId,
      type: track!.type,
      startTime: cursor,
      duration: dur,
      label: `${r.shot_number ?? ''} ${(r.visual_description ?? '').slice(0, 20)}`.trim(),
      data: {
        storyboardRowId: r.id,
        referenceNodeId: r.referenceNodeId,
        imageUrl: r.keyframeUrl || r.reference_image,
        videoUrl: r.beatVideoUrl,
        shotNumber: r.shot_number,
        dialogue: r.dialogue,
      },
      color: '#8b5cf6',
    }
    cursor += dur
    return item
  })

  useTimelineStore.setState((s) => {
    const t = s.tracks.find((x: Track) => x.id === trackId)
    if (t) t.items = items
    const maxEnd = s.tracks.flatMap((x: Track) => x.items).reduce((m, i) => Math.max(m, i.startTime + i.duration), 0)
    if (maxEnd + 5 > s.duration) s.duration = maxEnd + 10
  })
}

/** Subscribe once: whenever storyboard rows change, rebuild the timeline track. */
let _subscribed = false
export function initStoryboardTimelineLink() {
  if (_subscribed) return
  _subscribed = true
  let prev = useStoryboardStore.getState().rows
  useStoryboardStore.subscribe((state) => {
    if (state.rows !== prev) {
      prev = state.rows
      syncStoryboardToTimeline(state.rows)
    }
  })
  if (prev.length > 0) syncStoryboardToTimeline(prev)
}

export const _ = uuid
