#!/usr/bin/env node
/**
 * canvas-mcp-server.mjs
 *
 * Bridges Claude Code (or any MCP client) to the running canvas_timeline
 * browser app. The server:
 *
 *   1. Speaks MCP over stdio (JSON-RPC 2.0, line-delimited) to the parent
 *      MCP client. Implements `initialize`, `tools/list`, and `tools/call`.
 *
 *   2. Listens on ws://localhost:3002 for a *single* browser connection.
 *      The browser runs src/lib/mcp-bridge/browser.ts which connects
 *      automatically on app load.
 *
 *   3. On `tools/call`, forwards a `{id, method, params}` JSON message
 *      over the WS to the browser, which executes the canvas-api method
 *      and posts `{id, result}` or `{id, error}` back. The MCP response
 *      is returned to the client.
 *
 * Why hand-rolled (not @modelcontextprotocol/sdk):
 *   - MCP protocol surface needed here is tiny (3 methods); the SDK is
 *     a few hundred KB plus deps to audit.
 *   - This file is meant to be readable end-to-end — agents in this
 *     repo touch it whenever a new canvas-api tool is added.
 *
 * Setup (one-time per developer machine):
 *   $ claude mcp add canvas node /absolute/path/to/canvas-mcp-server.mjs
 *
 * Lifecycle:
 *   Claude Code spawns this script on demand. It exits when stdin closes
 *   (client disconnect) or on SIGTERM. The WS server tears down with it.
 */

import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'

const WS_PORT = Number(process.env.CANVAS_MCP_WS_PORT ?? 3002)
const TOOL_TIMEOUT_MS = Number(process.env.CANVAS_MCP_TOOL_TIMEOUT_MS ?? 180_000)

// ─── Logging ──────────────────────────────────────────────────────
//
// All logs go to stderr — stdout is the MCP transport and any stray
// write there corrupts the protocol stream. The MCP client surfaces
// stderr in its developer console.

const log = (...args) => process.stderr.write(`[canvas-mcp] ${args.join(' ')}\n`)

// ─── Tool catalog ─────────────────────────────────────────────────
//
// One entry per canvas-api method exposed externally. `name` is what
// the MCP client (Claude Code) sees and calls; `inputSchema` is a
// JSON-Schema describing the arguments object the client must send.
//
// The browser executor in src/lib/mcp-bridge/browser.ts has a matching
// switch keyed on the same names; adding a tool means editing both.

