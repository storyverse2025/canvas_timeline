import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Per-IP session-backup client. Tests focus on the public contract:
 *   - tryHydrateFromServerIfIdbEmpty respects existing IDB data
 *   - tryHydrateFromServerIfIdbEmpty writes server data into IDB when
 *     IDB is empty
 *   - server hydration is a no-op when the server returns null
 *
 * The push side (useServerBackupSync) is harder to unit-test cleanly
 * because it lives in a React effect; we exercise the underlying
 * debouncer through the public exports.
 */

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function makeReq<T>(value: T, fail = false): IDBRequest<T> {
  const r: Partial<IDBRequest<T>> = { onsuccess: null, onerror: null, result: value }
  queueMicrotask(() => {
    if (fail) r.onerror?.(new Event('error') as never)
    else r.onsuccess?.(new Event('success') as never)
  })
  return r as IDBRequest<T>
}

function stubIdb(initial: Record<string, string> = {}) {
  const data = { ...initial }
  const fakeStore = {
    get: (key: string) => makeReq(key in data ? data[key] : undefined),
    put: (value: string, key: string) => { data[key] = value; return makeReq(undefined) },
    delete: (key: string) => { delete data[key]; return makeReq(undefined) },
  }
  const fakeDb = {
    objectStoreNames: { contains: () => true },
    // idbPut now waits for t.oncomplete (not just request success) so
    // the disk commit is guaranteed before reload. Mock must fire it
    // AFTER the request's onsuccess. setTimeout(0) lands in a later
    // task than the microtask queue makeReq uses, so r.onsuccess (and
    // thus the local requestOk = true flip) runs first.
    transaction: () => {
      const t: { objectStore: () => unknown; onabort: null; onerror: null; oncomplete: null | ((e: Event) => void); error: null } = {
        objectStore: () => fakeStore,
        onabort: null, onerror: null, oncomplete: null, error: null,
      }
      setTimeout(() => t.oncomplete?.(new Event('complete')), 0)
      return t
    },
  }
  const fakeOpen = vi.fn(() => {
    const req: Partial<IDBOpenDBRequest> = { onsuccess: null, onerror: null, result: fakeDb as never }
    queueMicrotask(() => req.onsuccess?.(new Event('success') as never))
    return req as IDBOpenDBRequest
  })
  vi.stubGlobal('indexedDB', { open: fakeOpen } as unknown as IDBFactory)
  return { data, fakeOpen }
}

describe('tryHydrateFromServerIfIdbEmpty', () => {
  it('no-ops when EVERY tracked store already has data in IDB (server is fallback only)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: {} }) }))
    vi.stubGlobal('fetch', fetchSpy)
    // Populate every tracked store so nothing is missing.
    const full: Record<string, string> = {}
    for (const k of [
      'canvas-store', 'canvas-item-store', 'asset-store', 'storyboard-store',
      'project-db', 'timeline-store-v2', 'chat-store', 'mapping-store',
    // Must exceed session-backup's MIN_REAL_BYTES (100) — anything smaller
    // is treated as a wiped/empty store and triggers the server pull.
    ]) full[k] = `{"x":"${'a'.repeat(120)}"}`
    stubIdb(full)

    const { tryHydrateFromServerIfIdbEmpty } = await import('@/lib/session-backup')
    const r = await tryHydrateFromServerIfIdbEmpty()

    expect(r.hydrated).toBe(false)
    expect(r.restoredKeys).toEqual([])
    // Did not talk to the server because nothing was missing.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('per-store: restores ONLY the missing stores even when others have data (canvas gone, table survives)', async () => {
    // Regression for the "画布不能 load，表格就没问题" bug — old logic
    // skipped the server pull entirely when ANY store had data.
    // All payloads exceed MIN_REAL_BYTES (100) so they count as real data.
    const pad = (o: Record<string, unknown>) => JSON.stringify({ ...o, _pad: 'a'.repeat(120) })
    const serverCanvas = pad({ nodes: [1] })
    const serverStoryboard = pad({ rows: ['server-version'] })
    const serverProjectDb = pad({ script: { text: 'server' } })
    const localStoryboard = pad({ rows: ['local-keep'] })
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        snapshot: {
          'canvas-store': serverCanvas,                       // missing locally → restore
          'storyboard-store': serverStoryboard,               // present locally → keep local
          'project-db': serverProjectDb,                      // missing locally → restore
        },
        savedAt: '2026-05-18T02:00:00Z',
      }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { data } = stubIdb({ 'storyboard-store': localStoryboard })

    const { tryHydrateFromServerIfIdbEmpty } = await import('@/lib/session-backup')
    const r = await tryHydrateFromServerIfIdbEmpty()

    expect(r.hydrated).toBe(true)
    expect(r.restoredKeys).toEqual(expect.arrayContaining(['canvas-store', 'project-db']))
    expect(r.restoredKeys).not.toContain('storyboard-store')
    expect(data['canvas-store']).toBe(serverCanvas)
    expect(data['project-db']).toBe(serverProjectDb)
    // Local storyboard-store was NOT clobbered.
    expect(data['storyboard-store']).toBe(localStoryboard)
  })

  it('pulls + writes the server snapshot into IDB when every tracked store is empty', async () => {
    const pad = (o: Record<string, unknown>) => JSON.stringify({ ...o, _pad: 'a'.repeat(120) })
    const serverCanvas = pad({ nodes: [1] })
    const serverProjectDb = pad({ script: { text: 'hello' } })
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        snapshot: {
          'canvas-store': serverCanvas,
          'project-db': serverProjectDb,
          'unknown-store': 'should be ignored',
        },
        savedAt: '2026-05-18T01:00:00Z',
      }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { data } = stubIdb()

    const { tryHydrateFromServerIfIdbEmpty } = await import('@/lib/session-backup')
    const r = await tryHydrateFromServerIfIdbEmpty()

    expect(r.hydrated).toBe(true)
    expect(r.savedAt).toBe('2026-05-18T01:00:00Z')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('/local-session')
    // The two tracked stores got written; the unknown key was ignored.
    expect(data['canvas-store']).toBe(serverCanvas)
    expect(data['project-db']).toBe(serverProjectDb)
    expect(data['unknown-store']).toBeUndefined()
  })

  it('returns {hydrated:false} when server reports no snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ snapshot: null, savedAt: null }) })))
    stubIdb()
    const { tryHydrateFromServerIfIdbEmpty } = await import('@/lib/session-backup')
    const r = await tryHydrateFromServerIfIdbEmpty()
    expect(r.hydrated).toBe(false)
  })

  it('returns {hydrated:false} when the server endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    stubIdb()
    const { tryHydrateFromServerIfIdbEmpty } = await import('@/lib/session-backup')
    const r = await tryHydrateFromServerIfIdbEmpty()
    expect(r.hydrated).toBe(false)
  })

  it('returns {hydrated:false} when indexedDB is unavailable (SSR / private mode)', async () => {
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('fetch', vi.fn())
    const { tryHydrateFromServerIfIdbEmpty } = await import('@/lib/session-backup')
    const r = await tryHydrateFromServerIfIdbEmpty()
    expect(r.hydrated).toBe(false)
  })
})
