import type { VideoConsistencyIssue } from '@/lib/agents/director-agent'

/**
 * Subset of fields the cinematographer reads from a storyboard row to build
 * the Seedance motion prompt. Keep aligned with src/types/storyboard.ts
 * StoryboardRow — the cinematographer doesn't own that shape (the table
 * does), it just consumes a few text fields.
 */
export interface BeatVideoRow {
  shot_number?: string
  duration?: number
  motion_prompts?: string
  storyboard_prompts?: string
  visual_description?: string
  character_actions?: string
  emotion_mood?: string
  emotion_atmosphere?: string
  character_motivation?: string
  character_psychology?: string
  performance_guidance?: string
  lighting_atmosphere?: string
  shot_size?: string
}

/**
 * Context-only role descriptor for character / scene / prop. NOT passed to
 * Seedance as an image — the keyframe (omni-reference / 全能参考) is the
 * single image input. Used only to bake names + descriptions into the motion
 * text so the model knows what to read out of the keyframe.
 */
export interface BeatVideoContextRef {
  /** Human-readable role tag (e.g., "角色1", "场景"). */
  role: string
  description?: string
}

/**
 * Legacy union: BeatVideoRef accepts both context-only refs AND the
 * single-image keyframe ref so the consumer's storyboard mapping logic
 * doesn't have to know which is which. The shoot verb peels the keyframe
 * URL out separately.
 */
export interface BeatVideoRef extends BeatVideoContextRef {
  imageUrl?: string
}

export interface ShootRequest {
  /** The storyboard row this clip realizes. */
  row: BeatVideoRow
  /** Optional global art-style hint (e.g., "Cold-toned filmic noir"). */
  visualStyle?: string
  /**
   * The single image sent to Seedance as the omni-reference (全能参考).
   * Required — without a keyframe there's nothing to anchor casting,
   * scene, blocking, and color to.
   */
  keyframeUrl: string
  /**
   * Optional context — character / scene / prop names + descriptions.
   * Baked into the motion text so the model knows what to look for in
   * the keyframe. NOT passed as additional image inputs.
   */
  contextRefs?: BeatVideoContextRef[]
  /** 16:9 by default; pass '9:16' for vertical shoots. */
  aspect?: '16:9' | '9:16' | '1:1' | '4:3'
  /**
   * Override the duration in seconds. Defaults to round(row.duration),
   * clamped to [5, 15] (Seedance's supported range).
   */
  durationSecondsOverride?: number
}

export interface BeatVideoResult {
  /** Video URL returned by the text-to-video capability. */
  url: string
  /** Full prompt that was sent (for retries / revise chain). */
  prompt: string
  /** Effective duration in seconds (post-clamp). */
  durationSeconds: number
  /** Keyframe URL that was used as the omni-reference. */
  keyframeUrl: string
  /** Context refs echoed back (text-only — not image inputs). */
  contextRefs: BeatVideoContextRef[]
}

export interface ReviseRequest {
  /** The shoot result that the director flagged for revision. */
  previous: BeatVideoResult
  /** Director-agent.critiqueVideoConsistency output. */
  feedback: VideoConsistencyIssue[]
  /**
   * Optional updated row, in case the director also tweaked the storyboard
   * fields (e.g., re-wrote motion_prompts). Defaults to the row that
   * produced `previous` — but since `previous` only carries the prompt,
   * callers usually pass the row again here for safety.
   */
  row: BeatVideoRow
  visualStyle?: string
  /** Same omni-reference image as the original shoot (or an updated one). */
  keyframeUrl: string
  contextRefs?: BeatVideoContextRef[]
  aspect?: '16:9' | '9:16' | '1:1' | '4:3'
  durationSecondsOverride?: number
}
