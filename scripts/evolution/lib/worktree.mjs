// Unattended-run isolation: a dedicated git worktree + its own Vite dev
// server on a separate port, so a cron-triggered evolution run never
// touches the user's live working tree or their :8080 session.
//
// Follows this repo's existing worktree convention (canvas_timeline-router,
// canvas_timeline_restore_pr): sibling directory, node_modules symlinked
// (not reinstalled), .env copied (untracked, not checked out by git).

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, symlinkSync, copyFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { healthCheck } from './llm.mjs'

const MAIN_REPO = process.cwd()
export const WORKTREE_PATH = join(dirname(MAIN_REPO), 'canvas_timeline-evolve')
export const EVOLUTION_BRANCH = 'evolution/main'

function git(args, cwd = MAIN_REPO) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

export function ensureWorktree() {
  const worktrees = git(['worktree', 'list'])
  if (worktrees.includes(WORKTREE_PATH)) return
  if (existsSync(WORKTREE_PATH)) {
    throw new Error(`${WORKTREE_PATH} exists but isn't a registered worktree — investigate before proceeding`)
  }
  const branches = git(['branch', '--list', EVOLUTION_BRANCH])
  if (branches) {
    git(['worktree', 'add', WORKTREE_PATH, EVOLUTION_BRANCH])
  } else {
    git(['worktree', 'add', WORKTREE_PATH, '-b', EVOLUTION_BRANCH])
  }
  const nm = join(WORKTREE_PATH, 'node_modules')
  if (!existsSync(nm)) symlinkSync(join(MAIN_REPO, 'node_modules'), nm)
  const envSrc = join(MAIN_REPO, '.env')
  const envDst = join(WORKTREE_PATH, '.env')
  if (existsSync(envSrc) && !existsSync(envDst)) copyFileSync(envSrc, envDst)
}

/**
 * evolution/main is a long-lived branch: the worktree persists across runs
 * and each shipped candidate commits directly onto it, so there is nothing
 * to "sync" from — the worktree IS the latest state. Bringing in upstream
 * improvements from the user's real branch (main / a feature branch) is a
 * deliberate human action (rebase/merge), not something this controller
 * does automatically — it must never silently rewrite evolution/main under
 * a running or scheduled loop.
 */
export function syncWorktree() {
  // intentionally a no-op; see docstring above
}

let serverProc = null

export async function startEvolutionServer(port) {
  // DEV_HTTPS=0 — the isolated evolution server has no browser client to
  // protect, and skipping basicSsl avoids self-signed cert rejection in
  // the Node-side health checks / bench e2e fetches.
  serverProc = spawn('npx', ['vite', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: WORKTREE_PATH,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, DEV_HTTPS: '0' },
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const logLines = []
  serverProc.stdout.on('data', (b) => logLines.push(b.toString()))
  serverProc.stderr.on('data', (b) => logLines.push(b.toString()))

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await healthCheck(baseUrl, 2000)) return { baseUrl, proc: serverProc }
    await new Promise((r) => setTimeout(r, 1000))
  }
  stopEvolutionServer()
  throw new Error(`evolution dev server on ${port} failed health check within 30s. Recent output:\n${logLines.slice(-30).join('')}`)
}

export function stopEvolutionServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM')
  }
  serverProc = null
}

export function commitInWorktree(message) {
  git(['add', '-A'], WORKTREE_PATH)
  git(['commit', '-m', message], WORKTREE_PATH)
  return git(['rev-parse', 'HEAD'], WORKTREE_PATH)
}

export function discardWorktreeChanges() {
  git(['checkout', '--', '.'], WORKTREE_PATH)
  git(['clean', '-fd', '--', 'src', 'evolution'], WORKTREE_PATH)
}
