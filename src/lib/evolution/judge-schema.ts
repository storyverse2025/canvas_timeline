import { z } from 'zod'

/**
 * Output contract of the six-criteria-judge capability (HarnessX D6).
 * The judge prompt lives server-side in server/judge-prompts/six-criteria.md
 * and is deliberately OUTSIDE the Evolver's editable allowlist — a frozen
 * verifier keeps rewards comparable across harness versions and closes the
 * cheapest reward-hacking channel (editing the judge).
 */

export const CRITERIA_KEYS = [
  'composition_art_style',
  'character_appeal',
  'continuity_consistency',
  'pacing_for_traffic',
  'shot_language',
  'expression_emotion',
] as const

export type CriterionKey = (typeof CRITERIA_KEYS)[number]

export const criterionScoreSchema = z.object({
  score: z.number().min(0).max(10),
  rationale: z.string(),
  evidence: z.array(z.string()).default([]),
})

export const judgeTierSchema = z.enum(['L2a', 'L2b', 'L3'])
export type JudgeTier = z.infer<typeof judgeTierSchema>

export const judgeRawSchema = z.object({
  criteria: z.object({
    composition_art_style: criterionScoreSchema,
    character_appeal: criterionScoreSchema,
    continuity_consistency: criterionScoreSchema,
    pacing_for_traffic: criterionScoreSchema,
    shot_language: criterionScoreSchema,
    expression_emotion: criterionScoreSchema,
  }),
  flags: z.array(z.string()).default([]),
})

export const judgeOutputSchema = judgeRawSchema.extend({
  /** weighted mean of the six scores (weights from evolution config) */
  overall: z.number().min(0).max(10),
  tier: judgeTierSchema,
  judgeModel: z.string().optional(),
  judgeVersion: z.string().optional(),
  exemplarRefs: z.array(z.string()).default([]),
})

export type JudgeRaw = z.infer<typeof judgeRawSchema>
export type JudgeOutput = z.infer<typeof judgeOutputSchema>

export const DEFAULT_CRITERIA_WEIGHTS: Record<CriterionKey, number> = {
  composition_art_style: 1,
  character_appeal: 1,
  continuity_consistency: 1,
  pacing_for_traffic: 1,
  shot_language: 1,
  expression_emotion: 1,
}

export function computeOverall(
  raw: JudgeRaw,
  weights: Record<CriterionKey, number> = DEFAULT_CRITERIA_WEIGHTS,
): number {
  let sum = 0
  let wsum = 0
  for (const key of CRITERIA_KEYS) {
    const w = weights[key] ?? 1
    sum += raw.criteria[key].score * w
    wsum += w
  }
  return wsum > 0 ? Number((sum / wsum).toFixed(2)) : 0
}

/** Parse the judge capability's raw text output into a JudgeOutput. */
export function parseJudgeText(
  text: string,
  tier: JudgeTier,
  extras?: { judgeModel?: string; exemplarRefs?: string[] },
): JudgeOutput {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  const raw = judgeRawSchema.parse(JSON.parse(cleaned))
  return {
    ...raw,
    overall: computeOverall(raw),
    tier,
    judgeModel: extras?.judgeModel,
    judgeVersion: 'six-criteria-v1',
    exemplarRefs: extras?.exemplarRefs ?? [],
  }
}
