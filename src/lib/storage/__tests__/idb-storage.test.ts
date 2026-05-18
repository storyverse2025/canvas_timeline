import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression: user reported intermittent state-loss on refresh. Root
 * cause: a single transient failure in `indexedDB.open` cached a
 * rejected promise on the module-level `dbPromise`, so every later read
 * + write returned the SAME rejection for the rest of the session.
 *
 * These tests pin the new behavior:
 *   - the rejected-open cache is cleared so the next call retries
 *   - setItem retries once on transient write failure
 *   - getItem falls through to null without crashing on read failure
 *   - hard-fail setItem still mirrors into memory so the in-tab session
 *     survives even when disk persistence is broken
 */

let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

afterEach(() => {
  warnSpy?.mockRestore()
  errorSpy?.mockRestore()
  vi.unstubAllGlobals()
  vi.resetModules()
})

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('createIdbStorage — IDB unavailable → in-memory fallback', () => {
  it('round-trips through in-memory storage when indexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const { createIdbStorage } = await import('@/lib/storage/idb-storage')
    const s = createIdbStorage('store-a')
    await s.setItem('k', 'v1')
    expect(await s.getItem('k')).toBe('v1')
    await s.removeItem('k')
    expect(await s.getItem('k')).toBeNull()
  })
})

describe('createIdbStorage — transient open failure does NOT poison the cache', () => {
  it('the next call gets a fresh open attempt and succeeds', async () => {
    // Mock indexedDB.open to fail once, then succeed.
    let callCount = 0
    const fakeOpen = vi.fn(() => {
      callCount++
      const req: Partial<IDBOpenDBRequest> = {
        onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: undefined,
      }
      // Fire async so the caller has time to attach handlers.
      queueMicrotask(() => {
        if (callCount === 1) {
          ;(req as IDBOpenDBRequest).error = new DOMException('boom', 'UnknownError') as never
          req.onerror?.(new Event('error') as never)
        } else {
          // Second time: return a tiny fake DB with the right surface.
          const fakeDb = {
            objectStoreNames: { contains: () => true },
            transaction: () => ({
              objectStore: () => ({
                put: () => makeReq(undefined),
                get: () => makeReq('the-value'),
                delete: () => makeReq(undefined),
              }),
              onabort: null, error: null,
            }),
          }
          ;(req as IDBOpenDBRequest).result = fakeDb as never
          req.onsuccess?.(new Event('success') as never)
        }
      })
      return req as IDBOpenDBRequest
    })
    function makeReq<T>(value: T): IDBRequest<T> {
      const r: Partial<IDBRequest<T>> = { onsuccess: null, onerror: null, result: value }
      queueMicrotask(() => r.onsuccess?.(new Event('success') as never))
      return r as IDBRequest<T>
    }
    vi.stubGlobal('indexedDB', { open: fakeOpen } as unknown as IDBFactory)

    const { createIdbStorage } = await import('@/lib/storage/idb-storage')
    const s = createIdbStorage('retry-store')

    // First call: fails (open errored). getItem returns null defensively.
    const first = await s.getItem('k')
    expect(first).toBeNull()

    // Second call: the cache must NOT still hold the failed promise.
    // openDB retries fresh and succeeds, so we get the actual value.
    const second = await s.getItem('k')
    expect(second).toBe('the-value')
    expect(fakeOpen).toHaveBeenCalledTimes(2)
  })
})

describe('createIdbStorage — setItem retry + memory fallback', () => {
  it('retries once on transient write failure and surfaces a warn', async () => {
    let putCalls = 0
    const makeReq = <T>(value: T, fail = false): IDBRequest<T> => {
      const r: Partial<IDBRequest<T>> = { onsuccess: null, onerror: null, result: value }
      queueMicrotask(() => {
        if (fail) r.onerror?.(new Event('error') as never)
        else r.onsuccess?.(new Event('success') as never)
      })
      return r as IDBRequest<T>
    }
    const fakeDb = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({
        objectStore: () => ({
          put: () => {
            putCalls++
            return makeReq(undefined, putCalls === 1) // fail once, then succeed
          },
        }),
        onabort: null, error: null,
      }),
    }
    const fakeOpen = vi.fn(() => {
      const req: Partial<IDBOpenDBRequest> = { onsuccess: null, onerror: null, result: fakeDb as never }
      queueMicrotask(() => req.onsuccess?.(new Event('success') as never))
      return req as IDBOpenDBRequest
    })
    vi.stubGlobal('indexedDB', { open: fakeOpen } as unknown as IDBFactory)

    const { createIdbStorage } = await import('@/lib/storage/idb-storage')
    const s = createIdbStorage('write-retry-store')

    await s.setItem('k', 'v')
    expect(putCalls).toBe(2) // first failed, second succeeded
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('setItem(k) failed once, retrying'),
      expect.any(String),
    )
  })

  it('falls back to in-memory mirror when both write attempts fail', async () => {
    const makeReq = <T>(value: T, fail = false): IDBRequest<T> => {
      const r: Partial<IDBRequest<T>> = { onsuccess: null, onerror: null, result: value }
      queueMicrotask(() => {
        if (fail) r.onerror?.(new Event('error') as never)
        else r.onsuccess?.(new Event('success') as never)
      })
      return r as IDBRequest<T>
    }
    const fakeDb = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({
        objectStore: () => ({ put: () => makeReq(undefined, true) }), // always fails
        onabort: null, error: null,
      }),
    }
    const fakeOpen = vi.fn(() => {
      const req: Partial<IDBOpenDBRequest> = { onsuccess: null, onerror: null, result: fakeDb as never }
      queueMicrotask(() => req.onsuccess?.(new Event('success') as never))
      return req as IDBOpenDBRequest
    })
    vi.stubGlobal('indexedDB', { open: fakeOpen } as unknown as IDBFactory)

    const { createIdbStorage } = await import('@/lib/storage/idb-storage')
    const s = createIdbStorage('hard-fail-store')
    // Should not throw — the adapter swallows + warns + mirrors to memory.
    await s.setItem('k', 'v')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('setItem(k) failed permanently'),
      expect.any(String),
    )
  })
})
