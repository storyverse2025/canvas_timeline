import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AEGIS adaptation-batch runner (HarnessX rollout stage).
 *
 * Env-gated e2e: runs the REAL director pipeline (live LLM calls through a
 * running dev server) for each 30s genre benchmark case, replicating exactly
 * what GenreCaseRunnerDialog does, then applies the L1 structure gate and
 * the L2a six-criteria judge, and writes evolution/results/<runId>/<caseId>.json
 * for the evolve controller / seesaw check.
 *
 *   EVOLUTION_BASE_URL=https://localhost:8080 EVOLUTION_RUN_ID=run1 pnpm bench
 *
 * Cost profile: text LLM calls only. Media capabilities (image/video/audio)
 * are stubbed with placeholders — L2a judges the storyboard table, not
 * pixels; keyframe/video tiers run separately under the evolve controller's
 * tier policy.
 *
 * Without EVOLUTION_BASE_URL the whole suite skips (offline vitest stays
 * green and free).
 */

const BASE_URL = process.env.EVOLUTION_BASE_URL ?? ''
const RUN_ID = process.env.EVOLUTION_RUN_ID ?? `bench-${Date.now().toString(36)}`
const CASE_FILTER = (process.env.EVOLUTION_CASES ?? '').split(',').filter(Boolean)
const CASE_TIMEOUT_MS = Number(process.env.EVOLUTION_CASE_TIMEOUT_MS ?? 45 * 60 * 1000)

// Self-signed dev certs (vite basicSsl) — Node fetch must not reject them.
if (BASE_URL.startsWith('https://localhost')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

// Media stub: text/agent capabilities go to the real server; image/video/
// audio return instant placeholders so a bench round costs zero media spend.
vi.mock('@/lib/capabilities/client', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/capabilities/client')>()
  const { CAPABILITIES } = await import('@/lib/capabilities/registry')
  const mediaKinds = new Map(
    CAPABILITIES.filter((c) => c.category !== 'agent').map((c) => [c.id, c.outputKind]),
  )
  return {
    ...orig,
    runCapability: async (req: import('@/lib/capabilities/types').CapabilityRequest) => {
      const kind = mediaKinds.get(req.capability)
      if (kind && kind !== 'text') {
        return { outputs: [{ kind, url: `/uploads/bench-placeholder.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}` }] }
      }
      return orig.runCapability(req)
    },
  }
})

