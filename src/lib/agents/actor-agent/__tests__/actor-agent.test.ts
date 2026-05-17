import { describe, it, expect, vi } from 'vitest'

import {
  actorAgent,
  attachVoiceRefs,
  buildCastVoicesPrompt,
  buildEnrichRowPrompt,
  cardsForRow,
  castVoices,
  enrichRow,
  enrichTable,
  nameFromSlotDescription,
  parseDialogueByCharacter,
} from '@/lib/agents/actor-agent'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { driveAuto } from '@/lib/agents/_shared/runtime/runner'
import type { LLM } from '@/lib/agents/_shared/llm/types'

function llmReturning(...responses: string[]): { llm: LLM; spy: ReturnType<typeof vi.fn> } {
  let i = 0
  const spy = vi.fn(async () => {
    const r = responses[i] ?? ''
    i++
    return r
  })
  return { llm: { complete: spy }, spy }
}

const enrichedSample = {
  character_actions: '林清 把怀表塞进袖口；阿澈 看了一眼远处的码头灯。',
  character_motivation: '林清: 不让追兵看到证物。阿澈: 确认是否安全撤离。',
  character_psychology: '林清表面冷静，深层焦虑父亲遗物丢失；阿澈表面警惕，深层信任林清。',
  dialogue: '林清: 不要回头。\n阿澈: 一直走，别停。',
  performance_guidance: '林清: 眼睛余光不离阿澈，左手指轻敲怀表壳缘；阿澈: 呼吸压短，肩颈微紧。',
}

describe('actor-agent: meta', () => {
  it('exposes all four verbs on the module export', () => {
    expect(actorAgent.enrichRow).toBe(enrichRow)
    expect(actorAgent.enrichTable).toBe(enrichTable)
    expect(actorAgent.castVoices).toBe(castVoices)
    expect(actorAgent.attachVoiceRefs).toBe(attachVoiceRefs)
    expect(actorAgent.meta.name).toBe('actor-agent')
  })
})

describe('pure helpers', () => {
  it("nameFromSlotDescription strips the first comma-separated token", () => {
    expect(nameFromSlotDescription('林清, 短发, 灰色风衣')).toBe('林清')
    expect(nameFromSlotDescription('Alice，short hair')).toBe('Alice')
    expect(nameFromSlotDescription('')).toBeUndefined()
    expect(nameFromSlotDescription(undefined)).toBeUndefined()
  })

  it('cardsForRow returns only cards whose name appears in the row slots', () => {
    const all = [
      { name: '林清' },
      { name: '阿澈' },
      { name: '陌生人' },
    ]
    const picked = cardsForRow(
      {
        character1: { description: '林清, 灰色风衣' },
        character2: { description: '阿澈, 雨衣' },
      },
      all,
    )
    expect(picked.map((c) => c.name)).toEqual(['林清', '阿澈'])
  })

  it('cardsForRow falls back to the full roster when no name matches (defense for hand-edited rows)', () => {
    const all = [{ name: '林清' }, { name: '阿澈' }]
    const picked = cardsForRow(
      { character1: { description: '一个完全没见过的人' } },
      all,
    )
    expect(picked.map((c) => c.name)).toEqual(['林清', '阿澈'])
  })

  it('cardsForRow returns [] for a row with no character slots', () => {
    expect(cardsForRow({ character1: { description: '' } }, [{ name: '林清' }])).toEqual([])
    expect(cardsForRow({}, [{ name: '林清' }])).toEqual([])
  })

  it('buildEnrichRowPrompt embeds row + cards + brief + scene in the prompt body', () => {
    const prompt = buildEnrichRowPrompt({
      row: { shot_number: 'S3', visual_description: 'rooftop at dusk' },
      cards: [{ name: '林清', voice_print: '短句，少修饰' }],
      scene: { name: 'Rooftop', description: 'wet concrete + neon' },
      creativeBrief: { projectType: '短剧单集', tone: '悬疑救赎', genre: '短剧单集 · 悬疑救赎' },
      visualStyle: 'Cold-toned filmic noir',
    })
    // Header substitutions.
    expect(prompt).toContain('项目类型: 短剧单集')
    expect(prompt).toContain('TONE: 悬疑救赎')
    expect(prompt).toContain('GENRE: 短剧单集 · 悬疑救赎')
    expect(prompt).toContain('视觉风格: Cold-toned filmic noir')
    // Row JSON dumped in full.
    expect(prompt).toContain('"shot_number": "S3"')
    expect(prompt).toContain('"visual_description": "rooftop at dusk"')
    // Casting cards JSON dumped.
    expect(prompt).toContain('"voice_print": "短句，少修饰"')
    // Scene JSON dumped.
    expect(prompt).toContain('wet concrete + neon')
  })
})

