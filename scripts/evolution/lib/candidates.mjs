// Typed-edit application: allowlist enforcement, patch apply/revert, smoke
// checks. This is the ONLY place candidate patches touch disk — every write
// goes through isAllowlisted() first, so a candidate that names an
// out-of-scope file (a judge prompt, gates.ts, this script itself) is
// rejected before it ever reaches the Critic.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const allowlistJson = JSON.parse(
  readFileSync(join(process.cwd(), 'evolution', 'allowlist.json'), 'utf8'),
)
const ALLOWLIST = allowlistJson.patterns.map((p) => new RegExp(p))

export function isAllowlisted(relPath) {
  const normalized = relPath.replace(/^\.\//, '')
  return ALLOWLIST.some((re) => re.test(normalized))
}

/**
 * Validate a candidate's shape and allowlist membership. Returns
 * { ok: true } or { ok: false, reason }. Does NOT touch disk.
 */
export function validateCandidate(candidate) {
  if (!candidate?.id || !Array.isArray(candidate.patches) || candidate.patches.length === 0) {
    return { ok: false, reason: 'candidate missing id or patches[]' }
  }
  if (!candidate.manifest?.rationale || !candidate.manifest?.expectedEffect) {
    return { ok: false, reason: 'manifest missing rationale/expectedEffect (incomplete manifest)' }
  }
  for (const patch of candidate.patches) {
    if (!patch.path || typeof patch.newContent !== 'string') {
      return { ok: false, reason: `patch missing path/newContent: ${JSON.stringify(patch).slice(0, 100)}` }
    }
    if (patch.path.includes('..')) {
      return { ok: false, reason: `patch path escapes repo: ${patch.path}` }
    }
    if (!isAllowlisted(patch.path)) {
      return { ok: false, reason: `patch targets non-allowlisted file: ${patch.path}` }
    }
  }
  // diff-locality: every patched file must be declared in the manifest
  const declared = new Set(candidate.targetFiles ?? candidate.patches.map((p) => p.path))
  for (const patch of candidate.patches) {
    if (!declared.has(patch.path)) {
      return { ok: false, reason: `patch touches ${patch.path} not listed in manifest.targetFiles (non-local effect)` }
    }
  }
  return { ok: true }
}

/** Apply a candidate's patches to `repoRoot`, snapshotting originals for
 *  revert(). Caller must have already validateCandidate()'d it. */
export function applyCandidate(candidate, repoRoot) {
  const snapshot = []
  for (const patch of candidate.patches) {
    const abs = join(repoRoot, patch.path)
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    snapshot.push({ path: patch.path, before })
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, patch.newContent, 'utf8')
  }
  return snapshot
}

export function revertCandidate(snapshot, repoRoot) {
  for (const { path, before } of snapshot) {
    const abs = join(repoRoot, path)
    if (before === null) continue // candidate created a new file; leaving it is harmless on a scratch worktree, but remove if present
    writeFileSync(abs, before, 'utf8')
  }
}

/** Static string-presence smoke checks declared by the candidate itself —
 *  e.g. "output-contract section markers survive the edit". */
export function runSmokeChecks(candidate, repoRoot) {
  const failures = []
  for (const check of candidate.smokeChecks ?? []) {
    const abs = join(repoRoot, check.path)
    if (!existsSync(abs)) {
      failures.push(`${check.path}: file missing after patch`)
      continue
    }
    const content = readFileSync(abs, 'utf8')
    for (const needle of check.mustContain ?? []) {
      if (!content.includes(needle)) {
        failures.push(`${check.path}: missing required substring "${needle.slice(0, 60)}"`)
      }
    }
  }
  return failures
}

export function relPathIn(repoRoot, absPath) {
  return relative(repoRoot, absPath)
}
