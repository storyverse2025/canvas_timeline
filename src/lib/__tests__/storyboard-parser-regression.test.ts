import { describe, expect, it } from 'vitest'
import { parseAndValidateStoryboard } from '@/lib/storyboard-parser'

const validRow = {
  shot_number: 'S1',
  duration: 3,
  visual_description: '少年推门入雨。',
}

describe('storyboard parser retry regressions', () => {
  it('does not mistake earlier bracketed prose for the corrected JSON array', () => {
    const response = `已修正 [S1] 的 duration 字段，完整数组如下：
[
  ${JSON.stringify(validRow)}
]`

    const result = parseAndValidateStoryboard(response)

    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(1)
    expect(result.rows?.[0].shot_number).toBe('S1')
  })

  it('parses the storyboard array when node references contain square brackets inside strings', () => {
    const response = JSON.stringify([
      {
        ...validRow,
        reference_image: '[node:abcdef12]',
        character1: { image: '[node:12345678]', description: '少年' },
      },
    ], null, 2)

    const result = parseAndValidateStoryboard(response)

    expect(result.ok).toBe(true)
    expect(result.rows?.[0].reference_image).toBe('[node:abcdef12]')
    expect(result.rows?.[0].character1.image).toBe('[node:12345678]')
  })

  it('normalizes null optional element slots to empty slot objects', () => {
    const response = JSON.stringify([
      {
        ...validRow,
        character1: { image: '', description: '主角' },
        character2: null,
        prop1: { image: '', description: '雨伞' },
        prop2: null,
        scene: { image: '', description: '雨夜街道' },
      },
      {
        ...validRow,
        shot_number: 'S2',
        character2: null,
      },
    ], null, 2)

    const result = parseAndValidateStoryboard(response)

    expect(result.ok).toBe(true)
    expect(result.rows?.[0].character2).toEqual({ image: '', description: '', nodeId: '' })
    expect(result.rows?.[0].prop2).toEqual({ image: '', description: '', nodeId: '' })
    expect(result.rows?.[1].character2).toEqual({ image: '', description: '', nodeId: '' })
  })
})
