/**
 * Spawn `hermes chat -Q -q` against an agent's SKILL.md body for design-time
 * invocation. Node-only — do not import from browser bundles.
 *
 * Use cases:
 *   - CLI scripts that want to run an agent end-to-end without the React app.
 *   - Integration tests that exercise the real hermes pipeline.
 *
 * For the common case of "just open an agent in a hermes chat", users should
 * shell out directly:
 *     hermes chat -p src/lib/agents/script-agent/SKILL.md
 * No TS helper needed.
 */

export interface HermesRunOptions {
  /** The agent's system prompt (SKILL.md body, frontmatter already stripped). */
  systemPrompt: string
  /** The user's initial request. */
  userPrompt: string
  /** Max conversational turns. Default 30 (matches claude-bridge.mjs). */
  maxTurns?: number
  /** Override the hermes binary path. */
  hermesBin?: string
  /** Working directory for the spawn. */
  cwd?: string
  /** Extra env vars (e.g. LIBTV_ACCESS_KEY). */
  env?: NodeJS.ProcessEnv
  /** Cancellation. */
  signal?: AbortSignal
}

export interface HermesRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Spawn hermes and capture stdout. Returns once hermes exits.
 *
 * Implementation lives behind a dynamic import so this file stays
 * tree-shakeable out of the browser bundle.
 */
export async function runHermes(opts: HermesRunOptions): Promise<HermesRunResult> {
  const { spawn } = await import('node:child_process')

  const combinedPrompt = opts.systemPrompt.trim()
    ? `${opts.systemPrompt.trim()}\n\n---\n\n${opts.userPrompt}`
    : opts.userPrompt

  const args = [
    'chat',
    '-Q',
    '-q',
    combinedPrompt,
    '--max-turns',
    String(opts.maxTurns ?? 30),
    '--source',
    'agent-runner',
  ]

  return new Promise<HermesRunResult>((resolve, reject) => {
    const child = spawn(opts.hermesBin ?? 'hermes', args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    const onAbort = () => {
      child.kill('SIGTERM')
    }
    opts.signal?.addEventListener('abort', onAbort)

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}