describe.skipIf(!BASE_URL)('bench e2e — genre adaptation batch', async () => {
  const { GENRE_CASES, buildGenreCaseScript } = await import('@/lib/benchmarks/genre-cases')
  const { validateGenreStructure } = await import('@/lib/benchmarks/structure-gates')
  const { parseAndValidateStoryboard } = await import('@/lib/storyboard-parser')
  const { mergeSameSceneRows } = await import('@/lib/storyboard-merge')
  const { runDirectorPipeline } = await import('@/lib/director-assistant')
  const { setTraceContext } = await import('@/lib/capabilities/trace')
  const { runCapability } = await import('@/lib/capabilities/client')
  const { parseJudgeText } = await import('../judge-schema')
  const { caseResultSchema } = await import('../gates')
  const { useProjectDB } = await import('@/stores/project-db')
  const { useCanvasStore } = await import('@/stores/canvas-store')
  const { useCanvasItemStore } = await import('@/stores/canvas-item-store')
  const { useStoryboardStore } = await import('@/stores/storyboard-store')
  const { useChatStore } = await import('@/stores/chat-store')
  const { pickRecommendedAnswer } = await import('@/lib/agents/_shared/runtime/runner')

  const resultsDir = join(process.cwd(), 'evolution', 'results', RUN_ID)
  mkdirSync(resultsDir, { recursive: true })

  const cases = CASE_FILTER.length
    ? GENRE_CASES.filter((c) => CASE_FILTER.includes(c.id))
    : GENRE_CASES

  // director-assistant's expand-script step runs with { interactive: true }
  // (director-assistant.ts:181) so a REAL user sees an InterviewCard for
  // clarifying questions. Headless here — there is no UI to click Submit —
  // so without this, any Question turn deadlocks the pipeline forever (the
  // promise from chat-store.presentQuestion() never resolves) until vitest's
  // per-case timeout kills it. Auto-answer with the recommended option,
  // matching exactly what driveAuto() would do for a non-interactive caller.
  useChatStore.subscribe((state) => {
    const pending = state.pendingQuestion
    if (pending) {
      useChatStore.getState().answerQuestion(pending.id, pickRecommendedAnswer(pending.question))
    }
  })

  beforeEach(() => {
    useProjectDB.getState().clearAll()
    useCanvasStore.getState().clearAll()
    useCanvasItemStore.setState({ items: {} })
    useStoryboardStore.getState().replaceAll([])
  })

  for (const genreCase of cases) {
    it(
      `runs ${genreCase.id} through the real pipeline + gates + L2a judge`,
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        setTraceContext({ source: 'bench', runId: RUN_ID, caseId: genreCase.id })

        // — seed exactly as GenreCaseRunnerDialog does —
        const { updateScript, updateArtDirection } = useProjectDB.getState()
        updateScript({
          text: buildGenreCaseScript(genreCase),
          totalDurationSeconds: genreCase.totalDurationSeconds,
        })
        updateArtDirection({
          stylePreset: genreCase.stylePreset,
          defaultAspectRatio: genreCase.aspectRatio,
        })

        // — rollout —
        const { storyboardJson } = await runDirectorPipeline(() => {})
        const parsed = parseAndValidateStoryboard(storyboardJson)
        expect(parsed.ok, `分镜 JSON 解析失败: ${(parsed.errors ?? []).slice(0, 3).join('; ')}`).toBe(true)
        const merged = mergeSameSceneRows(parsed.rows!)

        // — L1 structure gate —
        const gate = validateGenreStructure(merged.rows, genreCase)

        // — L2a judge (real capability on the target server) —
        setTraceContext({ stage: 'judge' })
        const judgeRes = await runCapability({
          capability: 'six-criteria-judge',
          params: { tier: 'L2a', useExemplars: true },
          inputs: [
            {
              kind: 'text',
              text:
                `题材：${genreCase.genre}｜目标总时长：${genreCase.totalDurationSeconds}s｜风格：${genreCase.stylePreset}\n` +
                `分镜表 JSON：\n${JSON.stringify(merged.rows, null, 1)}`,
            },
          ],
        })
        const judge = parseJudgeText(judgeRes.outputs[0]!.text!, 'L2a')

        // — persist case result for the evolve controller —
        const result = caseResultSchema.parse({
          caseId: genreCase.id,
          runId: RUN_ID,
          rowCount: merged.rows.length,
          gate: { ok: gate.ok, issues: gate.issues },
          judge,
          ts: Date.now(),
        })
        writeFileSync(join(resultsDir, `${genreCase.id}.json`), JSON.stringify(result, null, 1))

        // attach gate+judge to the trace store (fire-and-forget)
        await fetch(`${BASE_URL}/traces/append`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            traceId: `tr-bench-${RUN_ID}-${genreCase.id}`,
            source: 'bench',
            runId: RUN_ID,
            caseId: genreCase.id,
            stage: 'judge',
            capability: 'bench-case-summary',
            inputs: [],
            durationMs: 0,
            status: 'ok',
            gateResult: { ok: gate.ok, issues: gate.issues },
            judgeScores: judge,
          }),
        }).catch(() => {})

        // The bench itself only asserts the run COMPLETED and produced a
        // parseable storyboard + judge verdict. Whether scores are good
        // enough is the seesaw's job, not a hard test failure — a failing
        // gate is exactly the evidence the Digester needs.
        expect(merged.rows.length).toBeGreaterThan(0)
        expect(judge.overall).toBeGreaterThanOrEqual(0)
      },
    )
  }
})
