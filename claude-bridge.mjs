#!/usr/bin/env node
/**
 * hermes-bridge.mjs
 *
 * Local HTTP bridge: accepts POST /v1/messages in Anthropic API format,
 * spawns `hermes chat -q` in quiet single-query mode,
 * and converts plain text output back into Anthropic-compatible JSON/SSE.
 *
 * Skills/capabilities are handled by Hermes itself; this bridge no longer passes
 * Claude Code plugin dirs or stream-json flags.
 */

import './load-env.mjs'
import http from 'http'
import { spawn } from 'child_process'
import { homedir } from 'os'
import path from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'

const PORT = 3001
const HOME = homedir()
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url))
const HERMES_BIN = process.env.HERMES_BIN || 'hermes'
const CODEX_BIN = process.env.CODEX_BIN || 'codex'
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 120000)

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

function buildCodexPrompt(prompt) {
  return [
    'You are a local Codex CLI fallback for a Claude Code bridge.',
    'Claude CLI failed, so answer the original assistant request directly.',
    'Important: output only the assistant response text. Do not modify files, run commands, create commits, or include tool logs.',
    'If the request asks for code changes, explain the exact changes or provide patches in text rather than editing the repository.',
    '',
    '<original_prompt>',
    prompt,
    '</original_prompt>',
  ].join('\n')
}

function runCodexFallback(prompt) {
  return new Promise((resolve, reject) => {
    const codexPrompt = buildCodexPrompt(prompt)
    const child = spawn(CODEX_BIN, ['exec', codexPrompt], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`Codex fallback timed out after ${CODEX_TIMEOUT_MS}ms`))
    }, CODEX_TIMEOUT_MS)

    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = stdout.trim()
      if (code === 0 && text) {
        resolve(text)
      } else {
        reject(new Error(`Codex fallback failed with code ${code}: ${stderr.trim() || 'empty output'}`))
      }
    })
  })
}

function sendCodexSseResponse(res, text, finalize) {
  writeSse(res, {
    type: 'message_start',
    message: {
      id: `msg_codex_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'codex-cli-fallback',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  writeSse(res, {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })
  writeSse(res, {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })
  writeSse(res, { type: 'content_block_stop', index: 0 })
  writeSse(res, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: text.length },
  })
  writeSse(res, { type: 'message_stop' })
  finalize()
}

function sendCodexJsonResponse(res, text) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: `msg_codex_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'codex-cli-fallback',
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: text.length },
  }))
}

function sendBridgeError(res, message, stream, finalize) {
  if (stream) {
    writeSse(res, { type: 'error', error: { type: 'api_error', message } })
    finalize()
    return
  }
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message } }))
  }
}

async function handleHermesFailure({ res, prompt, stream, reason, finalize }) {
  console.warn(`[bridge] Hermes unavailable; trying Codex fallback (${reason})`)
  try {
    const text = await runCodexFallback(prompt)
    if (stream) {
      sendCodexSseResponse(res, text, finalize)
    } else if (!res.headersSent) {
      sendCodexJsonResponse(res, text)
    }
  } catch (err) {
    console.error('[bridge] Codex fallback failed:', err.message)
    sendBridgeError(res, 'Hermes is unavailable and Codex fallback failed.', stream, finalize)
  }
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

    const args = ['chat', '-Q', '-q', prompt, '--max-turns', '30', '--source', 'director-bridge']

    const env = {
      ...process.env,
      // Provide LIBTV key; use hardcoded fallback if not in environment
      LIBTV_ACCESS_KEY: process.env.LIBTV_ACCESS_KEY || 'sk-libtv-f60919a34eac47a18cb5424ea3519d7d',
    }

    console.log(`[bridge] → hermes chat -Q -q | msgs=${messages.length} plugins=${PLUGIN_DIRS.length} stream=${!!stream}`)

    const child = spawn(HERMES_BIN, args, { env, cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })

    // ── streaming ─────────────────────────────────────────────────────────────
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      let finalized = false
      let finalText = ''   // accumulated for logging/fallback

      function finalize() {
        if (finalized) return
        finalized = true
        res.write('data: [DONE]\n\n')
        res.end()
      }

      child.stdout.on('data', chunk => {
        const text = chunk.toString()
        finalText += text
        writeSse(res, {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        })
      })

      let stderrText = ''
      child.stderr.on('data', d => {
        stderrText += d.toString()
        process.stderr.write(`[bridge] ${d}`)
      })
      child.on('close', code => {
        if (finalized) return
        if (code !== 0 && !finalText.trim()) {
          handleHermesFailure({ res, prompt, stream: true, reason: stderrText.trim() || `exit ${code}`, finalize })
          return
        }
        finalize()
      })
      child.on('error', err => handleHermesFailure({ res, prompt, stream: true, reason: err.message, finalize }))
      // Kill child only when the TCP socket closes (client truly disconnected),
      // NOT on req 'close' which fires when the request body is received.
      req.socket?.on('close', () => { if (!finalized) { child.kill(); finalize() } })

    // ── non-streaming ─────────────────────────────────────────────────────────
    } else {
      let finalText = ''

      child.stdout.on('data', chunk => {
        finalText += chunk.toString()
      })

      let stderrText = ''
      child.stderr.on('data', d => {
        stderrText += d.toString()
        process.stderr.write(`[bridge] ${d}`)
      })

      child.on('close', code => {
        if (code !== 0 || !finalText.trim()) {
          handleHermesFailure({ res, prompt, stream: false, reason: stderrText.trim() || `exit ${code}`, finalize: () => {} })
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: `msg_bridge_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: finalText }],
          model: 'hermes-chat-bridge',
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: finalText.length },
        }))
      })

      child.on('error', err => handleHermesFailure({ res, prompt, stream: false, reason: err.message, finalize: () => {} }))
    }
  })
})

server.listen(PORT, () => {
  console.log(`\n[bridge] Hermes chat bridge → http://localhost:${PORT}`)
  console.log(`[bridge] Hermes CLI:   ${HERMES_BIN}`)
  console.log(`[bridge] Plugin dirs discovered but not passed to hermes (${PLUGIN_DIRS.length}/${CANDIDATE_PLUGIN_DIRS.length}):`)
  for (const d of PLUGIN_DIRS) console.log(`           ${d}`)
  console.log(`[bridge] LIBTV_ACCESS_KEY: ${process.env.LIBTV_ACCESS_KEY ? '✓ set' : '⚠ using hardcoded fallback'}`)
  console.log(`[bridge] FAL_KEY:          ${process.env.FAL_KEY ? '✓ set' : '⚠ not set'}`)
  console.log(`[bridge] TOKENROUTER_API_KEY: ${process.env.TOKENROUTER_API_KEY ? '✓ set' : '⚠ not set'}\n`)
})
