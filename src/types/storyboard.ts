import { z } from 'zod'

/**
 * Each "element slot" (character, prop, scene) is an image + text description pair
 * that references a canvas node for cross-tab sync.
 */
export const ElementSlotSchema = z.object({
  image: z.string().default(''),
  description: z.string().default(''),
  nodeId: z.string().default(''),
})

export type ElementSlot = z.infer<typeof ElementSlotSchema>

export const StoryboardRowSchema = z.object({
  shot_number: z.string().min(1),
  duration: z.number().positive().max(600),
  visual_description: z.string().default(''),
  reference_image: z.string().default(''),
  shot_size: z.string().default(''),
  character_actions: z.string().default(''),
  emotion_mood: z.string().default(''),
  scene_tags: z.string().default(''),
  lighting_atmosphere: z.string().default(''),
  sound_effects: z.string().default(''),
  /** Dialogue text */
  dialogue: z.string().default(''),
  /** Dialogue audio URL (TTS or uploaded) */
  dialogue_audio: z.string().default(''),
  storyboard_prompts: z.string().default(''),
  motion_prompts: z.string().default(''),
  /** BGM description/tag */
  bgm: z.string().default(''),
  /** BGM audio URL */
  bgm_audio: z.string().default(''),
  /** Visual anchor: a reference point for visual consistency across shots */
  visual_anchor: z.string().default(''),
  // Element slots
  character1: ElementSlotSchema.default({}),
  character2: ElementSlotSchema.default({}),
  prop1: ElementSlotSchema.default({}),
  prop2: ElementSlotSchema.default({}),
  scene: ElementSlotSchema.default({}),
})

export type StoryboardRowInput = z.infer<typeof StoryboardRowSchema>

export interface StoryboardRow extends StoryboardRowInput {
  id: string;
  createdAt: number;
  referenceNodeId?: string;
  /** Canvas node ID for the keyframe image */
  keyframeNodeId?: string;
  keyframeUrl?: string;
  /** Canvas node ID for the beat video */
  beatVideoNodeId?: string;
  beatVideoUrl?: string;
}

export const StoryboardListSchema = z.array(StoryboardRowSchema).min(1)

export interface StoryboardValidationResult {
  ok: boolean;
  rows?: StoryboardRowInput[];
  errors?: string[];
}

export function validateStoryboard(raw: unknown): StoryboardValidationResult {
  const r = StoryboardListSchema.safeParse(raw)
  if (r.success) return { ok: true, rows: r.data }
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }
}
