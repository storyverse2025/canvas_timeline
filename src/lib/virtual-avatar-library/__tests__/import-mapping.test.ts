import { describe, expect, it } from 'vitest'
import { mapByteplusAssets, mapByteplusAssetToAvatar } from '../import-mapping'

describe('mapByteplusAssetToAvatar', () => {
  it('maps the OpenAPI PascalCase shape', () => {
    const a = mapByteplusAssetToAvatar({
      Id: 'asset-001', Name: '图片1', URL: 'https://x/p.png',
      Tags: ['female', '25', 'chinese', 'long-hair'],
    })
    expect(a).toMatchObject({
      id: 'asset-001', name: '图片1', uri: 'https://x/p.png',
      gender: 'female', nationality: 'chinese',
    })
    expect(a?.ageMin).toBe(25)
    expect(a?.tags).toContain('long-hair')
  })

  it('maps camelCase console shape + coverUrl', () => {
    const a = mapByteplusAssetToAvatar({
      id: 'asset-002', name: '少年', coverUrl: 'https://x/c.png',
      gender: '男', age: '20-30', nationality: 'japanese',
    })
    expect(a).toMatchObject({ id: 'asset-002', gender: 'male', nationality: 'japanese', uri: 'https://x/c.png' })
    expect(a?.ageMin).toBe(20)
    expect(a?.ageMax).toBe(30)
  })

  it('extracts id from an asset:// uri when no id field', () => {
    const a = mapByteplusAssetToAvatar({ URI: 'asset://asset-xyz', Name: 'n' })
    expect(a?.id).toBe('asset-xyz')
  })

  it('drops a non-displayable asset:// uri from the preview field', () => {
    const a = mapByteplusAssetToAvatar({ Id: 'a', URL: 'asset://a' })
    expect(a?.uri).toBeUndefined()
  })

  it('infers demographics from profile text when no explicit fields', () => {
    const a = mapByteplusAssetToAvatar({
      Id: 'a', Profile: 'An energetic young Chinese woman, college student',
    })
    expect(a?.gender).toBe('female')
    expect(a?.nationality).toBe('chinese')
    expect(a?.ageMin).toBe(18) // "young" → 18-30
  })

  it('falls back to neutral gender + 0 ages on unknown', () => {
    const a = mapByteplusAssetToAvatar({ Id: 'a', Name: 'x' })
    expect(a).toMatchObject({ id: 'a', name: 'x', gender: 'neutral', ageMin: 0, ageMax: 0 })
  })

  it('returns null without a resolvable id', () => {
    expect(mapByteplusAssetToAvatar({ Name: 'no id' })).toBeNull()
    expect(mapByteplusAssetToAvatar('nope')).toBeNull()
  })
})

describe('mapByteplusAssets (envelopes)', () => {
  it('unwraps Result.Items', () => {
    const out = mapByteplusAssets({ Result: { Items: [{ Id: 'a' }, { Id: 'b' }], TotalCount: 2 } })
    expect(out.map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('unwraps data.list', () => {
    expect(mapByteplusAssets({ data: { list: [{ id: 'a' }] } })[0]?.id).toBe('a')
  })
  it('accepts a bare array and drops id-less entries', () => {
    const out = mapByteplusAssets([{ Id: 'a' }, { Name: 'skip' }])
    expect(out.map((x) => x.id)).toEqual(['a'])
  })
  it('returns [] for unrecognized shapes', () => {
    expect(mapByteplusAssets({ weird: true })).toEqual([])
  })
})
