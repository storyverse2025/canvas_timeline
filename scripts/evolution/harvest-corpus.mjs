#!/usr/bin/env node
// Self-RAG growth (HarnessX D3): scan trace store + bench results for
// artifacts judged >= threshold, convert to the same shape as the existing
// prompt_rag JSONL corpus, and append (dedup by prompt hash) to
// evolution/self-corpus.jsonl — picked up automatically by
// vite-providers-plugin.ts's art-rag-search via PROMPT_RAG_EXTRA_JSONL.
//
// Usage: node scripts/evolution/harvest-corpus.mjs [--min-score 8.0] [--tiers L2b,L3]

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const REPO = process.cwd()
const TRACES_DIR = join(REPO, 'evolution', 'traces')
const RESULTS_DIR = join(REPO, 'evolution', 'results')
const CORPUS_PATH = join(REPO, 'evolution', 'self-corpus.jsonl')

function parseArgs(argv) {
  const out = { minScore: 8.0, tiers: ['L2b', 'L3'] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-score') out.minScore = Number(argv[++i])
    if (argv[i] === '--tiers') out.tiers = argv[++i].split(',')
  }
  return out
}

function hashPrompt(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function loadExistingIds() {
  if (!existsSync(CORPUS_PATH)) return new Set()
  const ids = new Set()
  for (const line of readFileSync(CORPUS_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { ids.add(JSON.parse(line).id) } catch { /* skip */ }
  }
  return ids
}

function* iterTraceRows() {
  if (!existsSync(TRACES_DIR)) return
  for (const f of readdirSync(TRACES_DIR).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(TRACES_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* skip */ }
    }
  }
}

function* iterResultRows() {
  if (!existsSync(RESULTS_DIR)) return
  for (const runId of readdirSync(RESULTS_DIR)) {
    const dir = join(RESULTS_DIR, runId)
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      try { yield JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { /* skip */ }
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const existingIds = loadExistingIds()
  const rows = []

  // Traces carry judgeScores at any tier + the full prompt (source=bench/evolve).
  for (const t of iterTraceRows()) {
    const judge = t.judgeScores
    if (!judge || !opts.tiers.includes(judge.tier)) continue
    if ((judge.overall ?? 0) < opts.minScore) continue
    if (!t.prompt) continue
    const id = `self-${hashPrompt(t.prompt)}`
    if (existingIds.has(id)) continue
    rows.push({
      id, prompt_text: t.prompt,
      output_media_url: t.output?.url ?? '',
      output_media_type: t.output?.kind ?? null,
      task_category: 'self-evolved', task_type: t.stage ?? t.capability,
      model_name: t.model ?? '', source_name: 'canvas_timeline_self', source_url: '',
    })
    existingIds.add(id)
  }

  // Bench case results carry judge scores but not always full media prompts;
  // harvest them too when judge tier qualifies (storyboard-level, no url).
  for (const r of iterResultRows()) {
    if (!opts.tiers.includes(r.judge?.tier)) continue
    if ((r.judge?.overall ?? 0) < opts.minScore) continue
    const id = `self-bench-${r.runId}-${r.caseId}`
    if (existingIds.has(id)) continue
    rows.push({
      id, prompt_text: `[bench:${r.caseId}] overall=${r.judge.overall}`,
      output_media_url: '', output_media_type: null,
      task_category: 'self-evolved-bench', task_type: r.caseId,
      model_name: '', source_name: 'canvas_timeline_self', source_url: '',
    })
    existingIds.add(id)
  }

  if (!rows.length) {
    console.log('[harvest-corpus] no new high-score artifacts found')
    return
  }
  for (const row of rows) {
    appendFileSync(CORPUS_PATH, JSON.stringify(row) + '\n', 'utf8')
  }
  console.log(`[harvest-corpus] appended ${rows.length} new example(s) -> ${CORPUS_PATH}`)
}

main()
