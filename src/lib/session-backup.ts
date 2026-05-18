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
import { useChatStore } from '@/stores/chat-store'
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
const TRACKED_STORE_KEYS = [
  'canvas-store',
  'canvas-item-store',
  'asset-store',
  'storyboard-store',
  'project-db',
  'timeline-store-v2',
  'chat-store',
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
      const r = t.objectStore(STORE).put(value, key)
      r.onsuccess = () => resolve(true)
      r.onerror = () => resolve(false)
      t.onabort = () => resolve(false)
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
  const missing = TRACKED_STORE_KEYS.filter((k) => !(k in local))
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
    const ok = await idbPut(db, key, value)
    if (ok) restored.push(key)
  }
  if (restored.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[session-backup] restored ${restored.length}/${missing.length} missing store(s) from server (${restored.join(', ')}; savedAt=${payload.savedAt}); reload to see them`)
  }
  return { hydrated: restored.length > 0, restoredKeys: restored, savedAt: payload.savedAt }
}

const PUSH_DEBOUNCE_MS = 5_000
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
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null

async function pushNow(opts: PushOpts = {}): Promise<void> {
  if (inFlight) return inFlight
  const job = (async () => {
    try {
      const snapshot = await readIdbSnapshot()
      if (Object.keys(snapshot).length === 0) return
      const body = JSON.stringify({ snapshot })
      // Drop keepalive for any body that would exceed the spec limit —
      // a normal POST that misses the unload transition is better than
      // a guaranteed-rejected keepalive POST.
      const useKeepalive = !!opts.urgent && body.length <= KEEPALIVE_BODY_LIMIT_BYTES
      await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    const stores = [
      useCanvasStore, useCanvasItemStore, useAssetStore, useStoryboardStore,
      useProjectDB, useTimelineStore, useChatStore, useMappingStore,
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
