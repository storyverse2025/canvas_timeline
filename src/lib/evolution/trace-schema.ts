import { z } from 'zod'

/**
 * Trace store record (HarnessX D8 observability).
 *
 * One row per capability invocation, appended to
 * evolution/traces/traces-YYYYMMDD.jsonl by the trace plugin
 * (vite-trace-plugin.ts). The AEGIS Digester reads these back via
 * GET /traces/query to build per-case failure evidence.
 *
 * Privacy split: `source: 'ui'` rows (organic user traffic) carry only
 * prompt hashes; `bench`/`evolve` rows carry the full prompt so the
 * Digester can implicate specific prompt components.
 */

export const harnessVersionSchema = z.object({
  sha: z.string(),
  branch: z.string(),
  dirty: z.boolean(),
})

export const traceInputSchema = z.object({
  kind: z.string(),
  url: z.string().optional(),
  textHash: z.string().optional(),
  textChars: z.number().optional(),
})

export const traceOutputSchema = z.object({
  kind: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  textHash: z.string().optional(),
})

export const traceRecordSchema = z.object({
  traceId: z.string(),
  ts: z.number(),
  harnessVersion: harnessVersionSchema.optional(),
  source: z.enum(['ui', 'bench', 'evolve']),
  runId: z.string().optional(),
  caseId: z.string().optional(),
  /** pipeline stage: optimize | selfcheck | fix | keyframe | video | judge | ... */
  stage: z.string().optional(),
  capability: z.string(),
  model: z.string().optional(),
  promptHash: z.string().optional(),
  promptChars: z.number().optional(),
  /** full prompt text — only persisted for bench/evolve sources */
  prompt: z.string().optional(),
  inputs: z.array(traceInputSchema).default([]),
  output: traceOutputSchema.optional(),
  durationMs: z.number(),
  status: z.enum(['ok', 'error']),
  error: z.string().optional(),
  /** attached by the bench runner after gates/judge run */
  gateResult: z.unknown().optional(),
  judgeScores: z.unknown().optional(),
})

export type TraceRecord = z.infer<typeof traceRecordSchema>
export type HarnessVersion = z.infer<typeof harnessVersionSchema>
