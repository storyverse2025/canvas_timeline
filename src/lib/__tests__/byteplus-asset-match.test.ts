import { describe, expect, it } from 'vitest'
import { matchAssetsToCharacters, mergeAvatarRefs, type ByteplusAsset } from '@/lib/byteplus-asset-library'

const asset = (patch: Partial<ByteplusAsset>): ByteplusAsset => ({
  id: 'asset-x',
  name: '',
  assetType: 'Image',
  status: 'Active',
  groupId: 'group-1',
  ...patch,
})

describe('matchAssetsToCharacters', () => {
  it('matches a slot description to an Active image asset by canonical name (containment both ways)', () => {
    const assets = [
      asset({ id: 'asset-erin', name: '艾琳' }),
      asset({ id: 'asset-other', name: '张三真人参考' }),
    ]
    const refs = matchAssetsToCharacters(
      [{ slotLabel: '角色1', name: '艾琳 (Erin)，凌乱的黑色短发，面部带血迹' }],
      assets,
    )
    expect(refs).toEqual([
      { assetUri: 'asset://asset-erin', characterName: '艾琳 (Erin)', slotLabel: '角色1' },
    ])
  })

  it('matches when the asset name CONTAINS the character name (e.g. "艾琳真人参考")', () => {
    const refs = matchAssetsToCharacters(
      [{ slotLabel: '角色1', name: '艾琳' }],
      [asset({ id: 'asset-1', name: '艾琳真人参考' })],
    )
    expect(refs[0]?.assetUri).toBe('asset://asset-1')
  })

  it('only uses Active image assets — Processing/Failed/video assets never ship', () => {
    const refs = matchAssetsToCharacters(
      [{ slotLabel: '角色1', name: '艾琳' }],
      [
        asset({ id: 'a', name: '艾琳', status: 'Processing' }),
        asset({ id: 'b', name: '艾琳', status: 'Failed' }),
        asset({ id: 'c', name: '艾琳', assetType: 'Video' }),
      ],
    )
    expect(refs).toEqual([])
  })

  it('never assigns the same asset to two characters', () => {
    const refs = matchAssetsToCharacters(
      [
        { slotLabel: '角色1', name: '艾琳' },
        { slotLabel: '角色2', name: '艾琳的克隆' },
      ],
      [asset({ id: 'only-one', name: '艾琳' })],
    )
    expect(refs).toHaveLength(1)
    expect(refs[0]?.slotLabel).toBe('角色1')
  })

  it('explicit binding beats name matching — required because console asset names are machine hashes', () => {
    const assets = [
      asset({ id: 'asset-hash', name: 'keyframe_4fcae3d7' }), // real-world name shape
      asset({ id: 'asset-named', name: '艾琳' }),
    ]
    const refs = matchAssetsToCharacters(
      [{ slotLabel: '角色1', name: '艾琳 (Erin)' }],
      assets,
      { [/* canonicalCharacterName('艾琳 (Erin)') */ '艾琳']: 'asset-hash' },
    )
    expect(refs).toEqual([
      { assetUri: 'asset://asset-hash', characterName: '艾琳 (Erin)', slotLabel: '角色1' },
    ])
  })

  it('a binding to a non-Active or unknown asset falls back to name matching', () => {
    const refs = matchAssetsToCharacters(
      [{ slotLabel: '角色1', name: '艾琳' }],
      [
        asset({ id: 'asset-dead', name: 'x', status: 'Failed' }),
        asset({ id: 'asset-named', name: '艾琳' }),
      ],
      { 艾琳: 'asset-dead' },
    )
    expect(refs[0]?.assetUri).toBe('asset://asset-named')
  })

  it('skips empty slots and non-matching names without throwing', () => {
    const refs = matchAssetsToCharacters(
      [
        { slotLabel: '角色1', name: '' },
        { slotLabel: '角色2', name: '完全对不上的名字' },
      ],
      [asset({ id: 'a', name: '艾琳' })],
    )
    expect(refs).toEqual([])
  })
})

describe('mergeAvatarRefs', () => {
  it('registered 开白资产 wins over a library avatar for the same character; others pass through', () => {
    const merged = mergeAvatarRefs(
      [{ assetUri: 'asset://real-erin', characterName: '艾琳 (Erin)', slotLabel: '角色1' }],
      [
        { assetUri: 'asset://lib-erin', characterName: '艾琳', slotLabel: '角色1' },
        { assetUri: 'asset://lib-zhang', characterName: '张三', slotLabel: '角色2' },
      ],
    )
    expect(merged.map((r) => r.assetUri)).toEqual(['asset://real-erin', 'asset://lib-zhang'])
  })
})
