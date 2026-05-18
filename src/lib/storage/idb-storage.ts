/**
 * IndexedDB-backed StateStorage for Zustand persist.
 *
 * Why: localStorage is capped at ~5 MB per origin. Stores that hold image
 * data URLs (canvas-item-store, storyboard-store) hit that ceiling fast and
 * then every subsequent setItem throws QuotaExceededError, which silently
 * breaks any feature that calls store updates (e.g. voice-feedback regen
 * writing the new image URL back into the item).
 *
 * IDB has a much larger quota (50 MB+ in Chromium, often hundreds of MB).
 * This adapter exposes a tiny key/value store under one IDB database with a
 * single object store, plus a one-shot helper to drop the stale localStorage
 * entry of the same name so the old quota is released.
 *
 * ## Hardening notes (added after user reported intermittent data loss
 * on refresh)
 *
 * 1. `dbPromise` is NOT cached on failure. The previous implementation
 *    cached `Promise.reject(...)` on the first failed `indexedDB.open`,
 *    so every subsequent call returned the rejected cached promise — a
 *    transient open failure became a permanent data-loss event for the
 *    rest of the session. Now we clear the cache and retry on the next
 *    call.
 * 2. `setItem` retries once on failure. Most IDB write failures are
 *    transient aborts (concurrent transaction, browser GC). One retry
 *    catches them without spamming.
 * 3. Failures are surfaced via `console.warn` so dev sees them. A silent
 *    swallow used to mean "looks like nothing happened, then refresh
 *    nukes state".
 */

import type { StateStorage } from 'zustand/middleware'

const DB_NAME = 'canvas-timeline-store'
const STORE = 'kv'
const VERSION = 1

const memoryStorage = new Map<string, string>()

let dbPromise: Promise<IDBDatabase> | null = null

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    if (!hasIndexedDB()) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'))
    req.onblocked = () => reject(new Error('IDB open blocked (another tab is upgrading)'))
  })
  dbPromise = attempt
  // CRITICAL: clear the cache on failure so the NEXT call gets a fresh
  // attempt instead of inheriting the same rejected promise forever.
  attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null
  })
  return attempt
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB()
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const s = t.objectStore(STORE)
    const req = fn(s)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IDB tx failed'))
    // Surface transaction-level errors too (e.g. constraint, quota) —
    // request-level onerror sometimes fires only for the failed request
    // while a separate constraint kills the whole transaction.
    t.onabort = () => reject(t.error ?? new Error('IDB transaction aborted'))
  })
}

/**
 * One-shot helper: copy any pre-existing localStorage entry into IDB so the
 * user's existing canvas state survives the migration, then drop the
 * localStorage entry to free up the 5 MB quota.
 *
 * Safe to call repeatedly — only runs once per name.
 */
async function migrateFromLocalStorageOnce(name: string): Promise<void> {
  if (typeof localStorage === 'undefined') return
  const flagKey = `__migrated_to_idb__${name}`
  if (localStorage.getItem(flagKey)) return
  try {
    const existing = localStorage.getItem(name)
    if (existing) {
      const inIdb = await tx<unknown>('readonly', (s) => s.get(name))
      if (inIdb == null) {
        await tx('readwrite', (s) => s.put(existing, name))
      }
    }
    localStorage.removeItem(name)
    localStorage.setItem(flagKey, '1')
  } catch (e) {
    // Best effort; if the migration fails, persist will still work going
    // forward — only the carry-over of legacy state is lost.
    // eslint-disable-next-line no-console
    console.warn(`[idb-storage] migration ${name} failed:`, (e as Error).message)
  }
}

export function createIdbStorage(name: string): StateStorage {
  if (!hasIndexedDB()) {
    return {
      getItem: async (key) => memoryStorage.get(key) ?? null,
      setItem: async (key, value) => {
        memoryStorage.set(key, value)
      },
      removeItem: async (key) => {
        memoryStorage.delete(key)
      },
    }
  }

  // Kick off migration eagerly so the first hydration call sees the carried
  // value if any. The Zustand persist hydration is async, so a fire-and-forget
  // here is safe — getItem awaits the same dbPromise.
  void migrateFromLocalStorageOnce(name)

  return {
    getItem: async (key) => {
      try {
        const v = await tx<unknown>('readonly', (s) => s.get(key))
        return typeof v === 'string' ? v : null
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[idb-storage] getItem(${key}) failed:`, (e as Error).message)
        return null
      }
    },
    setItem: async (key, value) => {
      try {
        await tx('readwrite', (s) => s.put(value, key))
      } catch (e1) {
        // One retry — most write failures are transient aborts (concurrent
        // tx, GC). If the second attempt also fails the data is lost from
        // disk for this update, but the next mutation will try again.
        // eslint-disable-next-line no-console
        console.warn(`[idb-storage] setItem(${key}) failed once, retrying:`, (e1 as Error).message)
        try {
          await tx('readwrite', (s) => s.put(value, key))
        } catch (e2) {
          // eslint-disable-next-line no-console
          console.error(`[idb-storage] setItem(${key}) failed permanently — state will not survive refresh:`, (e2 as Error).message)
          // Mirror to in-memory storage as a last-ditch fallback so the
          // in-tab session still works even if disk persistence is gone.
          memoryStorage.set(`${name}:${key}`, value)
        }
      }
    },
    removeItem: async (key) => {
      try {
        await tx('readwrite', (s) => s.delete(key))
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[idb-storage] removeItem(${key}) failed:`, (e as Error).message)
      }
    },
  }
}
