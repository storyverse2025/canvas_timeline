import { v4 as uuid } from 'uuid'
import { useTimelineStore } from '@/stores/timeline-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import type { StoryboardRow } from '@/types/storyboard'
import type { Track } from '@/types/timeline'

const KF_TRACK_LABEL = '分镜 Keyframe'
const VIDEO_TRACK_LABEL = '分镜 Video'

function ensureTrack(label: string, type: 'keyframe' | 'video'): string {
  const state = useTimelineStore.getState()
  let tracks = state.tracks
  if (tracks.length === 0) {
    state.initDefaultTracks()
    tracks = useTimelineStore.getState().tracks
  }
  let track = tracks.find((t) => t.label === label)
  if (!track) {
    const id = state.addTrack(type, label)
    track = useTimelineStore.getState().tracks.find((t) => t.id === id)
  }
  return track!.id
}

/**
 * Two-track sync: storyboard rows → keyframe track + video track.
 * Keyframe track shows all shots (image or fallback).
 * Video track shows only shots that have a beat video.
 */
export function syncStoryboardToTimeline(rows: StoryboardRow[]) {
  const kfTrackId = ensureTrack(KF_TRACK_LABEL, 'keyframe')
  const vidTrackId = ensureTrack(VIDEO_TRACK_LABEL, 'video')

  let cursor = 0
  const kfItems: Array<Record<string, unknown>> = []
  const vidItems: Array<Record<string, unknown>> = []

  for (const r of rows) {
    const dur = Math.max(0.1, Number(r.duration) || 1)
    const label = `${r.shot_number ?? ''} ${(r.visual_description ?? '').slice(0, 20)}`.trim()
    const imageUrl = r.keyframeUrl || r.reference_image

    // Keyframe track — always present
    kfItems.push({
      id: `sb-kf-${r.id}`,
      trackId: kfTrackId,
      type: 'keyframe',
      startTime: cursor,
      duration: dur,
      label,
      data: {
        storyboardRowId: r.id,
        imageUrl,
        shotNumber: r.shot_number,
        dialogue: r.dialogue,
      },
      color: '#8b5cf6',
    })

    // Video track — only if beat video exists
    if (r.beatVideoUrl) {
      vidItems.push({
        id: `sb-vid-${r.id}`,
        trackId: vidTrackId,
        type: 'video',
        startTime: cursor,
        duration: dur,
        label: `${r.shot_number} video`,
        data: {
          storyboardRowId: r.id,
          videoUrl: r.beatVideoUrl,
          imageUrl,
          shotNumber: r.shot_number,
        },
        color: '#ec4899',
      })
    }

    cursor += dur
  }

  useTimelineStore.setState((s) => {
    const kfTrack = s.tracks.find((x: Track) => x.id === kfTrackId)
    if (kfTrack) kfTrack.items = kfItems as Track['items']
    const vidTrack = s.tracks.find((x: Track) => x.id === vidTrackId)
    if (vidTrack) vidTrack.items = vidItems as Track['items']
    const maxEnd = s.tracks.flatMap((x: Track) => x.items).reduce((m, i) => Math.max(m, i.startTime + i.duration), 0)
    if (maxEnd + 5 > s.duration) s.duration = maxEnd + 10
  })

  // Also remove old single "分镜" track if it exists (migration)
  const oldTrack = useTimelineStore.getState().tracks.find((t: Track) => t.label === '分镜')
  if (oldTrack) {
    useTimelineStore.getState().removeTrack(oldTrack.id)
  }
}

/** Subscribe once: whenever storyboard rows change, rebuild the timeline tracks. */
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
