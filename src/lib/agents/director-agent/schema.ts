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
  /**
   * The post-doctor revised script (same value the caller passes to
   * generateStoryboardTable). Lets the allocator count shots from the
   * user's actual shot markers ("镜头 A/B/C", "RAPID CUTS", "FLASH
   * IMAGES", "场景 N", etc.) rather than re-inventing them from the
   * script analysis summary. When the user already wrote the shot
   * breakdown, the allocator must honor it.
   */
  revisedScript: string
}

export interface ComposeShotsRequest {
  shotAllocation: string
  visualAnchor: string
  /**
   * Optional post-doctor revised script. Lets the composer reference
   * the user's per-shot framing notes ("摄像机拉远", "慢动作", specific
   * blocking) when designing composition, rather than working purely
   * from the allocation summary.
   */
  revisedScript?: string
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
  /**
   * The post-doctor revised script. The prompt now grounds storyboard
   * generation in the actual revised script text (not just the
   * derived analysis), so the doctor's must-fix corrections actually
   * land in each shot's visual_description / character_motivation. The
   * caller passes the same text it persisted to script.optimizedText.
   */
  revisedScript: string
}

export interface CritiqueTimelineRequest {
  storyboardJson: string
  /** Project art style — surfaces in the self-check so the LLM flags
   *  rows that drift away from the locked visual language. */
  artStyle: string
  /** Canonical character names from the dossier's casting cards. Lets
   *  the self-check spot rows that reference unrelated/extras like
   *  "blonde stranger" instead of the protagonists. */
  characterNames: string[]
  /** Suggested reasonable row count for the storyboard given the total
   *  duration. Computed as `ceil(totalDurationSeconds / 12)` ± wiggle.
   *  Surfaces in the prompt as the "合理镜头/row 数" guidance. */
  targetRowCount: number
  /** Total duration in seconds; sums of row durations must equal this. */
  totalDurationSeconds: number
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

// ─── searchAndRewrite ─────────────────────────────────────────────
//
// "Find every image whose prompt contains X and rewrite/regenerate it
// according to intent Y, preserving style and unrelated elements."
//
// The verb walks canvas-api.searchNodes, calls the rewrite-prompt LLM
// per-match (so each prompt keeps its specific character/lighting/
// composition context), and then calls canvas-api.regenerateImage on
// each. Per-node rewriting was a deliberate choice over batch (chosen
// by the user earlier): higher accuracy, predictable cost per node,
// and partial-failure semantics that don't poison the whole batch.

export interface SearchAndRewriteRequest {
  /** Forwarded to canvas-api.searchNodes — see canvas-api/types.ts. */
  target: {
    promptContains: string[]
    kinds?: Array<'image' | 'text' | 'video' | 'audio'>
    roles?: string[]
  }
  /** Free-form description of the desired change, fed verbatim to the
   *  rewrite-prompt LLM. */
  intent: string
  /** Concurrency cap for the regenerateImage fan-out. Defaults to 3
   *  — high enough to feel responsive, low enough to avoid hammering
   *  the image backend or burning the user's quota in one go. */
  maxConcurrent?: number
}

export interface SearchAndRewriteNodeResult {
  nodeId: string
  shotNumber?: string
  oldPrompt: string
  newPrompt: string
  /** New image URL, or undefined if generation failed. */
  newImageUrl?: string
  error?: string
}

export interface SearchAndRewriteResult {
  /** How many matches the search returned before any work. */
  matchCount: number
  /** Per-node outcome. Includes failures so the caller can show
   *  which shots need user attention. */
  results: SearchAndRewriteNodeResult[]
}

// ─── proposeBridgeRow ─────────────────────────────────────────────
//
// Look at two adjacent storyboard rows and decide whether a bridging row
// should be inserted between them to repair a jarring cut. The verb does
// NOT generate keyframes or videos — it only proposes the row's text
// content + element slots. The user clicks ✨ later.

/**
 * Minimum shape the bridge-row proposal carries back. Mirrors the
 * required-ish columns of a storyboard row; anything missing falls back
 * to sensible defaults during insertion. Aligned with
 * src/types/storyboard.ts so the orchestrator can pass it straight to
 * insertRowAfter() without lossy mapping.
 *
 * Element slot suggestions (character1Name, scene_suggestion, …) are kept
 * separate from the actual ElementSlot shape because the agent only sees
 * names — the orchestrator resolves those to image URLs + nodeIds against
 * the asset store before insertion.
 */
export const BridgeRowProposalSchema = z.object({
  shot_number: z.string().default(''),
  duration: z.number().min(2).max(6).default(3),
  visual_description: z.string().default(''),
  shot_size: z.string().default(''),
  character_actions: z.string().default(''),
  emotion_mood: z.string().default(''),
  emotion_atmosphere: z.string().default(''),
  lighting_atmosphere: z.string().default(''),
  storyboard_prompts: z.string().default(''),
  motion_prompts: z.string().default(''),
  sound_effects: z.string().default(''),
  dialogue: z.string().default(''),
  visual_anchor: z.string().default(''),
  /** Names the agent picked for the bridge — orchestrator resolves to slot URLs. */
  character1_name: z.string().default(''),
  character2_name: z.string().default(''),
  scene_name: z.string().default(''),
  prop1_name: z.string().default(''),
  prop2_name: z.string().default(''),
})
export type BridgeRowProposal = z.infer<typeof BridgeRowProposalSchema>

export const BridgeJudgeSchema = z.object({
  needed: z.boolean(),
  /** Free-form reason rendered in the toast / chat log. */
  reason: z.string().default(''),
  /** Populated only when needed===true. */
  bridge: BridgeRowProposalSchema.optional(),
})
export type BridgeJudge = z.infer<typeof BridgeJudgeSchema>

/** Inputs the verb needs to make a single judgement on one (prev, next) pair. */
export interface ProposeBridgeRowRequest {
  /** Required text context for the previous row. */
  prevRow: KeyframeRow & {
    shot_number?: string
    duration?: number
    character_actions?: string
    dialogue?: string
    character1_name?: string
    character2_name?: string
    scene_name?: string
  }
  /** Required text context for the next row. */
  nextRow: KeyframeRow & {
    shot_number?: string
    duration?: number
    character_actions?: string
    dialogue?: string
    character1_name?: string
    character2_name?: string
    scene_name?: string
  }
  /**
   * Image URL of the last visible frame of the prev clip — prefer the
   * actual last frame extracted from prev.beatVideoUrl, fall back to
   * prev.keyframeUrl, omit entirely when neither exists.
   */
  prevLastFrameUrl?: string
  /** Same idea, but the first frame of the next clip. */
  nextFirstFrameUrl?: string
  /** Project metadata kept short for the prompt header. */
  projectType?: string
  projectTone?: string
  /** Names of all known characters / scenes / props so the agent picks valid slot fillers. */
  knownCharacterNames?: string[]
  knownSceneNames?: string[]
  knownPropNames?: string[]
}
