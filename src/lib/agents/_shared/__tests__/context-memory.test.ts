import { describe, it, expect } from 'vitest'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import type { LLM } from '@/lib/agents/_shared/llm/types'

const noopLLM: LLM = { complete: async () => '' }

describe('createMemoryContext', () => {
  it('returns default style when none provided', () => {
    const ctx = createMemoryContext({ llm: noopLLM })
    expect(ctx.project.style.get().presetId).toBe('anime_psych_thriller_motion_comic')
  })

  it('respects a provided style snapshot', () => {
    const ctx = createMemoryContext({
      llm: noopLLM,
      snapshot: { style: { presetId: 'liveaction_nolan_filmic', promptText: 'X' } },
    })
    expect(ctx.project.style.get().presetId).toBe('liveaction_nolan_filmic')
  })

  it('seeds and assigns ids on add', () => {
    const ctx = createMemoryContext({ llm: noopLLM })
    const c = ctx.project.characters.add({ name: 'Alice', description: 'detective' })
    expect(c.id).toBe('char-1')
    expect(ctx.project.characters.list()).toHaveLength(1)
  })

  it('respects explicit ids', () => {
    const ctx = createMemoryContext({ llm: noopLLM })
    const c = ctx.project.characters.add({ id: 'C42', name: 'Bob', description: '' })
    expect(c.id).toBe('C42')
    expect(ctx.project.characters.get('C42')).toBeDefined()
  })

  it('removes by id', () => {
    const ctx = createMemoryContext({
      llm: noopLLM,
      snapshot: {
        characters: [{ id: 'a', name: 'A', description: '' }],
      },
    })
    ctx.project.characters.remove('a')
    expect(ctx.project.characters.list()).toHaveLength(0)
  })

  it('uses an unaborted signal by default', () => {
    const ctx = createMemoryContext({ llm: noopLLM })
    expect(ctx.abort.aborted).toBe(false)
  })
})
