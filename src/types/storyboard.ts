import { z } from 'zod'

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
  dialogue: z.string().default(''),
  storyboard_prompts: z.string().default(''),
  motion_prompts: z.string().default(''),
  bgm: z.string().default(''),
})

export type StoryboardRowInput = z.infer<typeof StoryboardRowSchema>

export interface StoryboardRow extends StoryboardRowInput {
  id: string;
  createdAt: number;
  referenceNodeId?: string;
  status: 'todo' | 'in_progress' | 'done';
  aiImageUrl?: string;
  aiVideoUrl?: string;
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
