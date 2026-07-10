#!/usr/bin/env node
// AEGIS harness evolution loop controller (HarnessX §4.3-4.4).
//
// Runs entirely inside an isolated worktree (canvas_timeline-evolve) on its
// own Vite dev server (port 8090) so a cron-triggered run never touches the
// user's live :8080 session or working tree. Winners are committed to the
// evolution/main branch for human review — this script never touches the
// user's checked-out branch.
//
// Usage:
//   pnpm evolve [--max-iterations 2] [--cases fight,romance] [--dry-run]
//
// --dry-run exercises worktree setup + health check + one rollout + Digester
// only, without spending on Planner/Evolver/Critic or ever writing a patch.
// Useful for verifying plumbing before trusting cron with real spend.

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  ensureWorktree, syncWorktree, startEvolutionServer, stopEvolutionServer,
  commitInWorktree, discardWorktreeChanges, WORKTREE_PATH,
} from './lib/worktree.mjs'
import { freeformText, parseJsonOutput } from './lib/llm.mjs'
import { validateCandidate, applyCandidate, revertCandidate, runSmokeChecks, isAllowlisted } from './lib/candidates.mjs'
import { loadState, saveState, recordIteration, recordAttemptedEdit, recordFailures, untriedComponents } from './lib/state.mjs'

const MAIN_REPO = process.cwd()
const EVOLUTION_DIR = join(MAIN_REPO, 'evolution')
const LOCK_PATH = join(EVOLUTION_DIR, 'evolve.lock')
const BASELINES_PATH = join(EVOLUTION_DIR, 'baselines.json')
const PORT = 8090
const PATIENCE = 3
const K_CANDIDATES = 3
const L3_EVERY_N_SHIPS = 5

function parseArgs(argv) {
  const out = { maxIterations: 2, cases: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-iterations') out.maxIterations = Number(argv[++i])
    else if (argv[i] === '--cases') out.cases = argv[++i]
    else if (argv[i] === '--dry-run') out.dryRun = true
  }
  return out
}

function acquireLock() {
  mkdirSync(EVOLUTION_DIR, { recursive: true })
  if (existsSync(LOCK_PATH)) {
    const pid = readFileSync(LOCK_PATH, 'utf8').trim()
    try {
      process.kill(Number(pid), 0) // throws if pid is dead
      throw new Error(`evolve already running (pid ${pid}, lock ${LOCK_PATH}). Refusing to start a second instance.`)
    } catch (e) {
      if (e.code === 'ESRCH') {
        console.warn(`[evolve] stale lock from dead pid ${pid}, removing`)
      } else {
        throw e
      }
    }
  }
  writeFileSync(LOCK_PATH, String(process.pid), 'utf8')
}

function releaseLock() {
  try { rmSync(LOCK_PATH) } catch { /* best-effort */ }
}

function loadBaselines() {
  return existsSync(BASELINES_PATH) ? JSON.parse(readFileSync(BASELINES_PATH, 'utf8')) : {}
}

function saveBaselines(b) {
  writeFileSync(BASELINES_PATH, JSON.stringify(b, null, 1), 'utf8')
}

function runBenchInWorktree(baseUrl, runId, cases) {
  execFileSync('npx', ['vitest', 'run', 'src/lib/evolution/__tests__/bench.e2e.test.ts'], {
    cwd: WORKTREE_PATH,
    env: {
      ...process.env,
      EVOLUTION_BASE_URL: baseUrl,
      EVOLUTION_RUN_ID: runId,
      ...(cases ? { EVOLUTION_CASES: cases } : {}),
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    stdio: 'inherit',
  })
  const dir = join(WORKTREE_PATH, 'evolution', 'results', runId)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
}

function runOfflineChecks() {
  // `tsc -b` (project-reference build mode) surfaces dozens of pre-existing,
  // unrelated type errors across the codebase that `tsc --noEmit -p
  // tsconfig.json` (the convention actually used everywhere else in this
  // project/session) does not — confirmed by running both on unchanged
  // main. Using `-b` here made every candidate fail this gate regardless of
  // merit, since the codebase already has pre-existing type errors nobody
  // is currently blocked by. Match the same check the rest of the workflow
  // uses so only genuine regressions introduced by a candidate's own patch
  // fail this step.
  execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: WORKTREE_PATH, stdio: 'inherit' })
  execFileSync('npx', ['vitest', 'run', '--exclude', '**/bench.e2e.test.ts'], {
    cwd: WORKTREE_PATH, stdio: 'inherit',
  })
}