const TOOLS = [
  {
    name: 'canvas_get_snapshot',
    description:
      'Read a lightweight summary of the current canvas: counts, kind/role histograms, and per-row {id, shot_number, status, keyframeNodeId, beatVideoNodeId}. Use this first to orient before searching or mutating.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'canvas_search_nodes',
    description:
      'Find canvas image/text/video/audio nodes whose prompt contains any of the given terms. Terms expand through a Chinese-English synonym dictionary (revolver ↔ 左轮手枪 ↔ pistol). Filter by kinds, roles, or storyboard rowIds.',
    inputSchema: {
      type: 'object',
      properties: {
        promptContains: { type: 'array', items: { type: 'string' }, minItems: 1 },
        expandSynonyms: { type: 'boolean', description: 'Default true. Set false to match literally.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['image', 'text', 'video', 'audio'] } },
        roles: { type: 'array', items: { type: 'string' } },
        rowIds: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number', minimum: 1 },
      },
      required: ['promptContains'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_get_node',
    description:
      'Return full detail for one node by id: the underlying canvas-item (kind, name, content, prompt, refImages, versions[], ...) plus any storyboard rows that reference it.',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_add_node',
    description:
      'Create a new canvas-item and place a node on the canvas in one call. Returns the new NodeDetail.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['image', 'text', 'video', 'audio'] },
        name: { type: 'string' },
        content: { type: 'string', description: 'For image/video/audio: a URL. For text: the body.' },
        role: { type: 'string' },
        prompt: { type: 'string' },
        refImages: { type: 'array', items: { type: 'string' } },
        position: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
      },
      required: ['kind', 'name', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_update_node_prompt',
    description:
      "Replace a node's prompt. The prior prompt is snapshotted into item.versions[] (newest first) so the user can roll back. Does not regenerate the image — pair with canvas_regenerate_image if needed.",
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['nodeId', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_regenerate_image',
    description:
      "Re-run text-to-image for an image node, using its current prompt (or an override). Pushes the prior image URL + prompt to item.versions[]. Failed generation leaves state untouched. Long-running — up to ~3 minutes on busy backends.",
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        prompt: { type: 'string', description: 'Optional override. Defaults to the current item prompt.' },
        refImageUrls: { type: 'array', items: { type: 'string' } },
        aspect: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3'] },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'canvas_set_keyframe',
    description:
      "Bind a canvas image node as the keyframe of a storyboard row. Mirrors item.content into row.keyframeUrl so downstream consumers stay in sync.",
    inputSchema: {
      type: 'object',
      properties: {
        rowId: { type: 'string' },
        nodeId: { type: 'string' },
      },
      required: ['rowId', 'nodeId'],
      additionalProperties: false,
    },
  },
]

// ─── WS proxy ─────────────────────────────────────────────────────
//
// One browser at a time. Pending requests live in a Map keyed by id;
// the WS handler resolves them when a matching response arrives.

/** @type {WebSocket | null} */
let browser = null
const pending = new Map() // id → { resolve, reject, timer }

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
wss.on('listening', () => log(`WS listening on 127.0.0.1:${WS_PORT}`))
wss.on('connection', (ws) => {
  if (browser && browser.readyState === 1 /* OPEN */) {
    log('browser already connected; rejecting second client')
    ws.close(1008, 'canvas-mcp accepts only one browser client at a time')
    return
  }
  browser = ws
  log('browser connected')
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch (e) {
      log(`malformed WS frame: ${e.message}`)
      return
    }
    if (!msg || typeof msg.id !== 'string') return
    const slot = pending.get(msg.id)
    if (!slot) {
      log(`no pending handler for id=${msg.id} (timed out?)`)
      return
    }
    clearTimeout(slot.timer)
    pending.delete(msg.id)
    if (msg.error) slot.reject(new Error(msg.error))
    else slot.resolve(msg.result)
  })
  ws.on('close', () => {
    if (browser === ws) browser = null
    log('browser disconnected')
    // Fail any in-flight calls — the browser is gone and they'll
    // never resolve. The MCP client sees a tool error and can retry
    // after the browser reconnects.
    for (const [, slot] of pending) {
      clearTimeout(slot.timer)
      slot.reject(new Error('canvas-mcp: browser disconnected before tool call completed'))
    }
    pending.clear()
  })
})

/**
 * Send a `{method, params}` call to the browser and resolve with the
 * remote result. Rejects on browser disconnect, malformed reply, or
 * timeout. Tool name is forwarded as-is — the browser executor
 * dispatches it to the matching canvas-api method.
 */
function callBrowser(method, params) {
  return new Promise((resolve, reject) => {
    if (!browser || browser.readyState !== 1) {
      reject(
        new Error(
          'canvas-mcp: no browser is connected. Open the canvas_timeline app in a browser tab so the bridge can attach.',
        ),
      )
      return
    }
    const id = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`canvas-mcp: tool ${method} timed out after ${TOOL_TIMEOUT_MS}ms`))
    }, TOOL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    try {
      browser.send(JSON.stringify({ id, method, params }))
    } catch (e) {
      clearTimeout(timer)
      pending.delete(id)
      reject(e)
    }
  })
}

// ─── MCP stdio loop ───────────────────────────────────────────────
//
// JSON-RPC 2.0 messages arrive one per line on stdin. We dispatch and
// write the response (also one line) to stdout.

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  let nl
  while ((nl = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, nl).trim()
    stdinBuffer = stdinBuffer.slice(nl + 1)
    if (line) void handleMcpLine(line)
  }
})
process.stdin.on('end', () => {
  log('stdin closed; exiting')
  process.exit(0)
})
process.on('SIGTERM', () => {
  log('SIGTERM; shutting down')
  process.exit(0)
})

function writeMcp(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

async function handleMcpLine(line) {
  let req
  try {
    req = JSON.parse(line)
  } catch (e) {
    log(`bad MCP frame: ${e.message}`)
    return
  }
  const { id, method, params } = req
  try {
    const result = await dispatchMcp(method, params ?? {})
    if (id !== undefined) writeMcp({ jsonrpc: '2.0', id, result })
  } catch (e) {
    if (id !== undefined) {
      writeMcp({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message ?? e) } })
    }
  }
}

async function dispatchMcp(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'canvas-mcp', version: '0.1.0' },
      }
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const { name, arguments: args } = params
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) throw new Error(`unknown tool: ${name}`)
      const result = await callBrowser(name, args ?? {})
      // MCP tools/call response format: content[] of text blocks.
      // We pass the JSON result as a text block so the model can parse
      // it. Models routinely consume JSON-stringified tool output.
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    }
    // Methods we don't implement — silently accept notifications,
    // throw "method not found" for requests. MCP spec uses -32601.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    default:
      throw Object.assign(new Error(`method not implemented: ${method}`), { code: -32601 })
  }
}

// Exported for unit tests that import this file as ESM. Side-effectful
// imports of this module will also boot the WS server, which is fine
// in a test process — the OS releases the port on exit.
export { TOOLS, dispatchMcp, callBrowser }