describe('enrichRow', () => {
  it('returns the 5 enriched fields from the LLM JSON', async () => {
    const { llm } = llmReturning('```json\n' + JSON.stringify(enrichedSample) + '\n```')
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      enrichRow(
        {
          row: {
            shot_number: 'S1',
            character1: { description: '林清, 灰色风衣' },
            character2: { description: '阿澈, 雨衣' },
          },
          castingCards: [{ name: '林清' }, { name: '阿澈' }],
        },
        ctx,
      ),
    )
    expect(result).toEqual(enrichedSample)
  })

  it('skips the LLM call when the row has no characters (passes existing values through)', async () => {
    const { llm, spy } = llmReturning('SHOULD NOT BE CALLED')
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      enrichRow(
        {
          row: {
            shot_number: 'S2',
            character_actions: 'existing action text',
            dialogue: '',
            performance_guidance: undefined,
          },
          castingCards: [{ name: '林清' }],
        },
        ctx,
      ),
    )
    expect(spy).not.toHaveBeenCalled()
    expect(result.character_actions).toBe('existing action text')
    // performance_guidance gets a sensible default for the camera subject.
    expect(result.performance_guidance).toContain('身体语言')
  })

  it('throws when the LLM response is not parseable JSON', async () => {
    const { llm } = llmReturning('definitely not json')
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(
        enrichRow(
          {
            row: { character1: { description: '林清' } },
            castingCards: [{ name: '林清' }],
          },
          ctx,
        ),
      ),
    ).rejects.toThrow(/parseable JSON object/)
  })

  it('throws when the JSON does not match the EnrichedPerformanceFields schema', async () => {
    const { llm } = llmReturning('{"character_actions": "...", "dialogue": 42}')
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(
        enrichRow(
          {
            row: { character1: { description: '林清' } },
            castingCards: [{ name: '林清' }],
          },
          ctx,
        ),
      ),
    ).rejects.toThrow(/failed validation/)
  })

  it('feeds the cards-for-row helper into the prompt (not the full roster)', async () => {
    const { llm, spy } = llmReturning(JSON.stringify(enrichedSample))
    const ctx = createMemoryContext({ llm })
    await driveAuto(
      enrichRow(
        {
          row: { character1: { description: '林清, 灰色风衣' } },
          castingCards: [
            { name: '林清', voice_print: '短句' },
            { name: '阿澈', voice_print: '常断句' },
            { name: '陌生人', voice_print: '陌生人专属' },
          ],
        },
        ctx,
      ),
    )
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('林清')
    expect(sent).toContain('"voice_print": "短句"')
    // Only the matching card should be sent — the 陌生人 voice_print and
    // 阿澈's "常断句" should NOT appear because they aren't in the row.
    expect(sent).not.toContain('"voice_print": "陌生人专属"')
    expect(sent).not.toContain('"voice_print": "常断句"')
  })
})