function seesawCheck(candidateResults, baselines, targetCases, epsilon = 0.25, maxCriterionDrop = 1.0) {
  const regressions = []
  const byCase = new Map(candidateResults.map((c) => [c.caseId, c]))
  for (const [caseId, base] of Object.entries(baselines)) {
    const cand = byCase.get(caseId)
    if (!cand) { regressions.push(`${caseId}: missing from candidate run`); continue }
    if (base.gateOk && !cand.gate.ok) regressions.push(`${caseId}: structure gate regressed`)
    const delta = cand.judge.overall - base.judge.overall
    if (delta < -epsilon) regressions.push(`${caseId}: overall ${base.judge.overall}→${cand.judge.overall}`)
    for (const key of Object.keys(base.judge.criteria)) {
      const drop = base.judge.criteria[key].score - cand.judge.criteria[key].score
      if (drop > maxCriterionDrop) regressions.push(`${caseId}: ${key} dropped ${drop.toFixed(1)}`)
    }
  }
  const targets = targetCases.length ? targetCases : Object.keys(baselines)
  const deltas = targets.filter((id) => baselines[id] && byCase.has(id))
    .map((id) => byCase.get(id).judge.overall - baselines[id].judge.overall)
  const improved = deltas.length > 0 && deltas.reduce((a, b) => a + b, 0) / deltas.length > 0
  return { pass: regressions.length === 0, regressions, improved }
}

