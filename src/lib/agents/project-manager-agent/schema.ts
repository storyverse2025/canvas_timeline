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