describe('enrichTable', () => {
  it('emits a result keyed by row.id for every row in the batch', async () => {
    const a = { ...enrichedSample, character_actions: 'A action' }
    const b = { ...enrichedSample, character_actions: 'B action' }
    const { llm } = llmReturning(JSON.stringify(a), JSON.stringify(b))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      enrichTable(
        {
          rows: [
            { id: 'r1', shot_number: 'S1', character1: { description: '林清' } },
            { id: 'r2', shot_number: 'S2', character1: { description: '阿澈' } },
          ],
          castingCards: [{ name: '林清' }, { name: '阿澈' }],
        },
        ctx,
      ),
    )
    expect(Object.keys(result)).toEqual(['r1', 'r2'])
    expect(result.r1!.character_actions).toBe('A action')
    expect(result.r2!.character_actions).toBe('B action')
  })

  it("continues the batch when one row's LLM call fails (errors logged, not thrown)", async () => {
    const { llm } = llmReturning('not json', JSON.stringify(enrichedSample))
    const logs: string[] = []
    const ctx = createMemoryContext({ llm, log: (m) => logs.push(m) })
    const result = await driveAuto(
      enrichTable(
        {
          rows: [
            { id: 'r1', shot_number: 'S1', character1: { description: '林清' } },
            { id: 'r2', shot_number: 'S2', character1: { description: '阿澈' } },
          ],
          castingCards: [{ name: '林清' }, { name: '阿澈' }],
        },
        ctx,
      ),
    )
    // r1 failed → not in result; r2 succeeded.
    expect(result.r1).toBeUndefined()
    expect(result.r2).toBeDefined()
    expect(logs.some((m) => m.includes('S1') && m.includes('failed'))).toBe(true)
  })
})

describe('castVoices', () => {
  const cards = [
    { name: '林清', voice_print: '短句、少修饰', gender_presentation: 'female' },
    { name: '阿澈', voice_print: '低沉、克制', gender_presentation: 'male' },
  ]
  const candidatesPerCard = {
    林清: [
      { id: 'vox-a', displayName: '少女短句', gender: 'female', sampleSnippet: '我们走，别回头' },
      { id: 'vox-b', displayName: '主持人A', gender: 'female', sampleSnippet: '欢迎收看' },
    ],
    阿澈: [
      { id: 'vox-c', displayName: '低沉男声', gender: 'male', sampleSnippet: '别动，慢慢来' },
      { id: 'vox-d', displayName: '播报员男', gender: 'male', sampleSnippet: '据报道' },
    ],
  }

  it('buildCastVoicesPrompt embeds cards + candidates + brief', () => {
    const prompt = buildCastVoicesPrompt({
      cards,
      candidates: [...candidatesPerCard.林清, ...candidatesPerCard.阿澈],
      creativeBrief: { projectType: '短剧', tone: '悬疑', genre: '短剧 · 悬疑' },
    })
    expect(prompt).toContain('林清')
    expect(prompt).toContain('vox-a')
    expect(prompt).toContain('短剧')
    expect(prompt).toContain('voice_print')
  })

  it('returns the LLM-picked binding map keyed by character name', async () => {
    const { llm } = llmReturning(JSON.stringify({ 林清: 'vox-a', 阿澈: 'vox-c' }))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      castVoices(
        { castingCards: cards, candidatesPerCard, creativeBrief: { tone: '悬疑' } },
        ctx,
      ),
    )
    expect(result).toEqual({ 林清: 'vox-a', 阿澈: 'vox-c' })
  })

  it('drops hallucinated voice ids not in the candidate pool (logs them, does not throw)', async () => {
    const { llm } = llmReturning(JSON.stringify({ 林清: 'vox-a', 阿澈: 'NOT-IN-POOL' }))
    const logs: string[] = []
    const ctx = createMemoryContext({ llm, log: (m) => logs.push(m) })
    const result = await driveAuto(
      castVoices({ castingCards: cards, candidatesPerCard }, ctx),
    )
    expect(result).toEqual({ 林清: 'vox-a' })
    expect(logs.some((m) => m.includes('hallucinated') && m.includes('阿澈'))).toBe(true)
  })

  it('short-circuits on empty castingCards', async () => {
    const { llm, spy } = llmReturning('SHOULD NOT BE CALLED')
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      castVoices({ castingCards: [], candidatesPerCard: {} }, ctx),
    )
    expect(spy).not.toHaveBeenCalled()
    expect(result).toEqual({})
  })

  it('throws on empty candidate pool (caller must shortlist non-empty)', async () => {
    const { llm } = llmReturning('{}')
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(castVoices({ castingCards: cards, candidatesPerCard: { 林清: [], 阿澈: [] } }, ctx)),
    ).rejects.toThrow(/empty candidate pool/)
  })

  it('throws on schema-violating JSON (non-string value)', async () => {
    const { llm } = llmReturning(JSON.stringify({ 林清: 42 }))
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(castVoices({ castingCards: cards, candidatesPerCard }, ctx)),
    ).rejects.toThrow(/failed validation/)
  })
})