async function runIteration(iter, baseUrl, state, baselines, opts) {
  const runId = `evolve-${Date.now().toString(36)}-${iter}`
  console.log(`\n=== iteration ${iter} — rollout (runId=${runId}) ===`)
  const results = runBenchInWorktree(baseUrl, runId, opts.cases)
  if (results.length === 0) {
    console.warn('[evolve] rollout produced no results, treating as idle round')
    return { shipped: false, idle: true }
  }

  // Digester
  const digestPrompt = readFileSync(join(MAIN_REPO, 'scripts/evolution/prompts/digester.md'), 'utf8') +
    `\n\n本轮结果：\n${JSON.stringify(results, null, 1)}\n\n历史（最近3轮）：\n${JSON.stringify(state.iterations.slice(-3), null, 1)}`
  const digestText = await freeformText(baseUrl, digestPrompt, { temperature: 0.3 })
  const digest = parseJsonOutput(digestText)
  for (const c of digest.cases ?? []) {
    for (const comp of c.implicatedComponents ?? []) {
      recordFailures(state, comp, [{ iter, caseId: c.caseId, failureCategories: c.failureCategories }])
    }
  }
  console.log(`[evolve] digest: ${(digest.cases ?? []).map((c) => `${c.caseId}:${(c.failureCategories ?? []).join(',')}`).join(' | ')}`)

  if (opts.dryRun) {
    recordIteration(state, { iter, ts: Date.now(), digest, editIntents: [], candidates: [], shipped: false })
    return { shipped: false, idle: false, dryRunStop: true }
  }

  const allFine = (digest.cases ?? []).every((c) => (c.failureCategories ?? []).length === 0 || (c.failureCategories ?? []).includes('none'))
  if (allFine) {
    console.log('[evolve] no actionable failures this round')
    recordIteration(state, { iter, ts: Date.now(), digest, editIntents: [], candidates: [], shipped: false })
    return { shipped: false, idle: true }
  }

  // Planner
  const plannerPrompt = readFileSync(join(MAIN_REPO, 'scripts/evolution/prompts/planner.md'), 'utf8') +
    `\n\n本轮 digest：\n${JSON.stringify(digest, null, 1)}\n\n历史已试编辑：\n${JSON.stringify(state.attemptedEdits.slice(-20), null, 1)}\n\n未试过的组件：\n${JSON.stringify(untriedComponents(state), null, 1)}`
  const plannerText = await freeformText(baseUrl, plannerPrompt, { temperature: 0.5 })
  const planner = parseJsonOutput(plannerText)
  if (!planner.editIntents?.length) {
    console.log('[evolve] planner found no viable adaptation landscape')
    recordIteration(state, { iter, ts: Date.now(), digest, editIntents: [], candidates: [], shipped: false })
    return { shipped: false, idle: true }
  }
  console.log(`[evolve] editIntents: ${planner.editIntents.map((e) => e.targetComponent).join(', ')}`)

  // Evolver — gather current content of every implicated file
  const targetFiles = [...new Set(planner.editIntents.map((e) => e.targetComponent))]
  const currentContents = {}
  for (const f of targetFiles) {
    const abs = join(WORKTREE_PATH, f)
    currentContents[f] = existsSync(abs) ? readFileSync(abs, 'utf8') : '(file does not exist yet)'
  }
  const evolverPrompt = readFileSync(join(MAIN_REPO, 'scripts/evolution/prompts/evolver.md'), 'utf8') +
    `\n\n编辑意图（生成 ${K_CANDIDATES} 个候选，可以对应不同意图或同一意图的不同方案）：\n${JSON.stringify(planner.editIntents, null, 1)}` +
    `\n\n目标文件当前内容：\n${JSON.stringify(currentContents, null, 1)}`
  const evolverText = await freeformText(baseUrl, evolverPrompt, { temperature: 0.6 })
  const evolver = parseJsonOutput(evolverText)
  const rawCandidates = (evolver.candidates ?? []).slice(0, K_CANDIDATES)
  if (!rawCandidates.length) {
    console.log('[evolve] evolver produced zero candidates')
    recordIteration(state, { iter, ts: Date.now(), digest, editIntents: planner.editIntents, candidates: [], shipped: false })
    return { shipped: false, idle: true }
  }

  // Static validation (allowlist, manifest completeness, diff-locality)
  const validated = rawCandidates.map((c) => ({ candidate: c, check: validateCandidate(c) }))
  for (const { candidate, check } of validated) {
    if (!check.ok) console.warn(`[evolve] candidate ${candidate.id} rejected pre-critic: ${check.reason}`)
  }
  const survivors = validated.filter((v) => v.check.ok).map((v) => v.candidate)
  if (!survivors.length) {
    recordIteration(state, { iter, ts: Date.now(), digest, editIntents: planner.editIntents, candidates: rawCandidates.map((c) => ({ id: c.id, verdict: 'static-reject' })), shipped: false })
    return { shipped: false, idle: true }
  }

  // Critic
  const criticPrompt = readFileSync(join(MAIN_REPO, 'scripts/evolution/prompts/critic.md'), 'utf8') +
    `\n\ndigest：\n${JSON.stringify(digest, null, 1)}\n\n候选（含 diff = 新内容, manifest）：\n${JSON.stringify(survivors, null, 1)}`
  const criticText = await freeformText(baseUrl, criticPrompt, { temperature: 0.3 })
  const critic = parseJsonOutput(criticText)
  const accepted = new Set((critic.verdicts ?? []).filter((v) => v.verdict === 'accept').map((v) => v.candidateId))
  const shipOrder = (critic.shipRanking ?? []).filter((id) => accepted.has(id))
  console.log(`[evolve] critic verdicts: ${JSON.stringify(critic.verdicts?.map((v) => `${v.candidateId}:${v.verdict}`))}`)

  const iterationRecord = { iter, ts: Date.now(), digest, editIntents: planner.editIntents, candidates: [], shipped: false }

  for (const candId of shipOrder) {
    const candidate = survivors.find((c) => c.id === candId)
    if (!candidate) continue
    console.log(`[evolve] gating candidate ${candId}...`)
    const snapshot = applyCandidate(candidate, WORKTREE_PATH)
    let outcome = 'rejected'
    let reason = ''
    try {
      const smokeFailures = runSmokeChecks(candidate, WORKTREE_PATH)
      if (smokeFailures.length) throw new Error(`smoke check failed: ${smokeFailures.join('; ')}`)

      runOfflineChecks() // tsc -b + vitest run (offline suites)

      const server2 = await startEvolutionServer(PORT)
      let benchResults
      try {
        benchResults = runBenchInWorktree(server2.baseUrl, `${runId}-${candId}`, opts.cases)
      } finally {
        stopEvolutionServer()
      }

      const seesaw = seesawCheck(benchResults, baselines, candidate.manifest.targetCases ?? [])
      if (!seesaw.pass) throw new Error(`seesaw failed: ${seesaw.regressions.join('; ')}`)
      if (!seesaw.improved) throw new Error('no improvement on targeted cases (seesaw pass but not an improvement — not shipping a no-op)')

      // winner — commit to evolution/main
      const sha = commitInWorktree(
        `evolve: ${candidate.manifest.rationale}\n\n` +
        `iter=${iter} candidate=${candId}\nexpectedEffect: ${candidate.manifest.expectedEffect}\n` +
        `targetCases: ${(candidate.manifest.targetCases ?? []).join(', ')}\n`,
      )
      for (const r of benchResults) baselines[r.caseId] = { harnessVersion: { sha }, gateOk: r.gate.ok, judge: r.judge, updatedAt: new Date().toISOString() }
      saveBaselines(baselines)
      outcome = 'shipped'
      reason = `sha=${sha}`
      iterationRecord.shipped = true
      iterationRecord.shippedCandidate = candId
      console.log(`[evolve] SHIPPED ${candId} -> ${sha} on ${EVOLUTION_BRANCH_NOTE()}`)
      break
    } catch (e) {
      reason = e.message
      console.warn(`[evolve] candidate ${candId} rejected at gate: ${reason}`)
      revertCandidate(snapshot, WORKTREE_PATH)
      discardWorktreeChanges()
    } finally {
      recordAttemptedEdit(state, {
        targetFile: candidate.targetFiles?.[0], editType: candidate.editType,
        iter, outcome, rationale: candidate.manifest?.rationale, reason,
      })
      iterationRecord.candidates.push({ id: candId, outcome, reason })
    }
  }

  recordIteration(state, iterationRecord)
  return { shipped: iterationRecord.shipped, idle: !iterationRecord.shipped }
}

