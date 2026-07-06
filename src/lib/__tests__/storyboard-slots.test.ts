import { describe, expect, it } from 'vitest'
import {
  EMPTY_ELEMENT_SLOT,
  MAX_ROW_CHARACTERS,
  isNonEmptySlot,
  normalizeRowSlots,
  rowCharacters,
  rowProps,
  type ElementSlot,
} from '@/types/storyboard'

const slot = (description: string): ElementSlot => ({ image: '', description, nodeId: '' })

describe('storyboard slot helpers', () => {
  it('isNonEmptySlot true only when a field is set', () => {
    expect(isNonEmptySlot(null)).toBe(false)
    expect(isNonEmptySlot({ ...EMPTY_ELEMENT_SLOT })).toBe(false)
    expect(isNonEmptySlot(slot('沈玦'))).toBe(true)
    expect(isNonEmptySlot({ image: 'u', description: '', nodeId: '' })).toBe(true)
  })

  it('rowCharacters prefers the array', () => {
    const row = { characters: [slot('A'), slot('B'), slot('C')], character1: slot('X'), character2: slot('Y') }
    expect(rowCharacters(row).map((s) => s.description)).toEqual(['A', 'B', 'C'])
  })

  it('rowCharacters falls back to legacy pair when array empty', () => {
    const row = { characters: [], character1: slot('X'), character2: slot('Y') }
    expect(rowCharacters(row).map((s) => s.description)).toEqual(['X', 'Y'])
  })

  it('rowProps uses same array-first / pair-fallback rule', () => {
    expect(rowProps({ props: [slot('P1'), slot('P2')] }).map((s) => s.description)).toEqual(['P1', 'P2'])
    expect(rowProps({ props: [], prop1: slot('L1') }).map((s) => s.description)).toEqual(['L1'])
  })

  it('normalizeRowSlots back-fills arrays from legacy pair fields', () => {
    const row = normalizeRowSlots({ character1: slot('A'), character2: slot('B'), prop1: slot('P') })
    expect(row.characters!.map((s) => s.description)).toEqual(['A', 'B'])
    expect(row.props!.map((s) => s.description)).toEqual(['P'])
  })

  it('normalizeRowSlots mirrors first two array entries onto legacy fields', () => {
    const row = normalizeRowSlots({ characters: [slot('A'), slot('B'), slot('C'), slot('D')] })
    expect(row.character1!.description).toBe('A')
    expect(row.character2!.description).toBe('B')
    // Array keeps all; legacy only sees first two.
    expect(row.characters!.map((s) => s.description)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('normalizeRowSlots caps the array and pads legacy fields to empty', () => {
    const many = Array.from({ length: 9 }, (_, i) => slot(`C${i}`))
    const row = normalizeRowSlots({ characters: many })
    expect(row.characters!).toHaveLength(MAX_ROW_CHARACTERS)
    const single = normalizeRowSlots({ characters: [slot('only')] })
    expect(single.character2!.description).toBe('') // padded empty
    expect(isNonEmptySlot(single.character2)).toBe(false)
  })
})
