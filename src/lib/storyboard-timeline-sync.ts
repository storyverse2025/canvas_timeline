import { v4 as uuid } from 'uuid'
import { useTimelineStore } from '@/stores/timeline-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import type { StoryboardRow } from '@/types/storyboard'
import type { Track } from '@/types/timeline'

const SCENE_TRACK_LABEL = '场景'
const KF_TRACK_LABEL = 'Keyframe'
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

function getSceneKey(r: StoryboardRow): string {
  const sceneDesc = (r.scene as { description?: string } | undefined)?.description ?? ''
  return sceneDesc || r.scene_tags || r.lighting_atmosphere || '默认场景'
}

function getSceneLabel(r: StoryboardRow): string {
  const sceneDesc = (r.scene as { description?: string } | undefined)?.description ?? ''
  return (sceneDesc.slice(0, 30) || r.scene_tags || '场景')
}

function getSceneImage(r: StoryboardRow): string {
  return (r.scene as { image?: string } | undefined)?.image ?? ''
}

/**
 * Three-track sync: storyboard rows → scene + keyframe + video tracks.
 * - Scene track: merges consecutive shots with the same scene
 * - Keyframe track: each shot's reference/KF image
 * - Video track: each shot's beat video (if exists)
 */
export function syncStoryboardToTimeline(rows: StoryboardRow[]) {
  const sceneTrackId = ensureTrack(SCENE_TRACK_LABEL, 'keyframe')
  const kfTrackId = ensureTrack(KF_TRACK_LABEL, 'keyframe')
  const vidTrackId = ensureTrack(VIDEO_TRACK_LABEL, 'video')

  let cursor = 0
  const sceneItems: Array<Record<string, unknown>> = []
  const kfItems: Array<Record<string, unknown>> = []
  const vidItems: Array<Record<string, unknown>> = []

  // Scene merging state
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
      data: { sceneKey: currentSceneKey, imageUrl: currentSceneImage, rowIds: currentSceneRowIds },
      color: '#10b981',
    })
  }

  for (const r of rows) {
    const dur = Math.max(0.1, Number(r.duration) || 1)
    const sceneKey = getSceneKey(r)
    const imageUrl = r.keyframeUrl || r.reference_image

    // Scene track — merge consecutive same-scene shots
    if (sceneKey !== currentSceneKey) {
      flushScene()
      currentSceneKey = sceneKey
      currentSceneStart = cursor
      currentSceneLabel = getSceneLabel(r)
      currentSceneImage = getSceneImage(r)
      currentSceneRowIds = []
    }
    currentSceneRowIds.push(r.id)

    // Keyframe track — every shot
    kfItems.push({
      id: `sb-kf-${r.id}`,
      trackId: kfTrackId,
      type: 'keyframe',
      startTime: cursor,
      duration: dur,
      label: `${r.shot_number ?? ''}`,
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
        label: `${r.shot_number ?? ''}`,
        data: {
          storyboardRowId: r.id,
          videoUrl: r.beatVideoUrl,
          imageUrl,
          shotNumber: r.shot_number,
          dialogue: r.dialogue,
        },
        color: '#ec4899',
      })
    }

    cursor += dur
  }
  flushScene()

  useTimelineStore.setState((s) => {
    const scTrack = s.tracks.find((x: Track) => x.id === sceneTrackId)
    if (scTrack) scTrack.items = sceneItems as Track['items']
    const kfTrack = s.tracks.find((x: Track) => x.id === kfTrackId)
    if (kfTrack) kfTrack.items = kfItems as Track['items']
    const vidTrack = s.tracks.find((x: Track) => x.id === vidTrackId)
    if (vidTrack) vidTrack.items = vidItems as Track['items']
    const maxEnd = s.tracks.flatMap((x: Track) => x.items).reduce((m, i) => Math.max(m, i.startTime + i.duration), 0)
    if (maxEnd + 5 > s.duration) s.duration = maxEnd + 10
  })

  // Remove old/legacy tracks
  const legacyLabels = ['分镜', '分镜 Keyframe', '分镜 Video', '关键帧']
  for (const label of legacyLabels) {
    const old = useTimelineStore.getState().tracks.find((t: Track) => t.label === label)
    if (old) useTimelineStore.getState().removeTrack(old.id)
  }
}

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
