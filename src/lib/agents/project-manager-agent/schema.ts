import { z } from 'zod'

/**
 * Subset of fields the PM gets to look at when interpreting a chat
 * request. Mirrors gap-finder.ProjectGapSummary but pruned to the
 * data the LLM actually needs (no full row objects — just ids +
 * shot numbers).
 */
export interface PMGapSummary {
  totalRows: number
  missingAssetsCount: number
  missingAssets: Array<{ kind: 'character' | 'scene' | 'prop'; name: string }>
  rowsMissingKeyframe: Array<{ id: string; shot_number: string }>
  rowsMissingBeatVideo: Array<{ id: string; shot_number: string }>
  rowsWithBothKeyframeAndVideo: Array<{ id: string; shot_number: string }>
  nextSuggestion: string
}

/** One past chat message, lightly formatted for the PM prompt. */
export interface PMRecentMessage {
  role: 'user' | 'assistant' | 'system'
  /** Truncated to ~300 chars by the caller. */
  content: string
}

export interface PMInterpretRequest {
  userMessage: string
  gapSummary: PMGapSummary
  recentMessages: PMRecentMessage[]
}

// ─── PMAction discriminated union ───────────────────────────────

export const PMActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run-director-assistant') }),
  z.object({ type: z.literal('generate-missing-assets') }),
  z.object({
    type: z.literal('generate-missing-keyframes'),
    rowIds: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('generate-missing-videos'),
    rowIds: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('add-missing-storyboard-rows') }),
  z.object({
    type: z.literal('update-downstream-videos'),
    rowIds: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('actor-enrich-row'),
    rowId: z.string().min(1),
  }),
  z.object({
    type: z.literal('sound-design-row'),
    rowId: z.string().min(1),
  }),
  // ─── patch-canvas-pattern ───────────────────────────────────────
  // "Find every image whose prompt contains X and rewrite it to Y."
  // PM emits this when the user describes a *pattern fix* — a
  // misconception baked into many shots — rather than asking for a
  // single edit. Director then enumerates matches via canvas-api
  // searchNodes, rewrites each prompt through an LLM (preserving
  // style/lighting/character), regenerates the images, and decides
  // about downstream video based on `alsoRegenerateVideo`.
  //
  // Concrete: 用户说"所有手持左轮手枪的角色改成机甲持枪、人坐机甲内"
  //   → target.promptContains: ['左轮手枪']
  //   → intent: '机甲手持巨型手枪，人类坐在机甲内部操控'
  //   → alsoRegenerateVideo: 'ask'
  z.object({
    type: z.literal('patch-canvas-pattern'),
    target: z.object({
      /** Substring terms; canvas-api auto-expands via the synonym
       *  dictionary, so PM should emit the user's natural phrase
       *  ("左轮手枪") — the search layer handles 中英 synonyms. */
      promptContains: z.array(z.string().min(1)).min(1),
      /** Optional: restrict to specific item kinds. Default: image. */
      kinds: z.array(z.enum(['image', 'text', 'video', 'audio'])).optional(),
      /** Optional: restrict to roles (character, scene, prop,
       *  keyframe, ...). Default: all roles. */
      roles: z.array(z.string().min(1)).optional(),
    }),
    /** Free-form description of the desired change. Fed verbatim to
     *  the rewrite-prompt LLM as the "what should change" instruction;
     *  the LLM preserves style / lighting / composition. */
    intent: z.string().min(1),
    /** Whether to also regenerate videos for any storyboard rows
     *  whose keyframe was changed. 'ask' surfaces a chat question
     *  after image regen finishes (recommended default — image
     *  changes are often enough to validate without burning video
     *  generation budget). */
    alsoRegenerateVideo: z.enum(['ask', 'always', 'never']).default('ask'),
  }),
  z.object({
    type: z.literal('chat-response'),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal('ask-user'),
    question: z.string().min(1),
  }),
])
export type PMAction = z.infer<typeof PMActionSchema>

export const PMPlanSchema = z.object({
  reasoning: z.string(),
  actions: z.array(PMActionSchema).min(1),
})
export type PMPlan = z.infer<typeof PMPlanSchema>
