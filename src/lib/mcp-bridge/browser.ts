/**
 * Browser-side WS bridge to canvas-mcp-server.mjs.
 *
 * On startup (see startMcpBridge) we open a WebSocket to
 * ws://localhost:3002 — the same port canvas-mcp-server.mjs listens on.
 * Every incoming message is a `{id, method, params}` RPC; we dispatch
 * through the pure layer in ./dispatch.ts and send back `{id, result}`
 * or `{id, error}`.
 *
 * Reconnect policy: exponential backoff up to 30s. The MCP client
 * (Claude Code) reports a friendly error on its end when no browser is
 * attached, so a slow reconnect isn't fatal.
 *
 * Disable with `?canvasMcp=0` in the URL or `VITE_CANVAS_MCP=0` at
 * build time. Useful for local dev sessions where you don't want
 * something else binding the port or where the MCP server isn't running.
 */

import { dispatch } from './dispatch';

const DEFAULT_URL = 'ws://localhost:3002';
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export interface BridgeStatus {
  state: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'disabled';
  url: string;
  /** Last error message, if any. */
  error?: string;
}

let socket: WebSocket | null = null;
let backoff = INITIAL_BACKOFF_MS;
let status: BridgeStatus = { state: 'idle', url: DEFAULT_URL };
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(s: BridgeStatus) => void>();

function setStatus(next: BridgeStatus) {
  status = next;
  for (const l of listeners) {
    try { l(next); } catch { /* listener throws don't break the bridge */ }
  }
}

export function getBridgeStatus(): BridgeStatus {
  return status;
}

export function onBridgeStatus(cb: (s: BridgeStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function shouldDisable(): boolean {
  // VITE_CANVAS_MCP=0 at build time → no bridge.
  // ?canvasMcp=0 at runtime → no bridge for this tab.
  if (import.meta.env.VITE_CANVAS_MCP === '0') return true;
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('canvasMcp') === '0') return true;
  }
  return false;
}

async function handleMessage(raw: string): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  let msg: { id?: string; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    // Malformed frame — drop silently. The server side has the same
    // policy; a bad frame on either end shouldn't kill the connection.
    console.warn('[canvas-mcp] malformed WS frame:', (e as Error).message);
    return;
  }
  if (!msg || typeof msg.id !== 'string' || typeof msg.method !== 'string') return;

  try {
    const result = await dispatch(msg.method, msg.params ?? {});
    socket.send(JSON.stringify({ id: msg.id, result }));
  } catch (e) {
    socket.send(JSON.stringify({ id: msg.id, error: (e as Error).message ?? String(e) }));
  }
}

function scheduleReconnect(url: string) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    connect(url);
  }, backoff);
  setStatus({ state: 'reconnecting', url, error: status.error });
}

function connect(url: string) {
  setStatus({ state: 'connecting', url });
  try {
    socket = new WebSocket(url);
  } catch (e) {
    setStatus({ state: 'reconnecting', url, error: (e as Error).message });
    scheduleReconnect(url);
    return;
  }
  socket.addEventListener('open', () => {
    backoff = INITIAL_BACKOFF_MS;
    setStatus({ state: 'open', url });
    // eslint-disable-next-line no-console
    console.info('[canvas-mcp] bridge connected to', url);
  });
  socket.addEventListener('message', (ev) => { void handleMessage(String(ev.data)); });
  socket.addEventListener('close', () => {
    socket = null;
    setStatus({ state: 'reconnecting', url, error: status.error });
    scheduleReconnect(url);
  });
  socket.addEventListener('error', (ev) => {
    // The 'error' event precedes 'close'; just record the message and
    // let 'close' drive the reconnect.
    const message = (ev as ErrorEvent).message || 'unknown ws error';
    setStatus({ ...status, error: message });
  });
}

/**
 * Start the bridge. Idempotent; calling twice is a no-op. Safe to call
 * from React's mount path. Returns the current status synchronously.
 */
export function startMcpBridge(url: string = DEFAULT_URL): BridgeStatus {
  if (shouldDisable()) {
    setStatus({ state: 'disabled', url });
    return status;
  }
  if (status.state === 'open' || status.state === 'connecting') return status;
  connect(url);
  return status;
}

/**
 * Stop the bridge and clear reconnect timers. Mostly for tests + the
 * (future) UI toggle.
 */
export function stopMcpBridge(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try { socket.close(); } catch { /* already closing */ }
    socket = null;
  }
  setStatus({ state: 'idle', url: status.url });
}
