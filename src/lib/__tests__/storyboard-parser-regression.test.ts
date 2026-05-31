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

  it('coerces drifted field names (shot → shot_number, time → duration, camelCase → snake_case)', () => {
    // What the user actually saw: LLM occasionally emits row[N] with sibling
    // names like `shot` instead of `shot_number` and `time` instead of
    // `duration`. The schema then rejects the row with a useless
    // "undefined" error. The alias coercion now maps these back BEFORE
    // Zod validation.
    const response = JSON.stringify([
      {
        shot: 'S1',                       // alias for shot_number
        time: 3.5,                        // alias for duration
        visualDescription: '少年推门入雨',  // alias for visual_description
        shotSize: '中景',                 // alias for shot_size
        characterActions: '推门',          // alias for character_actions
      },
      {
        shotNumber: 'S2',                 // alternate alias for shot_number
        duration: '4',                    // duration string already gets numeric-coerced
        storyboardPrompts: 'multi-panel', // alias for storyboard_prompts
        motion: '推镜',                   // alias for motion_prompts
      },
    ], null, 2)

    const result = parseAndValidateStoryboard(response)
    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(2)
    expect(result.rows?.[0].shot_number).toBe('S1')
    expect(result.rows?.[0].duration).toBe(3.5)
    expect(result.rows?.[0].visual_description).toBe('少年推门入雨')
    expect(result.rows?.[0].shot_size).toBe('中景')
    expect(result.rows?.[0].character_actions).toBe('推门')
    expect(result.rows?.[1].shot_number).toBe('S2')
    expect(result.rows?.[1].duration).toBe(4)
    expect(result.rows?.[1].storyboard_prompts).toBe('multi-panel')
    expect(result.rows?.[1].motion_prompts).toBe('推镜')
  })

  it('attaches row JSON previews to errors so users can see what the LLM actually returned', () => {
    // The original report was "0.shot_number: Invalid input: expected
    // string, received undefined; 1.shot_number: ..." which gives the
    // user no clue WHAT row[0] was — was it empty? was it under a key
    // alias coercion didn't catch? Show the raw JSON.
    const response = JSON.stringify([
      { mystery_field: 'X', another: 42 },   // no shot_number / duration at all
      { foo: 'bar' },
    ], null, 2)

    const result = parseAndValidateStoryboard(response)
    expect(result.ok).toBe(false)
    const joined = (result.errors ?? []).join('\n')
    expect(joined).toMatch(/row\[0\] = .*mystery_field/)
    expect(joined).toMatch(/row\[1\] = .*foo/)
  })
})
