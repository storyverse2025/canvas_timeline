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
 */

import type { StateStorage } from 'zustand/middleware'

const DB_NAME = 'canvas-timeline-store'
const STORE = 'kv'
const VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
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
  })
  return dbPromise
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB()
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const s = t.objectStore(STORE)
    const req = fn(s)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IDB tx failed'))
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
  } catch {
    // Best effort; if the migration fails, persist will still work going
    // forward — only the carry-over of legacy state is lost.
  }
}

export function createIdbStorage(name: string): StateStorage {
  // Kick off migration eagerly so the first hydration call sees the carried
  // value if any. The Zustand persist hydration is async, so a fire-and-forget
  // here is safe — getItem awaits the same dbPromise.
  void migrateFromLocalStorageOnce(name)

  return {
    getItem: async (key) => {
      const v = await tx<unknown>('readonly', (s) => s.get(key))
      return typeof v === 'string' ? v : null
    },
    setItem: async (key, value) => {
      await tx('readwrite', (s) => s.put(value, key))
    },
    removeItem: async (key) => {
      await tx('readwrite', (s) => s.delete(key))
    },
  }
}
