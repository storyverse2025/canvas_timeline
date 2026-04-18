#!/usr/bin/env node
/**
 * claude-bridge.mjs
 *
 * Local HTTP bridge: accepts POST /v1/messages in Anthropic API format,
 * spawns `claude --dangerously-skip-permissions --output-format stream-json`,
 * and converts the stream-json output back into Anthropic SSE format.
 *
 * Key observation: claude CLI with --output-format stream-json --verbose emits
 * {"type":"stream_event","event":{...}} lines whose inner "event" objects are
 * already valid Anthropic API events (message_start, content_block_delta, etc.).
 * We simply forward those inner events as SSE data lines.
 *
 * Skills loaded:
 *   ~/repos/storyverse-skills   (sv-pipeline, sv-intake, etc.)
 *   ~/repos/libtv-skills        (LibTV image/video generation)
 *   ~/repos/fal-skills/skills/claude.ai  (FAL.ai generation)
 */

import http from 'http'
import { spawn } from 'child_process'
import { homedir } from 'os'
import path from 'path'
import { existsSync } from 'fs'

const PORT = 3001
const HOME = homedir()
const CLAUDE_BIN = path.join(HOME, '.local/bin/claude')

const CANDIDATE_PLUGIN_DIRS = [
  path.join(HOME, 'repos/storyverse-skills'),
  path.join(HOME, 'repos/libtv-skills'),
  path.join(HOME, 'repos/fal-skills/skills/claude.ai'),
]
const PLUGIN_DIRS = CANDIDATE_PLUGIN_DIRS.filter(d => existsSync(d))

// ── helpers ───────────────────────────────────────────────────────────────────

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text).join('')
  }
  return ''
}

/**
 * Format conversation into a Human/Assistant transcript for -p mode.
 * System prompt is prepended in a <system> block.
 */
function buildPrompt(messages, system) {
  const parts = []
  if (system) parts.push(`<system>\n${system}\n</system>\n`)

  for (const m of messages) {
    const role = m.role === 'user' ? 'Human' : 'Assistant'
    parts.push(`${role}: ${extractText(m.content)}`)
  }
  parts.push('Assistant:')
  return parts.join('\n\n')
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

// ── server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Not found' } }))
    return
  }

  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    let reqBody
    try {
      reqBody = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }))
      return
    }

    const { messages = [], system, stream } = reqBody
    const prompt = buildPrompt(messages, system)

    const args = [
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '-p', prompt,
    ]
    for (const dir of PLUGIN_DIRS) args.push('--plugin-dir', dir)

    const env = {
      ...process.env,
      // Provide LIBTV key; use hardcoded fallback if not in environment
      LIBTV_ACCESS_KEY: process.env.LIBTV_ACCESS_KEY || 'sk-libtv-f60919a34eac47a18cb5424ea3519d7d',
    }

    console.log(`[bridge] → claude | msgs=${messages.length} plugins=${PLUGIN_DIRS.length} stream=${!!stream}`)

    const child = spawn(CLAUDE_BIN, args, { env, cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'] })

    // ── streaming ─────────────────────────────────────────────────────────────
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      let stdoutBuf = ''
      let finalized = false
      let finalText = ''   // accumulated from stream_events for non-stream fallback

      function finalize() {
        if (finalized) return
        finalized = true
        res.write('data: [DONE]\n\n')
        res.end()
      }

      child.stdout.on('data', chunk => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          let ev
          try { ev = JSON.parse(line) } catch { continue }

          if (ev.type === 'stream_event' && ev.event) {
            // Forward the inner event directly — it's already Anthropic SSE format
            writeSse(res, ev.event)

            // Track text for cost/debug logging
            const inner = ev.event
            if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
              finalText += inner.delta.text
            }
          } else if (ev.type === 'result') {
            console.log(`[bridge] done | cost=$${(ev.total_cost_usd ?? 0).toFixed(4)} chars=${finalText.length}`)
            finalize()
          }
        }
      })

      child.stderr.on('data', d => process.stderr.write(`[bridge] ${d}`))
      child.on('close', () => finalize())
      child.on('error', err => {
        console.error('[bridge] spawn error:', err.message)
        if (!finalized) finalize()
      })
      // Kill child only when the TCP socket closes (client truly disconnected),
      // NOT on req 'close' which fires when the request body is received.
      req.socket?.on('close', () => { if (!finalized) { child.kill(); finalize() } })

    // ── non-streaming ─────────────────────────────────────────────────────────
    } else {
      let stdoutBuf = ''
      let finalText = ''

      child.stdout.on('data', chunk => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          let ev
          try { ev = JSON.parse(line) } catch { continue }

          // Accumulate text from content_block_delta events
          if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
            const delta = ev.event.delta
            if (delta?.type === 'text_delta') finalText += delta.text
          }
          // Also read from result.result as backup
          if (ev.type === 'result' && typeof ev.result === 'string' && !finalText) {
            finalText = ev.result
          }
        }
      })

      child.stderr.on('data', d => process.stderr.write(`[bridge] ${d}`))

      child.on('close', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: `msg_bridge_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: finalText }],
          model: 'claude-code-bridge',
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: finalText.length },
        }))
      })

      child.on('error', err => {
        console.error('[bridge] spawn error:', err.message)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: err.message } }))
        }
      })
    }
  })
})

server.listen(PORT, () => {
  console.log(`\n[bridge] Claude Code bridge → http://localhost:${PORT}`)
  console.log(`[bridge] Claude CLI:   ${CLAUDE_BIN}`)
  console.log(`[bridge] Plugin dirs (${PLUGIN_DIRS.length}/${CANDIDATE_PLUGIN_DIRS.length}):`)
  for (const d of PLUGIN_DIRS) console.log(`           ${d}`)
  console.log(`[bridge] LIBTV_ACCESS_KEY: ${process.env.LIBTV_ACCESS_KEY ? '✓ set' : '⚠ using hardcoded fallback'}`)
  console.log(`[bridge] FAL_KEY:          ${process.env.FAL_KEY ? '✓ set' : '⚠ not set'}\n`)
})
