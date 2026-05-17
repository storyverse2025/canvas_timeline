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

// ── logging ───────────────────────────────────────────────────────────────────
// Every HTTP request gets a short monotonically-increasing id so concurrent
// runs are decipherable in the log stream. Prefix every line with that id —
// including hermes/codex stderr — so you can grep one request end-to-end.

let nextReqSeq = 0
function makeReqId() { return (++nextReqSeq).toString(36).padStart(4, '0') }
function previewText(s, n = 200) {
  if (!s) return ''
  const oneline = String(s).replace(/\s+/g, ' ').trim()
  return oneline.length > n ? `${oneline.slice(0, n)}…(+${oneline.length - n}c)` : oneline
}
function blog(reqId, ...args)  { console.log(`[bridge req=${reqId}]`, ...args) }
function bwarn(reqId, ...args) { console.warn(`[bridge req=${reqId}]`, ...args) }
function berr(reqId, ...args)  { console.error(`[bridge req=${reqId}]`, ...args) }

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

function runCodexFallback(prompt, reqId = '----') {
  return new Promise((resolve, reject) => {
    const codexPrompt = buildCodexPrompt(prompt)
    const startedAt = Date.now()
    blog(reqId, `→ codex exec | promptBytes=${codexPrompt.length} timeoutMs=${CODEX_TIMEOUT_MS}`)
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
      const elapsed = Date.now() - startedAt
      berr(reqId, `✗ codex TIMEOUT after ${elapsed}ms`)
      reject(new Error(`Codex fallback timed out after ${CODEX_TIMEOUT_MS}ms`))
    }, CODEX_TIMEOUT_MS)

    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      for (const line of text.split('\n').filter(Boolean)) {
        process.stderr.write(`[bridge req=${reqId}] codex.stderr: ${line}\n`)
      }
    })
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const elapsed = Date.now() - startedAt
      berr(reqId, `✗ codex spawn error after ${elapsed}ms: ${err.message}`)
      reject(err)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const elapsed = Date.now() - startedAt
      const text = stdout.trim()
      if (code === 0 && text) {
        blog(reqId, `✓ codex exit=0 bytes=${text.length} elapsed=${elapsed}ms`)
        resolve(text)
      } else {
        berr(reqId, `✗ codex exit=${code} elapsed=${elapsed}ms stderr=${previewText(stderr, 200) || 'empty'}`)
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

async function handleHermesFailure({ res, prompt, stream, reason, finalize, reqId = '----' }) {
  bwarn(reqId, `Hermes unavailable; trying Codex fallback. reason="${previewText(reason, 200)}"`)
  try {
    const text = await runCodexFallback(prompt, reqId)
    if (stream) {
      sendCodexSseResponse(res, text, finalize)
      blog(reqId, `← stream done via codex bytes=${text.length}`)
    } else if (!res.headersSent) {
      sendCodexJsonResponse(res, text)
      blog(reqId, `← 200 via codex bytes=${text.length}`)
    }
  } catch (err) {
    berr(reqId, `Codex fallback failed: ${err.message}`)
    sendBridgeError(res, 'Hermes is unavailable and Codex fallback failed.', stream, finalize)
    blog(reqId, `← 502 (hermes + codex both failed)`)
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

  const reqId = makeReqId()
  const requestStartedAt = Date.now()

  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    let reqBody
    try {
      reqBody = JSON.parse(body)
    } catch {
      berr(reqId, `← 400 invalid JSON body (${body.length} bytes received)`)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }))
      return
    }

    const { messages = [], system, stream, model } = reqBody
    const prompt = buildPrompt(messages, system)

    const args = ['chat', '-Q', '-q', prompt, '--max-turns', '30', '--source', 'director-bridge']

    const env = {
      ...process.env,
      // Provide LIBTV key; use hardcoded fallback if not in environment
      LIBTV_ACCESS_KEY: process.env.LIBTV_ACCESS_KEY || 'sk-libtv-f60919a34eac47a18cb5424ea3519d7d',
    }

    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const userPreview = previewText(extractText(lastUser?.content), 160)
    const roleSeq = messages.map(m => (m.role === 'user' ? 'u' : m.role === 'assistant' ? 'a' : '?')).join('')
    blog(reqId, `→ POST ${req.url} stream=${!!stream} model=${model || '∅'} msgs=${messages.length} [${roleSeq}] systemBytes=${(system || '').length} promptBytes=${prompt.length}`)
    blog(reqId, `  lastUser: ${userPreview || '(empty)'}`)

    const child = spawn(HERMES_BIN, args, { env, cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const hermesStartedAt = Date.now()

    // ── streaming ─────────────────────────────────────────────────────────────
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      let finalized = false
      let finalText = ''   // accumulated for logging/fallback
      let firstByteAt = 0

      function finalize() {
        if (finalized) return
        finalized = true
        res.write('data: [DONE]\n\n')
        res.end()
      }

      child.stdout.on('data', chunk => {
        const text = chunk.toString()
        if (!firstByteAt) {
          firstByteAt = Date.now()
          blog(reqId, `  hermes first stdout byte after ${firstByteAt - hermesStartedAt}ms`)
        }
        finalText += text
        writeSse(res, {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        })
      })

      let stderrText = ''
      child.stderr.on('data', d => {
        const text = d.toString()
        stderrText += text
        for (const line of text.split('\n').filter(Boolean)) {
          process.stderr.write(`[bridge req=${reqId}] hermes.stderr: ${line}\n`)
        }
      })
      child.on('close', code => {
        if (finalized) return
        const elapsedHermes = Date.now() - hermesStartedAt
        const elapsedTotal = Date.now() - requestStartedAt
        if (code !== 0 && !finalText.trim()) {
          berr(reqId, `✗ hermes exit=${code} elapsed=${elapsedHermes}ms empty stdout → fallback`)
          handleHermesFailure({ res, prompt, stream: true, reason: stderrText.trim() || `exit ${code}`, finalize, reqId })
          return
        }
        blog(reqId, `✓ hermes exit=${code} bytes=${finalText.length} elapsedHermes=${elapsedHermes}ms elapsedTotal=${elapsedTotal}ms`)
        blog(reqId, `  reply: ${previewText(finalText, 160) || '(empty)'}`)
        finalize()
      })
      child.on('error', err => {
        const elapsedHermes = Date.now() - hermesStartedAt
        berr(reqId, `✗ hermes spawn error after ${elapsedHermes}ms: ${err.message} → fallback`)
        handleHermesFailure({ res, prompt, stream: true, reason: err.message, finalize, reqId })
      })
      // Kill child only when the TCP socket closes (client truly disconnected),
      // NOT on req 'close' which fires when the request body is received.
      req.socket?.on('close', () => {
        if (!finalized) {
          bwarn(reqId, `✂ client disconnected; killing hermes child mid-stream after ${Date.now() - hermesStartedAt}ms`)
          child.kill()
          finalize()
        }
      })

    // ── non-streaming ─────────────────────────────────────────────────────────
    } else {
      let finalText = ''

      child.stdout.on('data', chunk => {
        finalText += chunk.toString()
      })

      let stderrText = ''
      child.stderr.on('data', d => {
        const text = d.toString()
        stderrText += text
        for (const line of text.split('\n').filter(Boolean)) {
          process.stderr.write(`[bridge req=${reqId}] hermes.stderr: ${line}\n`)
        }
      })

      child.on('close', code => {
        const elapsedHermes = Date.now() - hermesStartedAt
        const elapsedTotal = Date.now() - requestStartedAt
        if (code !== 0 || !finalText.trim()) {
          berr(reqId, `✗ hermes exit=${code} bytes=${finalText.length} elapsed=${elapsedHermes}ms → fallback`)
          handleHermesFailure({ res, prompt, stream: false, reason: stderrText.trim() || `exit ${code}`, finalize: () => {}, reqId })
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
        blog(reqId, `✓ hermes exit=0 bytes=${finalText.length} elapsedHermes=${elapsedHermes}ms elapsedTotal=${elapsedTotal}ms ← 200`)
        blog(reqId, `  reply: ${previewText(finalText, 160) || '(empty)'}`)
      })

      child.on('error', err => {
        const elapsedHermes = Date.now() - hermesStartedAt
        berr(reqId, `✗ hermes spawn error after ${elapsedHermes}ms: ${err.message} → fallback`)
        handleHermesFailure({ res, prompt, stream: false, reason: err.message, finalize: () => {}, reqId })
      })
    }
  })

  req.on('error', err => { berr(reqId, `request error: ${err.message}`) })
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
