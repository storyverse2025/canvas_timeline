import { describe, it, expect, vi } from 'vitest'

import {
  buildDesignRowPrompt,
  designRow,
  designTable,
  mergeBriefIntoRow,
  rowAlreadyFullySpec,
  soundAgent,
} from '@/lib/agents/sound-agent'
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

const sampleBrief = {
  bgm: 'Function: 悬疑等待感。Low synth pad (~50 BPM) + 远处单音钢琴；不发展，只铺底；前 8s 静默积累，9-15s 大提琴单弓 mp→mf swell。参考 Mica Levi《Under the Skin》。',
  sound_effects:
    '- 雨打金属屋顶 (ambience, 全程, mid-far, -22 LUFS)\n- 皮鞋踩湿石板 (foley, 0-2s 三步, mid, 中)\n- 远处汽笛 (one-shot, 9s, far, 弱衰减)',
  mixing_brief:
    '对白主导 (peak -12 dBFS center)。BGM 在对白开始 -8 dB ducking (200ms attack / 800ms release)。雨声 ambience 立体声宽展。汽笛 -16 dB pan 右 30%。本镜末 800ms BGM 淡出，雨声保留 500ms reverb tail。',
}

describe('sound-agent: meta', () => {
  it('exposes designRow + designTable on the module export', () => {
    expect(soundAgent.designRow).toBe(designRow)
    expect(soundAgent.designTable).toBe(designTable)
    expect(soundAgent.meta.name).toBe('sound-agent')
  })
})

describe('pure helpers', () => {
  it('rowAlreadyFullySpec returns true only when all 3 fields non-empty', () => {
    expect(rowAlreadyFullySpec({})).toBe(false)
    expect(rowAlreadyFullySpec({ bgm: 'x', sound_effects: 'y' })).toBe(false)
    expect(rowAlreadyFullySpec({ bgm: 'x', sound_effects: 'y', mixing_brief: 'z' })).toBe(true)
    // whitespace-only counts as empty
    expect(rowAlreadyFullySpec({ bgm: '  ', sound_effects: 'y', mixing_brief: 'z' })).toBe(false)
  })

  it('mergeBriefIntoRow with overwrite=false keeps existing non-empty fields, fills missing from llm', () => {
    const merged = mergeBriefIntoRow(
      { bgm: 'existing BGM', sound_effects: '', mixing_brief: undefined },
      sampleBrief,
      false,
    )
    expect(merged.bgm).toBe('existing BGM')
    expect(merged.sound_effects).toBe(sampleBrief.sound_effects)
    expect(merged.mixing_brief).toBe(sampleBrief.mixing_brief)
  })

  it('mergeBriefIntoRow with overwrite=true rewrites all 3 fields from llm', () => {
    const merged = mergeBriefIntoRow(
      { bgm: 'existing BGM', sound_effects: 'existing SFX', mixing_brief: 'existing mix' },
      sampleBrief,
      true,
    )
    expect(merged).toEqual(sampleBrief)
  })

  it('buildDesignRowPrompt embeds row + brief + style in the prompt body', () => {
    const prompt = buildDesignRowPrompt({
      row: { shot_number: 'S3', emotion_atmosphere: '冷雨悬疑', shot_size: 'MS' },
      creativeBrief: { projectType: '短剧单集', tone: '悬疑救赎', genre: '短剧单集 · 悬疑救赎' },
      visualStyle: 'Cold-toned filmic noir',
    })
    expect(prompt).toContain('"shot_number": "S3"')
    expect(prompt).toContain('"emotion_atmosphere": "冷雨悬疑"')
    expect(prompt).toContain('短剧单集')
    expect(prompt).toContain('Cold-toned filmic noir')
  })
})

