import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const bridgePath = path.join(repoRoot, 'claude-bridge.mjs')

describe('Hermes bridge Codex fallback', () => {
  const bridge = () => readFileSync(bridgePath, 'utf8')

  it('uses hermes chat in quiet single-query mode as the primary assistant bridge', () => {
    const source = bridge()

    expect(source).toContain('const HERMES_BIN =')
    // Quiet single-query mode with a hard turn cap + source tag (the old
    // bare `chat -p` form was replaced when the bridge moved to -Q/-q).
    expect(source).toContain("['chat', '-Q', '-q', prompt, '--max-turns', '30', '--source', 'director-bridge']")
    expect(source).toContain('spawn(HERMES_BIN')
    expect(source).not.toContain('CLAUDE_BIN')
    expect(source).not.toContain('--dangerously-skip-permissions')
    expect(source).not.toContain('--output-format')
  })

  it('defines a Codex CLI fallback that runs from the project repo without auto-edit flags', () => {
    const source = bridge()

    expect(source).toContain('const CODEX_BIN =')
    expect(source).toContain('function buildCodexPrompt')
    expect(source).toContain('function runCodexFallback')
    expect(source).toContain('spawn(CODEX_BIN')
    expect(source).toContain("'exec'")
    expect(source).toContain('cwd: PROJECT_ROOT')
    expect(source).not.toContain("'--full-auto'")
    expect(source).not.toContain("'--yolo'")
  })

  it('falls back to Codex when Hermes spawn or non-zero exit fails instead of returning an empty/500 response', () => {
    const source = bridge()

    expect(source).toContain('handleHermesFailure')
    expect(source).toMatch(/child\.on\('error',[\s\S]*handleHermesFailure/)
    expect(source).toMatch(/child\.on\('close',\s*code[\s\S]*code !== 0[\s\S]*handleHermesFailure/)
    expect(source).not.toMatch(/child\.on\('error',[\s\S]*writeHead\(500[\s\S]*err\.message/)
  })

  it('wraps Codex fallback output in Anthropic-compatible streaming SSE and non-streaming JSON', () => {
    const source = bridge()

    expect(source).toContain('sendCodexSseResponse')
    expect(source).toContain('content_block_start')
    expect(source).toContain('content_block_delta')
    expect(source).toContain('message_stop')
    expect(source).toContain('sendCodexJsonResponse')
    expect(source).toContain("content: [{ type: 'text', text }]")
    expect(source).toContain("model: 'codex-cli-fallback'")
  })
})
