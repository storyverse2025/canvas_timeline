import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  listLocalByteplusAssets,
  listLocalByteplusAssetsAsByteplus,
  recordLocalByteplusAsset,
  removeLocalByteplusAsset,
  toByteplusAsset,
} from '@/lib/byteplus-local-assets'

// Minimal in-memory localStorage shim (the test env is `node`, no DOM).
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map<string, string>()
    globalThis.localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size
      },
    } as Storage
  }
})

describe('byteplus-local-assets registry', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('records and lists assets, newest first', () => {
    recordLocalByteplusAsset({ id: 'a1', name: '沈玦', active: true, createdAt: 100 })
    recordLocalByteplusAsset({ id: 'a2', name: '墨渊', active: true, createdAt: 200 })
    const list = listLocalByteplusAssets()
    expect(list.map((e) => e.id)).toEqual(['a2', 'a1'])
  })

  it('upserts by id, preserving original createdAt but refreshing fields', () => {
    recordLocalByteplusAsset({ id: 'a1', name: '沈玦', active: false, previewUrl: '/u/old.png', createdAt: 100 })
    recordLocalByteplusAsset({ id: 'a1', name: '沈玦-v2', active: true, previewUrl: '/u/new.png', createdAt: 999 })
    const list = listLocalByteplusAssets()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'a1', name: '沈玦-v2', active: true, previewUrl: '/u/new.png', createdAt: 100 })
  })

  it('ignores entries without an id', () => {
    recordLocalByteplusAsset({ id: '', name: 'nobody', active: true })
    expect(listLocalByteplusAssets()).toHaveLength(0)
  })

  it('removes by id', () => {
    recordLocalByteplusAsset({ id: 'a1', name: '沈玦', active: true })
    recordLocalByteplusAsset({ id: 'a2', name: '墨渊', active: true })
    removeLocalByteplusAsset('a1')
    expect(listLocalByteplusAssets().map((e) => e.id)).toEqual(['a2'])
  })

  it('adapts to ByteplusAsset shape; non-active → Processing so the matcher skips it', () => {
    expect(toByteplusAsset({ id: 'a1', name: '沈玦', active: true, createdAt: 1 })).toMatchObject({
      id: 'a1', name: '沈玦', assetType: 'Image', status: 'Active',
    })
    expect(toByteplusAsset({ id: 'a2', name: '墨渊', active: false, createdAt: 1 }).status).toBe('Processing')
  })

  it('listLocalByteplusAssetsAsByteplus maps the whole registry', () => {
    recordLocalByteplusAsset({ id: 'a1', name: '沈玦', active: true })
    const bp = listLocalByteplusAssetsAsByteplus()
    expect(bp).toHaveLength(1)
    expect(bp[0]).toMatchObject({ id: 'a1', status: 'Active', assetType: 'Image' })
  })

  it('survives a corrupt localStorage payload', () => {
    localStorage.setItem('byteplus-openbai-registry-v1', '{not json')
    expect(listLocalByteplusAssets()).toEqual([])
    recordLocalByteplusAsset({ id: 'a1', name: '沈玦', active: true })
    expect(listLocalByteplusAssets()).toHaveLength(1)
  })
})
