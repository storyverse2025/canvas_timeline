import type { Episode, Beat, Character, Keyframe, VideoShot, Scene, Prop } from '@/types/backend'
import type { VisualAssetNodeData, AudioBlockNodeData, Tag } from '@/types/canvas'

// ─── Pipeline Beat type (used by pipeline-generator context) ───

export interface PipelineBeat {
  number: number
  title: string
  narration: string
  dialogues: { speaker: string; text: string }[]
}

// ─── Mappers: Backend types → Canvas/Pipeline types ───

export function episodeToBeats(episode: Episode): PipelineBeat[] {
  return episode.beats.map((b: Beat) => ({
    number: b.number,
    title: `Beat ${b.number}`,
    narration: b.narration || b.action || '',
    dialogues: (b.dialogues || []).map((d) => ({ speaker: d.speaker, text: d.text })),
  }))
}

function makeTag(category: Tag['category'], label: string): Tag {
  return { id: `t-${Date.now()}-${Math.random()}`, category, label }
}

export function characterToNodeData(char: Character): VisualAssetNodeData {
  return {
    assetType: 'character',
    imageUrl: resolveStaticUrl(char.img_url),
    label: char.asset_identifier || char.asset_id,
    prompt: char.prompt,
    tags: [makeTag('character', char.asset_identifier || char.asset_id)],
  }
}

export function keyframeToNodeData(kf: Keyframe): VisualAssetNodeData {
  return {
    assetType: 'keyframe',
    imageUrl: resolveStaticUrl(kf.image_url),
    label: `KF ${kf.beat_number}`,
    prompt: kf.prompt,
    tags: [makeTag('beat', `Beat ${kf.beat_number}`)],
  }
}

export function videoShotToNodeData(shot: VideoShot): VisualAssetNodeData {
  return {
    assetType: 'video',
    imageUrl: resolveStaticUrl(shot.reference_keyframe_url),
    videoUrl: resolveStaticUrl(shot.shot_url),
    label: `Video ${shot.beat_number}`,
    prompt: shot.generation_prompt,
    status: shot.shot_url ? 'completed' : 'pending',
    tags: [makeTag('beat', `Beat ${shot.beat_number}`)],
  }
}

export function sceneToNodeData(scene: Scene): VisualAssetNodeData {
  return {
    assetType: 'scene',
    imageUrl: resolveStaticUrl(scene.image_url),
    label: scene.name,
    prompt: scene.prompt,
    tags: [makeTag('scene', scene.name)],
  }
}

export function propToNodeData(prop: Prop): VisualAssetNodeData {
  return {
    assetType: 'prop',
    imageUrl: resolveStaticUrl(prop.image_url),
    label: prop.name,
    prompt: prop.prompt,
    tags: [makeTag('prop', prop.name)],
  }
}

export function editResultToAudioNode(label: string, url?: string, duration = 120): AudioBlockNodeData {
  return {
    audioType: 'bgm',
    audioUrl: resolveStaticUrl(url),
    duration,
    label,
    tags: [makeTag('custom', 'BGM')],
  }
}

/**
 * Resolve backend static file paths to full URLs.
 * Backend may return paths like `/static/...` which need the backend origin prepended.
 */
export function resolveStaticUrl(path?: string | null): string | undefined {
  if (!path) return undefined
  // Already an absolute URL
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  // Relative to backend — proxy through /api
  if (path.startsWith('/static/')) return `/api${path}`
  return path
}
