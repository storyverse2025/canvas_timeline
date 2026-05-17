import { describe, it, expect, vi } from 'vitest'

import {
  actorAgent,
  buildEnrichRowPrompt,
  cardsForRow,
  enrichRow,
  enrichTable,
  nameFromSlotDescription,
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
  it('exposes enrichRow + enrichTable on the module export', () => {
    expect(actorAgent.enrichRow).toBe(enrichRow)
    expect(actorAgent.enrichTable).toBe(enrichTable)
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
