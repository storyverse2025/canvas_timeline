/**
 * mcp-bridge: browser-side endpoint of the canvas-mcp protocol.
 *
 * External agents (Claude Code, Hermes, anything MCP) reach the canvas
 * through canvas-mcp-server.mjs at the repo root. That server proxies
 * tool calls over WebSocket into this module, which dispatches them to
 * canvas-api.
 *
 * Public surface:
 *   startMcpBridge()  — open the WS, start dispatching. Idempotent.
 *   stopMcpBridge()   — close + clear timers.
 *   getBridgeStatus() — synchronous status read.
 *   onBridgeStatus()  — subscribe to state transitions (idle / connecting /
 *                       open / reconnecting / disabled).
 *   dispatch()        — pure tool router (exposed for tests).
 */

export {
  startMcpBridge,
  stopMcpBridge,
  getBridgeStatus,
  onBridgeStatus,
  type BridgeStatus,
} from './browser';

export { dispatch, isKnownTool, type ToolName } from './dispatch';
