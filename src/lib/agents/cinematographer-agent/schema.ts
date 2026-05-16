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

/** Image reference passed to Seedance as a `kind: image` input. */
export interface BeatVideoRef {
  /** Human-readable role tag — appears in the prompt's image legend. */
  role: string
  description?: string
  imageUrl: string
}

export interface ShootRequest {
  /** The storyboard row this clip realizes. */
  row: BeatVideoRow
  /** Optional global art-style hint (e.g., "Cold-toned filmic noir"). */
  visualStyle?: string
  /** Ordered references. The keyframe should typically be refs[0]. */
  refs: BeatVideoRef[]
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
  /** Echoed refs in the same order they appear in the image legend. */
  refs: BeatVideoRef[]
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
  refs: BeatVideoRef[]
  aspect?: '16:9' | '9:16' | '1:1' | '4:3'
  durationSecondsOverride?: number
}
