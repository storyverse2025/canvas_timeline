import { z } from 'zod'

/**
 * Subset of storyboard row fields sound-agent reads. Mirrors the actor-
 * agent ActorRow shape — sound-agent doesn't own the storyboard row
 * schema, just consumes a few fields for context. All optional so
 * hand-constructed test rows work.
 */
export interface SoundRow {
  shot_number?: string
  duration?: number
  visual_description?: string
  character_actions?: string
  emotion_mood?: string
  emotion_atmosphere?: string
  scene_tags?: string
  lighting_atmosphere?: string
  shot_size?: string
  dialogue?: string
  /** Existing sound fields (may already have hand-edited values). */
  bgm?: string
  sound_effects?: string
  mixing_brief?: string
}

/** Output: 3 sound deliverables per row, all required, all non-empty. */
export const SoundBriefSchema = z.object({
  bgm: z.string().min(1),
  sound_effects: z.string().min(1),
  mixing_brief: z.string().min(1),
})
export type SoundBrief = z.infer<typeof SoundBriefSchema>

export interface DesignRowRequest {
  row: SoundRow
  creativeBrief?: {
    projectType?: string
    tone?: string
    genre?: string
    platformAudience?: string
  }
  visualStyle?: string
  /**
   * When false (default), fields already present on the row are kept as-is
   * and only the missing/empty ones are filled. When true, the LLM rewrites
   * all 3 fields from scratch regardless of existing values. Use `true` for
   * the right-click "重做音频" path; default for batch generation.
   */
  overwrite?: boolean
}

export interface DesignTableRequest {
  rows: Array<SoundRow & { id: string }>
  creativeBrief?: {
    projectType?: string
    tone?: string
    genre?: string
    platformAudience?: string
  }
  visualStyle?: string
  overwrite?: boolean
}

export type DesignTableResult = Record<string, SoundBrief>
