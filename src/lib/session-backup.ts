/**
 * Per-IP server-side snapshot client — belt-and-braces for when IDB
 * loses state (laptop sleep mid-write, browser tab discard, private
 * mode, etc.). Pairs with `vite-session-snapshot-plugin.ts`.
 *
 * Two operations:
 *   - `tryHydrateFromServerIfIdbEmpty()`  — call once at app startup
 *     BEFORE Zustand stores hydrate. If IDB has no entries for any of
 *     the tracked stores, fetches the latest server snapshot and
 *     writes it into IDB so Zustand's normal hydration path picks it
 *     up. If IDB already has data, no-op (server is the fallback, not
 *     the source of truth).
 *   - `useServerBackupSync()`             — React hook. Debounce-pushes
 *     the current IDB snapshot to the server on any persisted store
 *     change. Also forces a flush when the tab becomes hidden, so
 *     "navigate away → laptop sleep → wake → refresh" still has the
 *     most recent state available server-side.
 *
 * The IDB adapter is the single source of truth in steady state; the
 * server snapshot is only consulted when IDB comes up empty.
 */

import { useEffect } from 'react'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useProjectDB } from '@/stores/project-db'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'

/**
 * Keys that must match the `name:` field passed to `createIdbStorage`
 * in each store's persist config. If any store's name changes, update
 * here too — the snapshot is keyed by this exact name.
 *
 * `timeline-store-v2` reflects the v2 migration; the legacy
 * `timeline-store` key is intentionally omitted (pre-v2 state is
 * already migrated client-side).
 */
// `chat-store` is intentionally OUT — chat history is regenerable, the
// store accumulates messages forever, and it was driving snapshot size
// past 50 MB → nginx 413. If chat ever needs cross-device sync, add it
// back with a per-message trim.
const TRACKED_STORE_KEYS = [
  'canvas-store',
  'canvas-item-store',
  'asset-store',
  'storyboard-store',
  'project-db',
  'timeline-store-v2',
  'mapping-store',
] as const

const SERVER_URL = '/local-session'
const DB_NAME = 'canvas-timeline-store'
const STORE = 'kv'

function hasIDB(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openIdb(): Promise<IDBDatabase | null> {
  if (!hasIDB()) return Promise.resolve(null)
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onupgradeneeded = () => {
      // Should already exist by the time we run, but be defensive.
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
  })
}