function EVOLUTION_BRANCH_NOTE() { return 'evolution/main (awaiting human review/merge)' }

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  acquireLock()
  try {
    ensureWorktree()
    syncWorktree()
    const { baseUrl } = await startEvolutionServer(PORT)
    console.log(`[evolve] worktree ${WORKTREE_PATH} server up at ${baseUrl}`)

    const state = loadState(MAIN_REPO)
    const baselines = loadBaselines()
    let idle = 0
    let ships = 0

    for (let i = 0; i < opts.maxIterations; i++) {
      const { shipped, idle: wasIdle, dryRunStop } = await runIteration(i, baseUrl, state, baselines, opts)
      saveState(state, MAIN_REPO)
      if (dryRunStop) { console.log('[evolve] --dry-run: stopping after one rollout+digest'); break }
      if (shipped) { ships++; idle = 0 } else if (wasIdle) { idle++ }
      if (idle >= PATIENCE) { console.log(`[evolve] idle for ${PATIENCE} rounds, stopping early`); break }
    }
    console.log(`[evolve] done: ${ships} shipped this run`)
  } finally {
    stopEvolutionServer()
    releaseLock()
  }
}

main().catch((e) => {
  console.error(`[evolve] fatal: ${e.stack ?? e.message}`)
  stopEvolutionServer()
  releaseLock()
  process.exit(1)
})
