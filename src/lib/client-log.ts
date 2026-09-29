/**
 * Browser → dev server log bridge.
 *
 * The canvas runs its whole generation pipeline in the browser, so when a run
 * fails the only trace used to be a toast and the user's devtools console. This
 * ships every error (console.error, uncaught exception, unhandled rejection) and
 * every explicitly logged action to `/client-log`, which prints them into the
 * dev server log next to the `[cap]` lines for the same run.
 *
 * Failure-proof by design: batched, size-capped, never throws, and never
 * recurses (a failed flush is dropped instead of logged).
 */

import { serverBaseUrl } from '@/lib/capabilities/trace'

interface Entry {
  level: 'info' | 'warn' | 'error'
  event: string
  data?: unknown
  at: number
}

const FLUSH_MS = 1000
const MAX_QUEUE = 200
const MAX_DATA_CHARS = 4000

let queue: Entry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let flushing = false
let installed = false

/** Keep data small and JSON-safe: no data URLs, no cyclic stores, no megabytes. */
function safeData(data: unknown): unknown {
  if (data === undefined) return undefined
  try {
    const json = JSON.stringify(data, (_k, v) => {
      if (typeof v === 'string') {
        if (v.startsWith('data:')) return `${v.slice(0, 24)}…(${Math.round(v.length * 0.75 / 1024)}KB)`
        return v.length > 500 ? `${v.slice(0, 500)}…` : v
      }
      if (v instanceof Error) return `${v.name}: ${v.message}`
      return v
    })
    if (json === undefined) return String(data)
    return json.length > MAX_DATA_CHARS ? `${json.slice(0, MAX_DATA_CHARS)}…` : JSON.parse(json)
  } catch {
    return String(data).slice(0, MAX_DATA_CHARS)
  }
}

function enqueue(level: Entry['level'], event: string, data?: unknown): void {
  queue.push({ level, event, data: safeData(data), at: Date.now() })
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS)
}

async function flush(): Promise<void> {
  timer = null
  if (flushing || queue.length === 0) return
  flushing = true
  const entries = queue
  queue = []
  try {
    await fetch(`${serverBaseUrl()}/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      keepalive: true,
    })
  } catch {
    // Dev server restarting / offline: drop them rather than loop forever.
  } finally {
    flushing = false
  }
}

/** Log one action (a click, a pipeline step, a result) to the server log. */
export function logAction(event: string, data?: unknown): void {
  enqueue('info', event, data)
}

export function logError(event: string, data?: unknown): void {
  enqueue('error', event, data)
}

/** Mirror console.error / console.warn, uncaught errors and rejections to the server. */
export function installClientLog(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const wrap = (level: 'warn' | 'error', original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      original(...args)
      try {
        enqueue(level, `console.${level}`, args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : a)))
      } catch { /* logging must never break the app */ }
    }
  console.error = wrap('error', console.error.bind(console))
  console.warn = wrap('warn', console.warn.bind(console))

  window.addEventListener('error', (e) => {
    enqueue('error', 'window.error', { message: e.message, source: `${e.filename}:${e.lineno}`, stack: e.error instanceof Error ? e.error.stack : undefined })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    enqueue('error', 'unhandledrejection', r instanceof Error ? `${r.name}: ${r.message}\n${r.stack ?? ''}` : r)
  })
  // Don't lose the tail of a session when the tab closes mid-run.
  window.addEventListener('pagehide', () => {
    if (queue.length === 0) return
    try {
      navigator.sendBeacon(`${serverBaseUrl()}/client-log`, new Blob([JSON.stringify({ entries: queue })], { type: 'application/json' }))
      queue = []
    } catch { /* best effort */ }
  })
  logAction('session.start', { url: location.pathname, ua: navigator.userAgent.slice(0, 120) })
}
