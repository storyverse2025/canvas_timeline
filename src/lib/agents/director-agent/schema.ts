import { z } from 'zod'

/**
 * Types for director-agent's 7 verbs.
 *
 * StoryboardRow itself lives in src/types/storyboard.ts — the agent doesn't
 * own that shape (downstream consumers like the storyboard table component
 * depend on it). Verbs that produce or consume rows reference the existing
 * type instead of redeclaring it.
 */

export const TimelineIssueSchema = z.object({
  shot: z.string(),
  issue: z.string(),
  fix: z.string(),
})
export type TimelineIssue = z.infer<typeof TimelineIssueSchema>

export const VideoConsistencyIssueSchema = z.object({
  aspect: z.enum(['characters', 'scene', 'props', 'action', 'style', 'continuity', 'other']),
  severity: z.enum(['info', 'minor', 'major', 'blocking']),
  summary: z.string(),
  /** Optional suggested fix the cinematographer agent can act on. */
  fix: z.string().optional(),
})
export type VideoConsistencyIssue = z.infer<typeof VideoConsistencyIssueSchema>

export interface AllocateShotsRequest {
  scriptAnalysis: string
  visualStrategy: string
  totalDurationSeconds: number
}

export interface ComposeShotsRequest {
  shotAllocation: string
  visualAnchor: string
}

export interface GenerateStoryboardTableRequest {
  artStyle: string
  totalDurationSeconds: number
  characterDesigns: string
  sceneDesigns: string
  propDesigns: string
  shotAllocation: string
  shotComposition: string
  visualStrategy: string
  elementContext: string
}

export interface CritiqueTimelineRequest {
  storyboardJson: string
}

export interface ApplyTimelineFixesRequest {
  storyboardJson: string
  issues: string[]
  totalDurationSeconds: number
}

/** Subset of fields the keyframe agent reads from a storyboard row. */
export interface KeyframeRow {
  storyboard_prompts?: string
  visual_description?: string
  lighting_atmosphere?: string
  emotion_mood?: string
  emotion_atmosphere?: string
  character_motivation?: string
  character_psychology?: string
  performance_guidance?: string
  shot_size?: string
}

/**
 * Structured character reference. Each ref may carry multiple reference
 * images (e.g., front + side + back three-views, or wide + close-up) — they
 * are passed to text-to-image as ordered image inputs and labeled
 * image1/image2/... in the prompt legend.
 */
export interface KeyframeCharacterRef {
  name: string
  /** Visual description (clothing, hair, distinctive features). */
  description?: string
  /** Reference images. Empty / missing = text-only reference. */
  imageUrls?: string[]
}

export interface KeyframeSceneRef {
  name?: string
  description?: string
  imageUrls?: string[]
}

export interface KeyframePropRef {
  name: string
  description?: string
  imageUrls?: string[]
}

/** Legacy free-form reference (kept for backwards compat with older callers). */
export interface KeyframeRef {
  role: string
  description?: string
  imageUrl: string
}

export interface GenerateKeyframeRequest {
  /** The storyboard row this keyframe realizes. */
  row: KeyframeRow

  /** How long this shot is (seconds). Required so the header bar prints it. */
  shotDurationSeconds: number

  /** Header-bar project info. All optional — defaults render gracefully. */
  projectTitle?: string
  /** TYPE — e.g. "短视频 (30-60秒)", "AI 漫剧". Sourced from
   *  project-db.script.creativeBrief.projectType (script-agent dossier). */
  projectType?: string
  /** TONE — e.g. "感动观众", "悬疑救赎". Same source. */
  projectTone?: string
  /** GENRE — combined type+tone label (e.g. "短视频 · 感动观众"). When set,
   *  rendered as its own prominent line in the project header bar so the
   *  image model sees genre intent before composition. */
  genre?: string
  /** Single-line visual style descriptor (e.g., "Cold-toned filmic"). */
  visualStyle?: string

  /** Up to 2 characters drive the dual-character three-view column. */
  characters?: KeyframeCharacterRef[]
  /** Scene reference for the top-right concept-art module. */
  scene?: KeyframeSceneRef
  /** Optional prop references (footer / inline). */
  props?: KeyframePropRef[]

  /**
   * Extra free-form image references (e.g., a previous keyframe to maintain
   * style). Appended after the structured refs in the legend.
   */
  refs?: KeyframeRef[]

  /** Aspect ratio for the rendered keyframe. Defaults to 16:9. */
  aspect?: '16:9' | '9:16' | '1:1' | '4:3'

  /**
   * When true, append a 2D stylization instruction so the rendered faces
   * don't trigger Seedance's privacy filter
   * (InputImageSensitiveContentDetected.PrivacyInformation). The
   * cinematographer-agent's shoot path retries with this flag after a
   * privacy block; everything else (composition, palette, lighting)
   * stays unchanged.
   */
  stylizeFacesFor2D?: boolean
}

export interface KeyframeResult {
  /** The image URL returned by text-to-image. */
  url: string
  /** The full text prompt that was sent (for retries/debug). */
  prompt: string
  /** Image references that were sent in stable order (image1, image2, ...). */
  imageRefs: Array<{ role: string; description?: string; imageUrl: string }>
}

export interface CritiqueVideoConsistencyRequest {
  /** URL of the generated beat-video clip. */
  videoUrl: string
  /** The storyboard row the video was supposed to realize. */
  expectedRow: KeyframeRow & { shot_number?: string; character_actions?: string }
  /** Optional canvas keyframe URL the video was generated from. */
  keyframeUrl?: string
}
