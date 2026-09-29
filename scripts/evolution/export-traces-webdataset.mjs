#!/usr/bin/env node
// Training bridge (HarnessX D9): every trace is a potential RL/finetune
// record. Export high-score traces + their public/uploads media into the
// same WebDataset sample layout used by prompt_rag's export_webdataset.py,
// under evolution/webdataset/. No model training happens here — this just
// makes the system's own successes consumable by a future training step.
//
// Uses the system `tar` binary (no new npm dependency) — same approach as
// prompt_rag's Python export, which uses stdlib tarfile.
//
// Usage: node scripts/evolution/export-traces-webdataset.mjs [--min-score 8.0]

import {
  readFileSync, existsSync, readdirSync, mkdirSync, statSync,
  writeFileSync, copyFileSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = process.cwd()
const TRACES_DIR = join(REPO, 'evolution', 'traces')
const UPLOADS_DIR = join(REPO, 'public', 'uploads')
const OUT_DIR = join(REPO, 'evolution', 'webdataset')
const SHARD_TARGET_BYTES = 1 << 30

function parseArgs(argv) {
  const out = { minScore: 8.0 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--min-score') out.minScore = Number(argv[++i])
  }
  return out
}

function localUploadPath(url) {
  if (!url || !url.startsWith('/uploads/')) return null
  const p = join(UPLOADS_DIR, url.slice('/uploads/'.length))
  return existsSync(p) ? p : null
}

function keyOf(traceId) {
  return traceId.replace(/[^A-Za-z0-9_-]/g, '-')
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(TRACES_DIR)) {
    console.log('[export-traces-webdataset] no trace store yet, nothing to export')
    return
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const staging = join(OUT_DIR, '_staging')
  mkdirSync(staging, { recursive: true })

  const manifestRows = []
  let batchBytes = 0
  let shardIdx = 0
  let currentFiles = []

  function flushShard() {
    if (!currentFiles.length) return
    const shardName = `shard-${String(shardIdx).padStart(6, '0')}.tar`
    // sort so keys stay adjacent (WebDataset convention) — files are
    // already appended as [json, media] pairs in key order.
    execFileSync('tar', ['-cf', join(OUT_DIR, shardName), '-C', staging, ...currentFiles])
    manifestRows.push({ shard: shardName, samples: currentFiles.length / 2 })
    shardIdx++
    currentFiles = []
    batchBytes = 0
  }

  let exported = 0
  for (const f of readdirSync(TRACES_DIR).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(TRACES_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const judge = row.judgeScores
      if (!judge || (judge.overall ?? 0) < opts.minScore) continue
      const mediaPath = localUploadPath(row.output?.url)
      if (!mediaPath) continue

      const key = keyOf(row.traceId)
      const ext = mediaPath.split('.').pop()
      const jsonName = `${key}.json`
      const mediaName = `${key}.${ext}`
      writeFileSync(join(staging, jsonName), JSON.stringify({
        id: row.traceId, source: 'canvas_timeline_self', prompt_text: row.prompt ?? '',
        capability: row.capability, stage: row.stage, judge, harnessVersion: row.harnessVersion,
      }, null, 1))
      copyFileSync(mediaPath, join(staging, mediaName))
      currentFiles.push(jsonName, mediaName)
      batchBytes += statSync(mediaPath).size
      exported++
      if (batchBytes >= SHARD_TARGET_BYTES) flushShard()
    }
  }
  flushShard()
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify({ exported, shards: manifestRows }, null, 1))
  rmSync(staging, { recursive: true, force: true })
  console.log(`[export-traces-webdataset] exported ${exported} sample(s) across ${manifestRows.length} shard(s) -> ${OUT_DIR}`)
}

main()