async function idbGet(db: IDBDatabase, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readonly')
      const r = t.objectStore(STORE).get(key)
      r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbPut(db: IDBDatabase, key: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite')
      let requestOk = false
      const r = t.objectStore(STORE).put(value, key)
      r.onsuccess = () => { requestOk = true }
      r.onerror = () => resolve(false)
      // CRITICAL: resolve on TRANSACTION commit, not request success.
      // The browser may report request success while the transaction is
      // still flushing to disk; if the page reloads in the gap, the
      // write is lost. User hit this clicking the Session picker's
      // "Load" — the reload raced the writes, IDB came up empty.
      t.oncomplete = () => resolve(requestOk)
      t.onabort = () => resolve(false)
      t.onerror = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

async function readIdbSnapshot(): Promise<Record<string, string>> {
  const db = await openIdb()
  if (!db) return {}
  const out: Record<string, string> = {}
  for (const key of TRACKED_STORE_KEYS) {
    const v = await idbGet(db, key)
    if (v != null) out[key] = v
  }
  return out
}

interface ServerSnapshotResponse {
  snapshot: Record<string, string> | null
  savedAt: string | null
}

// ─── Session picker (multi-session list + load by id) ──────────────────

export interface SessionListItem {
  id: string
  ip: string
  savedAt: string
  sizeBytes: number
  previewTitle: string
  /** Stable per-project UUID. Always present for sessions written by
   *  v5+ clients; older sessions that never went through the server-side
   *  migration may still come back without one. */
  projectId?: string
}

/**
 * Total bytes the LOCAL IDB currently holds across every tracked
 * store. Used by the Session picker to compare local vs remote before
 * a destructive Load so the user can see "you'd be replacing 50 MB of
 * work with 1 KB of empty state".
 */
export async function getLocalSnapshotBytes(): Promise<number> {
  const snapshot = await readIdbSnapshot()
  return Object.values(snapshot).reduce((s, v) => s + v.length, 0)
}

/** Fetch every session the server has on disk, sorted newest-first. */
export async function listAllSessions(): Promise<SessionListItem[]> {
  const res = await fetch(`${SERVER_URL}/list`)
  if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`)
  const data = (await res.json()) as { sessions?: SessionListItem[] }
  return data.sessions ?? []
}

/**
 * Force-load a specific session by id (the hashed-IP filename prefix).
 * Overwrites the current IDB state for every tracked store the
 * snapshot contains; reloads so Zustand picks up the new IDB contents.
 *
 * This is destructive — caller is responsible for prompting the user
 * before invoking.
 */
export async function loadSessionById(id: string): Promise<{ restoredKeys: string[]; savedAt: string | null }> {
  const res = await fetch(`${SERVER_URL}/by-id/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`load failed: HTTP ${res.status}`)
  const data = (await res.json()) as ServerSnapshotResponse
  if (!data.snapshot) throw new Error('session has no snapshot data')
  const db = await openIdb()
  if (!db) throw new Error('IndexedDB unavailable')
  const restored: string[] = []
  for (const [key, value] of Object.entries(data.snapshot)) {
    if (typeof value !== 'string') continue
    if (!TRACKED_STORE_KEYS.includes(key as (typeof TRACKED_STORE_KEYS)[number])) continue
    const ok = await idbPut(db, key, value)
    if (ok) restored.push(key)
  }
  // Mirror the loaded snapshot onto the CALLER's own session file with
  // x-allow-shrink:1 so the next auto-push won't get rejected by the
  // shrink-overwrite guard (the user intentionally chose a different —
  // possibly smaller — session).
  //
  // Critically: NOT awaited. For a 63 MB session this POST was the
  // dominant tail of the user-perceived "loading…" time on residential
  // uplinks — the GET pulled the snapshot in 5-10s, then this POST
  // duplicated all those bytes BACK and held the spinner another
  // minute-plus. The localStorage flag below covers the case where
  // the reload kills this request mid-flight: the next push picks up
  // the unlock regardless.
  markNextPushAllowShrink()
  void fetch(SERVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-allow-shrink': '1' },
    body: JSON.stringify({ snapshot: data.snapshot }),
  }).catch(() => { /* best-effort; the flag above is the actual contract */ })
  return { restoredKeys: restored, savedAt: data.savedAt }
}

/**
 * Per-store hydrate: for each tracked store whose IDB key is missing,
 * restore it from the server snapshot. Designed to run BEFORE Zustand
 * hydrates, so the values we write to IDB get picked up by the normal
 * hydration path.
 *
 * Previously this was all-or-nothing: if ANY store had data locally we
 * skipped the server pull entirely. Result: when (e.g.) canvas-store's
 * IDB key was lost but storyboard-store's survived, canvas stayed empty
 * forever even though the server had a good copy. The user hit this:
 * "画布不能 load，表格就没问题".
 *
 * Returns the list of restored store keys so the caller can decide
 * whether to reload (Zustand can't safely re-hydrate after its stores
 * have already initialized).
 */
