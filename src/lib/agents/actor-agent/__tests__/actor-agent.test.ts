import { describe, it, expect, vi } from 'vitest'

import {
  actorAgent,
  attachVoiceRefs,
  buildCastVoicesPrompt,
  buildDesignCharactersPrompt,
  buildEnrichRowPrompt,
  cardsForRow,
  castVoices,
  composePillarsIntoPrompt,
  designCharacters,
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

  it('cast-voices prompt names the 4 indices the LLM should match against (biography + displayName/basename + sampleSnippet + tags)', () => {
    const prompt = buildCastVoicesPrompt({
      cards,
      candidates: [...candidatesPerCard.林清, ...candidatesPerCard.阿澈],
      creativeBrief: { tone: '悬疑' },
    })
    expect(prompt).toContain('biography')
    expect(prompt).toContain('displayName')
    expect(prompt).toContain('basename')
    expect(prompt).toContain('sampleSnippet')
    expect(prompt).toContain('tags')
    // 4-bucket vocabulary surfaced to the LLM so the prefilter labels make sense.
    expect(prompt).toContain('幼儿')
    expect(prompt).toContain('少年')
    expect(prompt).toContain('中年')
    expect(prompt).toContain('老年')
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
    expect(result.videoPrompt).toContain('音色1 = 林清')
    expect(result.videoPrompt).toContain('音色2 = 阿澈')
    expect(result.videoPrompt).toContain('"不要回头。"')
    expect(result.videoPrompt).toContain('"一直走，别停。"')
    // URLs now travel as separate audio inputs (Seedance audio_url parts),
    // not inlined into the prompt text. Verify via voiceAudioUrls instead.
    expect(result.videoPrompt).not.toContain('/voices/A.mp3')
    expect(result.voiceAudioUrls).toEqual(['/voices/A.mp3', '/voices/C.mp3'])
    expect(result.attached.map((a) => a.character)).toEqual(['林清', '阿澈'])
    expect(result.attached.map((a) => a.slot)).toEqual([1, 2])
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

describe('designCharacters', () => {
  const extracted = [
    { name: '林清', gender: 'female', appearance: '', clothing: '', expression: '', image_prompt: 'bland' },
    { name: '陆判', gender: 'male', appearance: '', clothing: '', expression: '', image_prompt: 'bland villain' },
  ]
  const castingCards = [
    { name: '林清', dramatic_function: '保护者', personality_layers: '冷静克制' },
    { name: '陆判', dramatic_function: '阴鸷反派', personality_layers: '城府深沉' },
  ]
  const designSample = [
    {
      name: '林清',
      biography: '林清出生于沿海雾港一户医师之家，十二岁那年她目睹父亲为庇护避难者被海上巡警带走，从此学会沉默与隐藏。少年时她在码头工坊学修理钟表，掌握了让自己消失在日常细节里的本能。后来她为一个反抗者网络递送情报，每次都靠那只父亲留下的银怀表抵御恐惧。这次任务里她终于决定不再只递送，而是要带阿澈走出去——她心里清楚，做出这一步，自己回不去原先那个隐身在人群中的林清了。',
      appearance_pillars: {
        subject: '亚洲女性，30 岁上下，半身正面，视线略偏向镜头左侧，肩颈以下隐入码头夜色',
        bone_structure: '窄鹅蛋脸，下颌角弱化，下巴尖；额头中等饱满，太阳穴轻微内收',
        features: '深灰棕平眉，长杏眼带凤眼感，细直秀气鼻，中薄唇',
        expression: '视线冷静克制，瞳孔聚焦但不咄咄逼人，嘴角自然平直微收',
        texture_light: '冷白皮雾面妆，黑色长发中分；冷光定向补光，背景压暗虚化',
        quality: 'Rendering style: Cold-toned filmic noir',
        anti_ai: '不做磨皮水光肌；不做夸张笑容',
      },
      appearance_prompt: 'composed-prompt-林清-very-long-string-for-image-model-' + 'x'.repeat(200),
    },
    {
      name: '陆判',
      biography: '陆判幼年丧母，被舅父收养于钱庄。账房先生发现他算账过目不忘，把他送进权钱场。二十岁那年他亲眼看着曾经救他出火的恩师被同僚以诈骗罪推下水，他在审讯室门外站了一整夜没说一句话。后来他成了那种"什么都听着、什么都记着、什么都不流露"的角色——别人犯错就在他档案里多一行。这次他盯上的是林清的网络，因为她父亲三十年前的旧案里有一笔他至今没算清的账。',
      appearance_pillars: {
        subject: '亚洲男性，45 岁上下，半身正面，肩颈微僵直；背景为雾港夜色',
        bone_structure: '长方脸收紧，颧骨内收偏窄，太阳穴明显凹陷；下颌角清晰偏锐，下巴尖',
        features: '一字眉偏低，长凤眼但内眦角度极锐；山根高直鼻梁窄；薄唇嘴角微微下垂；左眉骨上一道极淡旧伤',
        expression: '凝视过久，眨眼极慢；嘴角向斜上方扯出几乎不可察的弧度，但眼睛纹丝不动',
        texture_light: '皮肤偏蜡黄哑光，下睑泪沟深陷；黑色后梳短发，墨绿哑光呢西装；硬侧光从右下打来制造眼窝阴影；色温偏冷',
        quality: 'Rendering style: Cold-toned filmic noir',
        anti_ai: '不做漫画式邪笑/狞笑/狰狞；不做美型反派模板；不做眼睛发红或瞳孔变形；保留一处让人本能戒备的违和（颧骨过窄+泪沟深陷）',
      },
      appearance_prompt: 'composed-prompt-陆判-very-long-string-for-image-model-' + 'x'.repeat(200),
    },
  ]

  it('buildDesignCharactersPrompt embeds extraction + cards + brief + style', () => {
    const prompt = buildDesignCharactersPrompt({
      extractedCharacters: extracted,
      castingCards,
      creativeBrief: { tone: '悬疑' },
      visualStyle: 'Cold-toned filmic noir',
    })
    expect(prompt).toContain('林清')
    expect(prompt).toContain('陆判')
    expect(prompt).toContain('保护者')
    expect(prompt).toContain('阴鸷反派')
    expect(prompt).toContain('Cold-toned filmic noir')
    expect(prompt).toContain('7 个 pillars')
  })

  it('returns biography + appearance_pillars + appearance_prompt per character', async () => {
    const { llm } = llmReturning(JSON.stringify(designSample))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      designCharacters({ extractedCharacters: extracted, castingCards }, ctx),
    )
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('林清')
    expect(result[0]!.biography.length).toBeGreaterThan(40)
    // anti_ai is now per-character — the fixture for 林清 picked 磨皮 / 夸张笑容.
    expect(result[0]!.appearance_pillars.anti_ai).toContain('磨皮')
    expect(result[1]!.appearance_pillars.bone_structure).toContain('长方')
  })

  it('recomposes appearance_prompt from pillars when the LLM returned a too-short one', async () => {
    const compressed = [{ ...designSample[0]!, appearance_prompt: 'too short' }]
    const { llm } = llmReturning(JSON.stringify(compressed))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      designCharacters({ extractedCharacters: [extracted[0]!], castingCards: [castingCards[0]!] }, ctx),
    )
    // Recomposed prompt must include pillar content + end on the anti_ai line
    // (the role-targeted negative directives, no longer the canned 不做网红脸 list).
    expect(result[0]!.appearance_prompt).toContain('窄鹅蛋')
    expect(result[0]!.appearance_prompt).toContain('磨皮')
    const lastLine = result[0]!.appearance_prompt.trim().split(/\n+/).pop() ?? ''
    expect(lastLine).toContain('不做')
  })

  it('logs missing characters when the LLM skips some', async () => {
    const onlyOne = [designSample[0]!]
    const { llm } = llmReturning(JSON.stringify(onlyOne))
    const logs: string[] = []
    const ctx = createMemoryContext({ llm, log: (m) => logs.push(m) })
    const result = await driveAuto(
      designCharacters({ extractedCharacters: extracted, castingCards }, ctx),
    )
    expect(result).toHaveLength(1)
    expect(logs.some((m) => m.includes('陆判') && m.includes('skipped'))).toBe(true)
  })

  it('short-circuits empty extractedCharacters', async () => {
    const { llm, spy } = llmReturning('SHOULD NOT BE CALLED')
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      designCharacters({ extractedCharacters: [], castingCards }, ctx),
    )
    expect(spy).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('throws on schema-violating JSON (missing required pillar)', async () => {
    const bad = [{
      name: '林清',
      biography: 'x'.repeat(100),
      appearance_pillars: {
        subject: 's', bone_structure: 'b', features: 'f', expression: 'e',
        texture_light: 't', quality: 'q',
        // anti_ai missing
      },
      appearance_prompt: 'x'.repeat(100),
    }]
    const { llm } = llmReturning(JSON.stringify(bad))
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(designCharacters({ extractedCharacters: [extracted[0]!], castingCards: [castingCards[0]!] }, ctx)),
    ).rejects.toThrow(/failed validation/)
  })

  it('composePillarsIntoPrompt puts anti_ai last', () => {
    const composed = composePillarsIntoPrompt(designSample[0]!.appearance_pillars)
    const lines = composed.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    expect(lines[lines.length - 1]).toBe(designSample[0]!.appearance_pillars.anti_ai)
  })
})