describe('designRow', () => {
  it('returns the 3 sound fields from the LLM JSON', async () => {
    const { llm } = llmReturning('```json\n' + JSON.stringify(sampleBrief) + '\n```')
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      designRow(
        { row: { shot_number: 'S1', emotion_atmosphere: '冷雨悬疑' } },
        ctx,
      ),
    )
    expect(result).toEqual(sampleBrief)
  })

  it('short-circuits when the row is already fully spec\'d (no LLM call)', async () => {
    const { llm, spy } = llmReturning('SHOULD NOT BE CALLED')
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      designRow(
        {
          row: {
            shot_number: 'S2',
            bgm: 'existing bgm',
            sound_effects: 'existing sfx',
            mixing_brief: 'existing mix',
          },
        },
        ctx,
      ),
    )
    expect(spy).not.toHaveBeenCalled()
    expect(result.bgm).toBe('existing bgm')
    expect(result.sound_effects).toBe('existing sfx')
    expect(result.mixing_brief).toBe('existing mix')
  })

  it('with overwrite=true, still calls the LLM even when row is fully spec\'d', async () => {
    const { llm, spy } = llmReturning(JSON.stringify(sampleBrief))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      designRow(
        {
          row: {
            shot_number: 'S3',
            bgm: 'existing bgm',
            sound_effects: 'existing sfx',
            mixing_brief: 'existing mix',
          },
          overwrite: true,
        },
        ctx,
      ),
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result).toEqual(sampleBrief)
  })

  it('keeps existing non-empty fields when overwrite=false (partial fill)', async () => {
    const { llm } = llmReturning(JSON.stringify(sampleBrief))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      designRow(
        {
          row: {
            shot_number: 'S4',
            bgm: 'hand-tuned BGM by user',
            sound_effects: '',
            mixing_brief: '',
          },
        },
        ctx,
      ),
    )
    expect(result.bgm).toBe('hand-tuned BGM by user')
    expect(result.sound_effects).toBe(sampleBrief.sound_effects)
    expect(result.mixing_brief).toBe(sampleBrief.mixing_brief)
  })

  it('throws when the LLM response is not parseable JSON', async () => {
    const { llm } = llmReturning('definitely not json')
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(designRow({ row: { shot_number: 'S5' } }, ctx)),
    ).rejects.toThrow(/parseable JSON object/)
  })

  it('throws when JSON misses a required field', async () => {
    const { llm } = llmReturning(JSON.stringify({ bgm: 'x', sound_effects: 'y' }))
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(designRow({ row: { shot_number: 'S6' } }, ctx)),
    ).rejects.toThrow(/failed validation/)
  })

  it('throws when a required field is the empty string', async () => {
    const { llm } = llmReturning(
      JSON.stringify({ bgm: '', sound_effects: 'x', mixing_brief: 'y' }),
    )
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(designRow({ row: { shot_number: 'S7' } }, ctx)),
    ).rejects.toThrow(/failed validation/)
  })
})

describe('designTable', () => {
  it('emits a result keyed by row.id for every row in the batch', async () => {
    const a = { ...sampleBrief, bgm: 'A bgm' }
    const b = { ...sampleBrief, bgm: 'B bgm' }
    const { llm } = llmReturning(JSON.stringify(a), JSON.stringify(b))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      designTable(
        {
          rows: [
            { id: 'r1', shot_number: 'S1' },
            { id: 'r2', shot_number: 'S2' },
          ],
        },
        ctx,
      ),
    )
    expect(Object.keys(result)).toEqual(['r1', 'r2'])
    expect(result.r1!.bgm).toBe('A bgm')
    expect(result.r2!.bgm).toBe('B bgm')
  })

  it("continues the batch when one row's LLM call fails (errors logged, not thrown)", async () => {
    const { llm } = llmReturning('not json', JSON.stringify(sampleBrief))
    const logs: string[] = []
    const ctx = createMemoryContext({ llm, log: (m) => logs.push(m) })
    const result = await driveAuto(
      designTable(
        {
          rows: [
            { id: 'r1', shot_number: 'S1' },
            { id: 'r2', shot_number: 'S2' },
          ],
        },
        ctx,
      ),
    )
    expect(result.r1).toBeUndefined()
    expect(result.r2).toBeDefined()
    expect(logs.some((m) => m.includes('S1') && m.includes('failed'))).toBe(true)
  })
})
