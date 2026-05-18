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
 * Pull the server snapshot if and only if IDB is empty for ALL tracked
 * stores. Designed to run BEFORE Zustand stores hydrate, so the values
 * we write to IDB get picked up by the normal hydration path.
 */
export async function tryHydrateFromServerIfIdbEmpty(): Promise<{ hydrated: boolean; savedAt: string | null }> {
  if (!hasIDB()) return { hydrated: false, savedAt: null }

  const local = await readIdbSnapshot()
  if (Object.keys(local).length > 0) {
    // Stale data wins — server backup is a fallback, not the source of truth.
    return { hydrated: false, savedAt: null }
  }

  let payload: ServerSnapshotResponse
  try {
    const res = await fetch(SERVER_URL, { method: 'GET' })
    if (!res.ok) return { hydrated: false, savedAt: null }
    payload = (await res.json()) as ServerSnapshotResponse
  } catch {
    return { hydrated: false, savedAt: null }
  }

  if (!payload.snapshot || Object.keys(payload.snapshot).length === 0) {
    return { hydrated: false, savedAt: payload.savedAt }
  }

  const db = await openIdb()
  if (!db) return { hydrated: false, savedAt: payload.savedAt }
  let any = false
  for (const [key, value] of Object.entries(payload.snapshot)) {
    if (!TRACKED_STORE_KEYS.includes(key as (typeof TRACKED_STORE_KEYS)[number])) continue
    const ok = await idbPut(db, key, value)
    if (ok) any = true
  }
  // eslint-disable-next-line no-console
  console.log(`[session-backup] restored ${Object.keys(payload.snapshot).length} store(s) from server snapshot (savedAt=${payload.savedAt}); reload to see them`)
  return { hydrated: any, savedAt: payload.savedAt }
}

const PUSH_DEBOUNCE_MS = 5_000
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null

async function pushNow(): Promise<void> {
  if (inFlight) return inFlight
  const job = (async () => {
    try {
      const snapshot = await readIdbSnapshot()
      if (Object.keys(snapshot).length === 0) return
      await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot }),
        // Use keepalive so the request survives a unload/visibilitychange
        // transition (browser usually buffers + sends after the tab dies).
        keepalive: true,
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
      if (document.visibilityState === 'hidden') void pushNow()
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
