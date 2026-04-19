import { v4 as uuid } from 'uuid'
import { useTimelineStore } from '@/stores/timeline-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import type { StoryboardRow } from '@/types/storyboard'
import type { Track } from '@/types/timeline'

const SCENE_TRACK_LABEL = '场景'
const VIDEO_TRACK_LABEL = 'Beat Video'

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

/** Get a scene identifier from a row — use scene description or scene_tags as key */
function getSceneKey(r: StoryboardRow): string {
  const sceneDesc = (r.scene as { description?: string } | undefined)?.description ?? ''
  return sceneDesc || r.scene_tags || r.lighting_atmosphere || '默认场景'
}

function getSceneLabel(r: StoryboardRow): string {
  const sceneDesc = (r.scene as { description?: string } | undefined)?.description ?? ''
  const name = sceneDesc.slice(0, 30) || r.scene_tags || '场景'
  return name
}

function getSceneImage(r: StoryboardRow): string {
  return (r.scene as { image?: string } | undefined)?.image ?? ''
}

/**
 * Two-track sync: storyboard rows → scene track + video track.
 * Scene track merges consecutive shots with the same scene into one block.
 * Video track shows individual beat videos.
 */
export function syncStoryboardToTimeline(rows: StoryboardRow[]) {
  const sceneTrackId = ensureTrack(SCENE_TRACK_LABEL, 'keyframe')
  const vidTrackId = ensureTrack(VIDEO_TRACK_LABEL, 'video')

  let cursor = 0
  const sceneItems: Array<Record<string, unknown>> = []
  const vidItems: Array<Record<string, unknown>> = []

  // Build scene blocks by merging consecutive rows with the same scene
  let currentSceneKey = ''
  let currentSceneStart = 0
  let currentSceneLabel = ''
  let currentSceneImage = ''
  let currentSceneRowIds: string[] = []

  const flushScene = () => {
    if (currentSceneRowIds.length === 0) return
    sceneItems.push({
      id: `sc-${currentSceneRowIds[0]}`,
      trackId: sceneTrackId,
      type: 'keyframe',
      startTime: currentSceneStart,
      duration: cursor - currentSceneStart,
      label: currentSceneLabel,
      data: {
        sceneKey: currentSceneKey,
        imageUrl: currentSceneImage,
        rowIds: currentSceneRowIds,
      },
      color: '#10b981', // emerald for scenes
    })
  }

  for (const r of rows) {
    const dur = Math.max(0.1, Number(r.duration) || 1)
    const sceneKey = getSceneKey(r)

    // Check if scene changed
    if (sceneKey !== currentSceneKey) {
      flushScene()
      currentSceneKey = sceneKey
      currentSceneStart = cursor
      currentSceneLabel = getSceneLabel(r)
      currentSceneImage = getSceneImage(r)
      currentSceneRowIds = []
    }
    currentSceneRowIds.push(r.id)

    // Video track — each shot with a beat video
    if (r.beatVideoUrl) {
      vidItems.push({
        id: `sb-vid-${r.id}`,
        trackId: vidTrackId,
        type: 'video',
        startTime: cursor,
        duration: dur,
        label: `${r.shot_number ?? ''}`,
        data: {
          storyboardRowId: r.id,
          videoUrl: r.beatVideoUrl,
          imageUrl: r.keyframeUrl || r.reference_image,
          shotNumber: r.shot_number,
          dialogue: r.dialogue,
        },
        color: '#ec4899',
      })
    }

    cursor += dur
  }
  flushScene() // flush last scene block

  useTimelineStore.setState((s) => {
    const scTrack = s.tracks.find((x: Track) => x.id === sceneTrackId)
    if (scTrack) scTrack.items = sceneItems as Track['items']
    const vidTrack = s.tracks.find((x: Track) => x.id === vidTrackId)
    if (vidTrack) vidTrack.items = vidItems as Track['items']
    const maxEnd = s.tracks.flatMap((x: Track) => x.items).reduce((m, i) => Math.max(m, i.startTime + i.duration), 0)
    if (maxEnd + 5 > s.duration) s.duration = maxEnd + 10
  })

  // Remove old tracks from previous versions
  for (const oldLabel of ['分镜', '分镜 Keyframe', '分镜 Video']) {
    const old = useTimelineStore.getState().tracks.find((t: Track) => t.label === oldLabel)
    if (old) useTimelineStore.getState().removeTrack(old.id)
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
