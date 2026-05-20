import { useStoryboardStore } from '@/stores/storyboard-store'
import type { StoryboardRow } from '@/types/storyboard'

const EMPTY_SLOT = { image: '', description: '', nodeId: '' }

function emptyRow(): Omit<StoryboardRow, 'id' | 'createdAt'> {
  return {
    shot_number: '',
    duration: 5,
    status: 'todo',
    visual_description: '',
    reference_image: '',
    shot_size: '',
    character_actions: '',
    emotion_mood: '',
    emotion_atmosphere: '',
    character_motivation: '',
    character_psychology: '',
    performance_guidance: '',
    scene_tags: '',
    lighting_atmosphere: '',
    sound_effects: '',
    dialogue: '',
    storyboard_prompts: '',
    motion_prompts: '',
    bgm: '',
    mixing_brief: '',
    visual_anchor: '',
    character1: { ...EMPTY_SLOT },
    character2: { ...EMPTY_SLOT },
    prop1: { ...EMPTY_SLOT },
    prop2: { ...EMPTY_SLOT },
    scene: { ...EMPTY_SLOT },
  }
}

interface UpsertArgs {
  shotNumber: string
  prompt: string
  imageUrl: string
  nodeId: string
  duration?: number
}

/**
 * Write a keyframe into the storyboard store — the single source of truth for
 * the table view. Every chat-triggered keyframe path funnels through here so
 * canvas nodes, asset entries, and the table all reference the same row.
 *
 * Match priority (first wins):
 *   1. Existing row with the same shot_number.
 *   2. First row that has no keyframe yet (empty keyframeUrl AND no keyframeNodeId).
 *   3. Append a new row, auto-assigning shot_number when none was given.
 *
 * Returns the id of the row that was created or updated.
 */
export function upsertKeyframeRow(args: UpsertArgs): string {
  const { shotNumber, prompt, imageUrl, nodeId, duration } = args
  const store = useStoryboardStore.getState()
  const rows = store.rows

  let target = shotNumber
    ? rows.find((r) => r.shot_number === shotNumber)
    : undefined
  if (!target) target = rows.find((r) => !r.keyframeUrl && !r.keyframeNodeId)

  if (target) {
    store.updateRow(target.id, {
      keyframeUrl: imageUrl || target.keyframeUrl,
      keyframeNodeId: nodeId || target.keyframeNodeId,
      reference_image: imageUrl || target.reference_image,
      visual_description: target.visual_description || prompt,
      storyboard_prompts: target.storyboard_prompts || prompt,
      status: imageUrl ? 'done' : (target.status === 'todo' ? 'in_progress' : target.status),
    })
    return target.id
  }

  return store.addRow({
    ...emptyRow(),
    shot_number: shotNumber || String(rows.length + 1),
    duration: duration ?? 5,
    visual_description: prompt,
    storyboard_prompts: prompt,
    reference_image: imageUrl,
    keyframeUrl: imageUrl,
    keyframeNodeId: nodeId,
    status: imageUrl ? 'done' : 'in_progress',
  })
}