export async function tryHydrateFromServerIfIdbEmpty(): Promise<{
  hydrated: boolean
  restoredKeys: string[]
  savedAt: string | null
}> {
  if (!hasIDB()) return { hydrated: false, restoredKeys: [], savedAt: null }

  const local = await readIdbSnapshot()
  // "Missing" means absent OR tiny-empty. The persisted shape from
  // Zustand is at minimum `{"state":{},"version":0}` (~25 bytes); any
  // store carrying real data is well over 100 bytes. We were burned
  // by a skipHydration regression that wiped canvas-store + project-db
  // to "" (empty string). Treating those as missing lets the server
  // snapshot restore them automatically on next load.
  const MIN_REAL_BYTES = 100
  const missing = TRACKED_STORE_KEYS.filter((k) => {
    const v = local[k]
    return v == null || v.length < MIN_REAL_BYTES
  })
  if (missing.length === 0) {
    return { hydrated: false, restoredKeys: [], savedAt: null }
  }

  let payload: ServerSnapshotResponse
  try {
    const res = await fetch(SERVER_URL, { method: 'GET' })
    if (!res.ok) return { hydrated: false, restoredKeys: [], savedAt: null }
    payload = (await res.json()) as ServerSnapshotResponse
  } catch {
    return { hydrated: false, restoredKeys: [], savedAt: null }
  }

  if (!payload.snapshot || Object.keys(payload.snapshot).length === 0) {
    return { hydrated: false, restoredKeys: [], savedAt: payload.savedAt }
  }

  const db = await openIdb()
  if (!db) return { hydrated: false, restoredKeys: [], savedAt: payload.savedAt }
  const restored: string[] = []
  for (const key of missing) {
    const value = payload.snapshot[key]
    if (typeof value !== 'string') continue
    // Skip if the server-side value is ALSO empty — otherwise we'd
    // write "" to IDB, then on next load tryHydrate sees it < 100
    // bytes again, re-fetches the empty server snapshot, infinite
    // reload loop. The store will fall back to its initial-state
    // default and Zustand persist will write that out on first set().
    if (value.length < MIN_REAL_BYTES) continue
    const ok = await idbPut(db, key, value)
    if (ok) restored.push(key)
  }
  if (restored.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[session-backup] restored ${restored.length}/${missing.length} missing store(s) from server (${restored.join(', ')}; savedAt=${payload.savedAt}); reload to see them`)
  }
  return { hydrated: restored.length > 0, restoredKeys: restored, savedAt: payload.savedAt }
}

// 30s instead of 5s — the snapshot can be 38 MB+ over the wire even
// after gzip on dense canvases. Pushing every 5 s saturated the user's
// upload bandwidth, queued every GET behind a multi-second POST, and
// made the Session picker appear to hang. 30 s captures roughly one
// idle period after a burst of edits, which is what we actually want.
const PUSH_DEBOUNCE_MS = 30_000
// Browsers cap a keepalive-flagged fetch body at 64 KB (per spec). Our
// snapshot is usually 50-500 KB once canvas + items + storyboard rows
// are populated, so keepalive: true on the debounced push rejected with
// "Failed to fetch" the moment the user actually had state worth
// saving. Use keepalive ONLY for the urgent path (tab hiding / unload),
// and even then keep an eye on size — bigger snapshots may still drop.
const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024

interface PushOpts {
  /** Tab is hiding / page is unloading — use keepalive: true so the
   *  browser buffers the request through the transition. */
  urgent?: boolean
  /** Set on legitimate shrink scenarios (post-migration, post-load) so
   *  the server's shrink-overwrite guard doesn't reject the push. */
  allowShrink?: boolean
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null

// Pause the auto-push pipeline while a Load is in flight. The Load is
// downloading the server snapshot AND will overwrite local IDB; any
// auto-push during that window:
//   - pushes the OLD local state (smaller, gets 409'd by shrink guard
//     since the server still has the big snapshot we're about to load)
//   - races the post-load IDB writes
// Both outcomes are noise. The picker calls setPushesPaused(true) at
// the start of a load and false on completion. The push code skips
// silently while paused.
let pushesPaused = false
export function setPushesPaused(paused: boolean): void {
  pushesPaused = paused
}

// Cross-reload contract for the shrink-guard unlock. loadSessionById
// used to AWAIT a 63 MB mirror upload back to the server with
// x-allow-shrink:1 just so the next auto-push wouldn't get 409'd.
// On a residential uplink that await held the "下载…" spinner for an
// extra minute (the GET + the POST were essentially duplicated). Now
// the mirror upload is fire-and-forget; this localStorage flag is
// what actually guarantees the next push carries the shrink header,
// even if the mirror request gets killed by the post-load reload.
const NEXT_PUSH_ALLOW_SHRINK_KEY = 'session-backup:next-push-allow-shrink'
export function markNextPushAllowShrink(): void {
  try { localStorage.setItem(NEXT_PUSH_ALLOW_SHRINK_KEY, '1') } catch { /* localStorage may be disabled */ }
}
function consumeAllowShrinkFlag(): boolean {
  try {
    if (localStorage.getItem(NEXT_PUSH_ALLOW_SHRINK_KEY) === '1') {
      localStorage.removeItem(NEXT_PUSH_ALLOW_SHRINK_KEY)
      return true
    }
  } catch { /* localStorage may be disabled */ }
  return false
}

/**
 * gzip-compress a JSON string using the Compression Streams API
 * (Chrome 80+, Safari 16.4+, FF 113+ — universal at this point).
 * Returns the raw gzipped Uint8Array. Throws if CompressionStream
 * is unavailable so the caller can fall back to plain text.
 */
async function gzipString(s: string): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream unavailable')
  }
  const cs = new CompressionStream('gzip')
  const blob = new Blob([s])
  const stream = blob.stream().pipeThrough(cs)
  const out = await new Response(stream).arrayBuffer()
  return new Uint8Array(out)
}

function fmtKB(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`
}

export async function pushNow(opts: PushOpts = {}): Promise<void> {
  // Pick up a deferred shrink-unlock left by loadSessionById on the
  // previous session — see comment on markNextPushAllowShrink above.
  const allowShrink = opts.allowShrink || consumeAllowShrinkFlag()
  if (pushesPaused && !allowShrink) return
  if (inFlight) return inFlight
  const job = (async () => {
    try {
      const snapshot = await readIdbSnapshot()
      if (Object.keys(snapshot).length === 0) return
      const json = JSON.stringify({ snapshot })

      // Try gzip first — typical Zustand state compresses ~10×
      // (lots of repeated JSON keys like "nodes", "edges", "position").
      // This is what keeps the body under the nginx body limit even
      // when the user has dozens of canvas items.
      let body: BodyInit
      let contentEncoding: string | null = null
      let bodyLen: number
      try {
        const gz = await gzipString(json)
        body = gz
        contentEncoding = 'gzip'
        bodyLen = gz.byteLength
      } catch {
        body = json
        bodyLen = json.length
      }

      // Per-push size log so future bloat regressions are visible
      // immediately (raw → compressed ratio). Quiet when sizes are
      // sane: log only when raw > 100 KB or compressed > 50 KB.
      if (json.length > 100 * 1024 || bodyLen > 50 * 1024) {
        const ratio = contentEncoding ? `${(json.length / bodyLen).toFixed(1)}×` : '1× (uncompressed)'
        // eslint-disable-next-line no-console
        console.log(`[session-backup] push raw=${fmtKB(json.length)} sent=${fmtKB(bodyLen)} compress=${ratio}`)
      }

      // Drop keepalive for any body that would exceed the spec limit —
      // a normal POST that misses the unload transition is better than
      // a guaranteed-rejected keepalive POST.
      const useKeepalive = !!opts.urgent && bodyLen <= KEEPALIVE_BODY_LIMIT_BYTES

      const headers: Record<string, string> = {
        'Content-Type': contentEncoding ? 'application/octet-stream' : 'application/json',
      }
      if (contentEncoding) headers['Content-Encoding'] = contentEncoding
      if (allowShrink) headers['x-allow-shrink'] = '1'
      await fetch(SERVER_URL, {
        method: 'POST',
        headers,
        body,
        ...(useKeepalive ? { keepalive: true } : {}),
      })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[session-backup] push failed:', (e as Error).message)
    } finally {
      inFlight = null
    }
  })()
  inFlight = job
  return job
}

function schedulePush(): void {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    void pushNow()
  }, PUSH_DEBOUNCE_MS)
}

/**
 * Subscribe to every tracked Zustand store; debounce-push to the server
 * on changes; force-push when the tab becomes hidden. Idempotent —
 * mounting twice (StrictMode) doesn't double the subscriptions because
 * the subscribers are cleaned up by the effect's teardown.
 */
export function useServerBackupSync(): void {
  useEffect(() => {
    // chat-store omitted on purpose — see TRACKED_STORE_KEYS for why.
    const stores = [
      useCanvasStore, useCanvasItemStore, useAssetStore, useStoryboardStore,
      useProjectDB, useTimelineStore, useMappingStore,
    ] as const
    const unsubs = stores.map((s) => s.subscribe(() => schedulePush()))

    const onHidden = () => {
      if (document.visibilityState === 'hidden') void pushNow({ urgent: true })
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('beforeunload', onHidden)

    return () => {
      for (const u of unsubs) u()
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('beforeunload', onHidden)
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    }
  }, [])
}

// Exported for tests.
export const __test = { TRACKED_STORE_KEYS, SERVER_URL, PUSH_DEBOUNCE_MS }
