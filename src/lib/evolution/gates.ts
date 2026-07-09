import { z } from 'zod'
import { judgeOutputSchema, CRITERIA_KEYS, type JudgeOutput } from './judge-schema'
import { EVOLUTION_CONFIG } from './config'

/**
 * Deterministic gate + seesaw constraint (HarnessX/AEGIS §4).
 *
 * Pure functions only — no I/O, no LLM. The Critic's LLM judgement is
 * advisory; regardless of what it recommends, only these checks govern
 * whether a candidate harness ships. Frozen verifier surface (see config.ts).
 */

export const structureGateResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(z.string()),
})

export const caseResultSchema = z.object({
  caseId: z.string(),
  runId: z.string(),
  harnessVersion: z
    .object({ sha: z.string(), branch: z.string(), dirty: z.boolean() })
    .optional(),
  rowCount: z.number(),
  gate: structureGateResultSchema,
  judge: judgeOutputSchema,
  ts: z.number(),
})

export type CaseResult = z.infer<typeof caseResultSchema>

export const baselinesSchema = z.record(
  z.string(),
  z.object({
    harnessVersion: z.object({ sha: z.string(), branch: z.string(), dirty: z.boolean() }).optional(),
    gateOk: z.boolean(),
    judge: judgeOutputSchema,
    updatedAt: z.string(),
  }),
)

export type Baselines = z.infer<typeof baselinesSchema>

export interface SeesawVerdict {
  pass: boolean
  /** hard failures: any previously-passing case regressed */
  regressions: string[]
  /** the improvement requirement: did targeted cases strictly improve */
  improved: boolean
  details: string[]
}

/**
 * Seesaw constraint: for EVERY case present in the baselines, the candidate
 * must (a) still pass the structure gate if the baseline passed it,
 * (b) keep judge overall ≥ baseline − ε, and (c) not drop any single
 * criterion by more than maxCriterionDrop. Ship additionally requires the
 * mean overall on `targetCases` to strictly improve.
 */
export function seesawCheck(
  candidate: CaseResult[],
  baselines: Baselines,
  targetCases: string[] = [],
): SeesawVerdict {
  const { epsilon, maxCriterionDrop } = EVOLUTION_CONFIG
  const regressions: string[] = []
  const details: string[] = []
  const byCase = new Map(candidate.map((c) => [c.caseId, c]))

  for (const [caseId, base] of Object.entries(baselines)) {
    const cand = byCase.get(caseId)
    if (!cand) {
      regressions.push(`${caseId}: 候选结果缺失（基线中存在的案例必须全部重跑）`)
      continue
    }
    if (base.gateOk && !cand.gate.ok) {
      regressions.push(`${caseId}: 结构门回归（基线通过，候选未过：${cand.gate.issues.slice(0, 2).join('; ')}）`)
    }
    const delta = cand.judge.overall - base.judge.overall
    if (delta < -epsilon) {
      regressions.push(`${caseId}: overall 回归 ${base.judge.overall} → ${cand.judge.overall}（Δ${delta.toFixed(2)} < -ε${epsilon}）`)
    }
    for (const key of CRITERIA_KEYS) {
      const drop = base.judge.criteria[key].score - cand.judge.criteria[key].score
      if (drop > maxCriterionDrop) {
        regressions.push(`${caseId}: 单项 ${key} 跌幅 ${drop.toFixed(1)} > ${maxCriterionDrop}`)
      }
    }
    details.push(`${caseId}: overall ${base.judge.overall} → ${cand.judge.overall} (Δ${delta.toFixed(2)})`)
  }

  const targets = targetCases.length ? targetCases : Object.keys(baselines)
  const targetDeltas = targets
    .filter((id) => baselines[id] && byCase.has(id))
    .map((id) => byCase.get(id)!.judge.overall - baselines[id]!.judge.overall)
  const improved =
    targetDeltas.length > 0 &&
    targetDeltas.reduce((a, b) => a + b, 0) / targetDeltas.length > 0

  return { pass: regressions.length === 0, regressions, improved, details }
}

/** Merge one case's fresh result into the baselines (best-passing record). */
export function mergeBaseline(baselines: Baselines, result: CaseResult): Baselines {
  return {
    ...baselines,
    [result.caseId]: {
      harnessVersion: result.harnessVersion,
      gateOk: result.gate.ok,
      judge: result.judge,
      updatedAt: new Date().toISOString(),
    },
  }
}

/** Of two runs of the same case, keep the median-ish (lower) one so the
 *  baseline is conservative — bootstrapping runs twice and calls this. */
export function conservativeBaseline(a: JudgeOutput, b: JudgeOutput): JudgeOutput {
  return a.overall <= b.overall ? a : b
}
