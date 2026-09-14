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
  /** Original user-provided script text. The critic uses this to flag
   *  rows that contradict the user's input — added/removed scenes,
   *  reshuffled shot order, fabricated character actions the user
   *  never wrote, etc. Without this anchor the critic can only check
   *  internal consistency, not faithfulness to the source. */
  userScript: string
  /** Formatted Q&A of the user's answers to script-agent's ask phase
   *  (the script-specific 3-5 clarification questions). Lines like
   *  "Q: 沃斯的动机是什么？\nA: 维护秩序的执念，不是单纯的恶。"
   *  The critic verifies the storyboard doesn't violate these
   *  user-stated choices. Empty string when the user answered nothing. */
  userClarifications: string
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

  /**
   * Free-form note appended to both grid + clean prompts. Used by the
   * iterative-refine loop to feed the previous critique's findings into
   * the next generation pass ("fix the casting drift; tighten framing;
   * preserve the lighting"). Empty / undefined = first pass, no header.
   */
  feedbackNote?: string
}

// ─── generateIdentitySheet ────────────────────────────────────────
//
// 角色身份版 — one 16:9 sheet per character that locks the character's
// identity for every downstream generation: full-body anchor + auxiliary
// views + silhouettes + expressions + detail close-ups + an ID block.
// Relit with the row's scene lighting and scale-locked against the row's
// prop references.

export interface GenerateIdentitySheetRequest {
  /** The character this sheet locks. imageUrls = existing asset images
   *  (identity anchors — face/costume must match them exactly). */
  character: KeyframeCharacterRef
  /**
   * Identity sheets already generated for the SAME character on other
   * rows. Shipped as costume/detail CANON references so every sheet
   * repeats the same accessories (玉佩、绣纹、系带…) instead of
   * re-inventing small details per row — the root cause of cross-row
   * costume drift.
   */
  priorSheetUrls?: string[]
  /**
   * THIS row's dramatic context. Without it the sheet's silhouettes /
   * expressions / views are generic; with it they preview the actions,
   * camera angles and emotional beat the row will actually shoot.
   */
  rowContext?: {
    shotNumber?: string
    /** row.character_actions */
    actions?: string
    /** row.shot_size */
    shotSize?: string
    /** row.emotion_atmosphere */
    emotionAtmosphere?: string
    /** row.performance_guidance */
    performanceGuidance?: string
  }
  /** Prop references from the same row. Rendered in the scale strip so
   *  the character↔prop 比例 is fixed once and reused by later shots. */
  props?: KeyframePropRef[]
  /** Scene reference. Used ONLY as the lighting source (刷光): light
   *  direction, color temperature, contrast — never as a backdrop. */
  scene?: KeyframeSceneRef
  /** Resolved art-style prose (via getArtStyle), same as keyframes. */
  visualStyle?: string
  /** Character's 核心情绪 / dramatic function for the ID block. */
  coreEmotion?: string
  /** Character's 视觉标志 (visual mark) for the ID block. */
  visualMark?: string
  aspect?: '16:9' | '9:16' | '1:1' | '4:3'
  /** Same privacy-retry flag as keyframes. */
  stylizeFacesFor2D?: boolean
}

export interface IdentitySheetResult {
  url: string
  prompt: string
  /** Image references sent, in order (image1, image2, …). */
  imageRefs: Array<{ role: string; description?: string; imageUrl: string }>
}

// ─── critiqueKeyframe ─────────────────────────────────────────────

export interface KeyframeIssue {
  /** Which dimension drifted. */
  aspect: 'casting' | 'composition' | 'action' | 'mood' | 'style' | 'lighting' | 'props' | 'continuity' | 'other'
  /** How bad it is. */
  severity: 'minor' | 'major' | 'blocking'
  /** One-line description of what's wrong. */
  summary: string
  /** Concrete fix the next iteration should apply. */
  fix: string
}

export interface CritiqueKeyframeResult {
  /** Overall quality score (0 = unusable, 10 = matches expectation perfectly). */
  score: number
  /** Per-issue breakdown. Empty when the keyframe matches the row. */
  issues: KeyframeIssue[]
  /** One-line overall verdict for the chat log. */
  summary: string
}

export interface CritiqueKeyframeRequest {
  /** The candidate keyframe URL to judge. Prefer the clean variant. */
  keyframeUrl: string
  /** Row metadata describing what the keyframe was supposed to realize. */
  row: KeyframeRow & {
    shot_number?: string
    character_actions?: string
    emotion_mood?: string
  }
  /** Optional character / scene / prop names so the critic can call out drift
   *  by name ("Alice's hair is now long, should be short"). */
  expected?: {
    characters?: string[]
    scene?: string
    props?: string[]
  }
}

export interface KeyframeResult {
  /**
   * The grid keyframe URL — multi-panel storyboard sheet with time-slice
   * labels, character/prop diagrams, floor plan. Kept for the UI's pacing
   * reference and as the fallback when the clean variant isn't available.
   */
  url: string
  /** The full text prompt for the grid sheet (for retries/debug). */
  prompt: string
  /** Image references that were sent in stable order (image1, image2, ...). */
  imageRefs: Array<{ role: string; description?: string; imageUrl: string }>
  /**
   * Single clean cinematic frame — no panels, no labels, no diagrams.
   * Cinematographer prefers this as the Seedance omni-reference so the
   * grid sheet's borders don't leak into the generated video. Optional
   * for back-compat (older code paths still return only `url`).
   */
  cleanUrl?: string
  /** The full text prompt for the clean frame (for retries/debug). */
  cleanPrompt?: string
  /**
   * True when `prompt` was derived by the LLM pre-pass (故事板结构模板 +
   * 分镜参考 + 人物/场景图 + 主题 → 黑白手绘故事板提示词) rather than
   * taken verbatim from the structure template. The caller drops the
   * derived prompt on the canvas as a text node upstream of the
   * storyboard image so the user can read / edit the reasoning chain.
   */
  promptDerived?: boolean
  /**
   * Set when the 黑白故事板 (grid) render FAILED but the 开场构图 (clean)
   * succeeded. In that case `url` falls back to `cleanUrl` for back-compat,
   * which means url === cleanUrl — the caller must NOT store `url` as the
   * row's storyboard (both table columns would show the same clean frame
   * and the video reference pack would ship a fake "storyboard"). Carries
   * the grid error message so the UI can surface why and offer a retry.
   */
  gridFailReason?: string
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
