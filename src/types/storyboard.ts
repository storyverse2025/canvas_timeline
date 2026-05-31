import { z } from 'zod'

/**
 * Each "element slot" (character, prop, scene) is an image + text description pair
 * that references a canvas node for cross-tab sync.
 */
export const EMPTY_ELEMENT_SLOT = { image: '', description: '', nodeId: '' }

export const ElementSlotSchema = z.object({
  image: z.string().default(''),
  description: z.string().default(''),
  nodeId: z.string().default(''),
})

const NullableElementSlotSchema = z.preprocess(
  (value) => (value === null ? { ...EMPTY_ELEMENT_SLOT } : value),
  ElementSlotSchema,
).default({ ...EMPTY_ELEMENT_SLOT })

export type ElementSlot = z.infer<typeof ElementSlotSchema>

export const StoryboardRowSchema = z.object({
  shot_number: z.string().min(1),
  duration: z.number().positive().max(600),
  status: z.enum(['todo', 'in_progress', 'done', 'pending', 'generating', 'completed', 'failed']).default('todo'),
  visual_description: z.string().default(''),
  reference_image: z.string().default(''),
  shot_size: z.string().default(''),
  character_actions: z.string().default(''),
  emotion_mood: z.string().default(''),
  /** Per-shot emotional + atmospheric intent used to steer camera/lens/motion. */
  emotion_atmosphere: z.string().default(''),
  /** Why the visible character acts this way in this shot. */
  character_motivation: z.string().default(''),
  /** Inner conflict / psychological pressure translated from the script beat. */
  character_psychology: z.string().default(''),
  /** Actor-facing performance note: playable behavior, not abstract prose. */
  performance_guidance: z.string().default(''),
  scene_tags: z.string().default(''),
  lighting_atmosphere: z.string().default(''),
  sound_effects: z.string().default(''),
  /** sound-agent 3-track mixing brief: dialogue / SFX / BGM levels + timing
   *  + ducking + row-boundary fades. Free-form text the mixer reads. */
  mixing_brief: z.string().default(''),
  /** Dialogue text */
  dialogue: z.string().default(''),
  storyboard_prompts: z.string().default(''),
  motion_prompts: z.string().default(''),
  /** BGM description/tag */
  bgm: z.string().default(''),
  /** Visual anchor: a reference point for visual consistency across shots */
  visual_anchor: z.string().default(''),
  // Element slots
  character1: NullableElementSlotSchema,
  character2: NullableElementSlotSchema,
  prop1: NullableElementSlotSchema,
  prop2: NullableElementSlotSchema,
  scene: NullableElementSlotSchema,
})

export type StoryboardRowInput = z.infer<typeof StoryboardRowSchema>

export interface StoryboardRow extends StoryboardRowInput {
  id: string;
  createdAt: number;
  referenceNodeId?: string;
  /** Canvas node ID for the keyframe image */
  keyframeNodeId?: string;
  keyframeUrl?: string;
  /**
   * Optional second keyframe rendered as a single clean cinematic frame
   * (no panels / no time labels / no grid). When present, cinematographer
   * uses this as the Seedance omni-reference instead of keyframeUrl so the
   * grid sheet's borders + labels don't leak into the generated video. The
   * grid `keyframeUrl` is kept for the storyboard UI's pacing reference.
   */
  keyframeCleanUrl?: string;
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