describe('parseDialogueByCharacter', () => {
  const cards = [{ name: '林清' }, { name: '阿澈' }]

  it('parses multi-character 角色: line lines', () => {
    const parsed = parseDialogueByCharacter('林清: 不要回头。\n阿澈: 一直走，别停。', cards)
    expect(parsed).toEqual({ 林清: '不要回头。', 阿澈: '一直走，别停。' })
  })

  it('handles full-width colon (：) and trims', () => {
    const parsed = parseDialogueByCharacter('林清：嗯。', cards)
    expect(parsed.林清).toBe('嗯。')
  })

  it('attributes whole dialogue to the sole character when there is no prefix + only 1 card', () => {
    const parsed = parseDialogueByCharacter('我不回头，也不停下。', [{ name: '林清' }])
    expect(parsed.林清).toBe('我不回头，也不停下。')
  })

  it('drops lines with character names that do not match any card', () => {
    const parsed = parseDialogueByCharacter('林清: hi.\n陌生人: who?', cards)
    expect(parsed).toEqual({ 林清: 'hi.' })
  })

  it('returns {} for empty dialogue', () => {
    expect(parseDialogueByCharacter('', cards)).toEqual({})
  })
})

describe('attachVoiceRefs', () => {
  const cards = [{ name: '林清' }, { name: '阿澈' }]

  it('appends a 角色对白与音色 block with per-character voice urls', async () => {
    const ctx = createMemoryContext({ llm: { complete: vi.fn() } })
    const result = await driveAuto(
      attachVoiceRefs(
        {
          videoPrompt: 'BASE PROMPT',
          row: {
            shot_number: 'S1',
            character1: { description: '林清, 短发' },
            character2: { description: '阿澈, 雨衣' },
            dialogue: '林清: 不要回头。\n阿澈: 一直走，别停。',
          },
          castingCards: cards,
          voiceBindings: { 林清: 'vox-a', 阿澈: 'vox-c' },
          voiceUrlFor: (id) =>
            ({ 'vox-a': '/voices/A.mp3', 'vox-c': '/voices/C.mp3' } as Record<string, string>)[id],
        },
        ctx,
      ),
    )
    expect(result.videoPrompt).toContain('BASE PROMPT')
    expect(result.videoPrompt).toContain('角色对白与音色')
    expect(result.videoPrompt).toContain('林清')
    expect(result.videoPrompt).toContain('"不要回头。"')
    expect(result.videoPrompt).toContain('/voices/A.mp3')
    expect(result.videoPrompt).toContain('voice_id: vox-c')
    expect(result.attached.map((a) => a.character)).toEqual(['林清', '阿澈'])
  })

  it('leaves the prompt unchanged when no character has both a binding + a line', async () => {
    const ctx = createMemoryContext({ llm: { complete: vi.fn() } })
    const result = await driveAuto(
      attachVoiceRefs(
        {
          videoPrompt: 'BASE',
          row: {
            shot_number: 'S1',
            character1: { description: '林清' },
            dialogue: '',
          },
          castingCards: cards,
          voiceBindings: { 林清: 'vox-a' },
          voiceUrlFor: (id) => ({ 'vox-a': '/voices/A.mp3' } as Record<string, string>)[id],
        },
        ctx,
      ),
    )
    expect(result.videoPrompt).toBe('BASE')
    expect(result.attached).toEqual([])
  })

  it('skips characters whose voiceUrlFor returns undefined (missing catalog entry)', async () => {
    const ctx = createMemoryContext({ llm: { complete: vi.fn() } })
    const result = await driveAuto(
      attachVoiceRefs(
        {
          videoPrompt: 'BASE',
          row: {
            shot_number: 'S1',
            character1: { description: '林清' },
            character2: { description: '阿澈' },
            dialogue: '林清: a.\n阿澈: b.',
          },
          castingCards: cards,
          voiceBindings: { 林清: 'vox-a', 阿澈: 'vox-MISSING' },
          voiceUrlFor: (id) => (id === 'vox-a' ? '/voices/A.mp3' : undefined),
        },
        ctx,
      ),
    )
    expect(result.attached.map((a) => a.character)).toEqual(['林清'])
    expect(result.videoPrompt).toContain('林清')
    expect(result.videoPrompt).not.toContain('vox-MISSING')
  })
})
