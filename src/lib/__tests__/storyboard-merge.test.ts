import { describe, expect, it } from 'vitest'
import { computeMergeGroups, mergeRowGroup, mergeSameSceneRows } from '@/lib/storyboard-merge'
import { StoryboardRowSchema } from '@/types/storyboard'
import type { StoryboardRowInput } from '@/types/storyboard'

const slot = (description: string) => ({ image: '', description, nodeId: '' })

function row(over: Partial<StoryboardRowInput>): StoryboardRowInput {
  return StoryboardRowSchema.parse({ shot_number: 'S?', duration: 5, ...over })
}

const church = () => slot('废弃教堂，彩窗漏光')
const rooftop = () => slot('雨夜天台')

describe('mergeSameSceneRows (同场景合并 → 接近 15s 的长 beat)', () => {
  it('merges adjacent same-scene rows while the sum stays ≤ 15s', () => {
    const rows = [
      row({ shot_number: 'S1', duration: 5, scene: church(), visual_description: '莉安推门' }),
      row({ shot_number: 'S2', duration: 6, scene: church(), visual_description: '莉安走近祭坛' }),
      row({ shot_number: 'S3', duration: 4, scene: church(), visual_description: '特写怀表' }),
    ]
    const { rows: out, mergedAway } = mergeSameSceneRows(rows)
    expect(out).toHaveLength(1)
    expect(mergedAway).toBe(2)
    expect(out[0]!.duration).toBe(15)
    expect(out[0]!.shot_number).toBe('S1~S3')
  })

  it('breaks the group when the next row would exceed 15s', () => {
    const rows = [
      row({ shot_number: 'S1', duration: 8, scene: church() }),
      row({ shot_number: 'S2', duration: 8, scene: church() }),
    ]
    const { rows: out, mergedAway } = mergeSameSceneRows(rows)
    expect(out).toHaveLength(2)
    expect(mergedAway).toBe(0)
  })

  it('never merges across a scene change', () => {
    const rows = [
      row({ shot_number: 'S1', duration: 4, scene: church() }),
      row({ shot_number: 'S2', duration: 4, scene: rooftop() }),
      row({ shot_number: 'S3', duration: 4, scene: rooftop() }),
    ]
    const { rows: out } = mergeSameSceneRows(rows)
    expect(out).toHaveLength(2)
    expect(out[0]!.shot_number).toBe('S1')
    expect(out[1]!.shot_number).toBe('S2~S3')
  })

  it('never merges rows without a scene identity', () => {
    const rows = [
      row({ shot_number: 'S1', duration: 4 }),
      row({ shot_number: 'S2', duration: 4 }),
    ]
    expect(mergeSameSceneRows(rows).rows).toHaveLength(2)
  })

  it('re-lays per-beat text out as time-segment blocks (Seedance ≥8s 分时段)', () => {
    const rows = [
      row({ shot_number: 'S1', duration: 5, scene: church(), visual_description: '推门', motion_prompts: '缓慢推进', character_actions: '开门', dialogue: '莉安：有人吗？' }),
      row({ shot_number: 'S2', duration: 7, scene: church(), visual_description: '走近祭坛', motion_prompts: '跟拍', character_actions: '走动', dialogue: '莉安：是你留下的。' }),
    ]
    const merged = mergeSameSceneRows(rows).rows[0]!
    expect(merged.motion_prompts).toBe('【0-5s】缓慢推进\n【5-12s】跟拍')
    expect(merged.visual_description).toBe('【0-5s】推门\n【5-12s】走近祭坛')
    expect(merged.character_actions).toBe('【0-5s】开门\n【5-12s】走动')
    expect(merged.dialogue).toBe('莉安：有人吗？\n莉安：是你留下的。')
  })

  it('unions characters/props into the slots and refuses to merge when the union exceeds 2', () => {
    const ok = mergeSameSceneRows([
      row({ shot_number: 'S1', duration: 4, scene: church(), character1: slot('莉安，灰风衣') }),
      row({ shot_number: 'S2', duration: 4, scene: church(), character1: slot('沃斯，黑大衣') }),
    ])
    expect(ok.rows).toHaveLength(1)
    expect(ok.rows[0]!.character1.description).toBe('莉安，灰风衣')
    expect(ok.rows[0]!.character2.description).toBe('沃斯，黑大衣')

    const tooMany = mergeSameSceneRows([
      row({ shot_number: 'S1', duration: 4, scene: church(), character1: slot('莉安'), character2: slot('沃斯') }),
      row({ shot_number: 'S2', duration: 4, scene: church(), character1: slot('神父') }),
    ])
    expect(tooMany.rows).toHaveLength(2)
  })

  it('dedupes the same character appearing in both rows', () => {
    const merged = mergeSameSceneRows([
      row({ shot_number: 'S1', duration: 4, scene: church(), character1: slot('莉安，灰风衣') }),
      row({ shot_number: 'S2', duration: 4, scene: church(), character1: slot('莉安，灰风衣') }),
    ]).rows[0]!
    expect(merged.character1.description).toBe('莉安，灰风衣')
    expect(merged.character2.description).toBe('')
  })

  it('never merges transition/bridge rows', () => {
    const bridge = { ...row({ shot_number: 'S1.5', duration: 3, scene: church() }), isTransition: true }
    const rows = [
      row({ shot_number: 'S1', duration: 4, scene: church() }),
      bridge,
      row({ shot_number: 'S2', duration: 4, scene: church() }),
    ]
    expect(mergeSameSceneRows(rows).rows).toHaveLength(3)
  })

  it('mergeRowGroup keeps the FIRST row as the base (runtime id/keyframe survive a manual merge)', () => {
    const first = { ...row({ shot_number: 'S1', duration: 4, scene: church() }), id: 'row-1', keyframeUrl: 'https://kf.png' }
    const second = { ...row({ shot_number: 'S2', duration: 5, scene: church() }), id: 'row-2', keyframeUrl: 'https://other.png' }
    const merged = mergeRowGroup([first, second])
    expect(merged.id).toBe('row-1')
    expect(merged.keyframeUrl).toBe('https://kf.png')
    expect(merged.duration).toBe(9)
  })

  it('computeMergeGroups covers every index exactly once', () => {
    const rows = [
      row({ shot_number: 'S1', duration: 6, scene: church() }),
      row({ shot_number: 'S2', duration: 6, scene: church() }),
      row({ shot_number: 'S3', duration: 6, scene: church() }), // exceeds 15 with S1+S2 → own group
      row({ shot_number: 'S4', duration: 4, scene: rooftop() }),
    ]
    const groups = computeMergeGroups(rows)
    expect(groups.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    expect(groups).toEqual([[0, 1], [2], [3]])
  })
})
