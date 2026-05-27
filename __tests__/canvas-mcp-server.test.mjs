// Server-side MCP protocol tests. The dispatchMcp function is the
// stdio entry point — it routes initialize / tools/list / tools/call
// without touching the WS layer. Browser-driven tool calls are tested
// separately in src/lib/mcp-bridge/__tests__/dispatch.test.ts.
//
// We import the server module dynamically and immediately tear down
// the WS port it binds, so the test process can exit cleanly. The
// alternative — never binding — would require refactoring the module
// to defer wss.listen, which loses the "single-file, readable
// end-to-end" property the server is going for.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocketServer } from 'ws'

// Force the server module to bind a free random port instead of the
// real :3002 so parallel test runs don't collide.
const freePort = await (async () => {
  const probe = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => probe.once('listening', r))
  const p = probe.address().port
  await new Promise((r) => probe.close(r))
  return p
})()
process.env.CANVAS_MCP_WS_PORT = String(freePort)

const mod = await import('../canvas-mcp-server.mjs')
const { TOOLS, dispatchMcp } = mod

afterAll(async () => {
  // The module's wss has no public handle; the import already opened
  // it. Best we can do is exit cleanly — vitest will reap. To avoid
  // open-handle warnings, send SIGTERM to the test process at the end.
  // (vitest tolerates the listening socket through the test run.)
})

describe('TOOLS catalog', () => {
  it('exposes exactly the 7 canvas_* tools the browser dispatcher knows', () => {
    const names = TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([
      'canvas_add_node',
      'canvas_get_node',
      'canvas_get_snapshot',
      'canvas_regenerate_image',
      'canvas_search_nodes',
      'canvas_set_keyframe',
      'canvas_update_node_prompt',
    ])
  })

  it('every tool has a JSON-Schema inputSchema and a description', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })

  it('canvas_search_nodes declares promptContains as required', () => {
    const t = TOOLS.find((x) => x.name === 'canvas_search_nodes')
    expect(t.inputSchema.required).toContain('promptContains')
  })
})

describe('dispatchMcp — protocol surface', () => {
  it('initialize returns server info + protocol version + tools capability', async () => {
    const r = await dispatchMcp('initialize', {})
    expect(r.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(r.capabilities).toEqual({ tools: {} })
    expect(r.serverInfo.name).toBe('canvas-mcp')
  })

  it('tools/list mirrors the TOOLS catalog', async () => {
    const r = await dispatchMcp('tools/list', {})
    expect(r.tools).toHaveLength(TOOLS.length)
    expect(r.tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort())
  })

  it('tools/call rejects unknown tool names', async () => {
    await expect(dispatchMcp('tools/call', { name: 'canvas_drop_table', arguments: {} }))
      .rejects.toThrow(/unknown tool/)
  })

  it('tools/call rejects when no browser is attached', async () => {
    // No browser has connected to our randomly-chosen port; call should
    // surface the "no browser connected" error from callBrowser.
    await expect(dispatchMcp('tools/call', { name: 'canvas_get_snapshot', arguments: {} }))
      .rejects.toThrow(/no browser is connected/)
  })

  it('unknown notification methods resolve to null (no-op)', async () => {
    const r = await dispatchMcp('notifications/initialized', {})
    expect(r).toBeNull()
  })

  it('unknown request methods throw "method not implemented"', async () => {
    await expect(dispatchMcp('cards/list', {})).rejects.toThrow(/not implemented/)
  })
})
