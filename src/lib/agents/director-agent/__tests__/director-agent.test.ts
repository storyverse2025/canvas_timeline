import { describe, it, expect, vi, beforeEach } from 'vitest'

import { runCapability } from '@/lib/capabilities/client'
import {
  allocateShots,
  applyTimelineFixes,
  buildBridgePromptText,
  buildKeyframePrompt,
  composeShots,
  critiqueTimeline,
  critiqueVideoConsistency,
  directorAgent,
  generateKeyframe,
  generateStoryboardTable,
  KEYFRAME_MODEL,
  KEYFRAME_PROVIDER,
  proposeBridgeRow,
} from '@/lib/agents/director-agent'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { driveAuto } from '@/lib/agents/_shared/runtime/runner'
import type { LLM } from '@/lib/agents/_shared/llm/types'

vi.mock('@/lib/capabilities/client', () => ({ runCapability: vi.fn() }))
const mockedRunCapability = vi.mocked(runCapability)

function llmReturning(...responses: string[]): { llm: LLM; spy: ReturnType<typeof vi.fn> } {
  let i = 0
  const spy = vi.fn(async () => {
    const r = responses[i] ?? ''
    i++
    return r
  })
  return { llm: { complete: spy }, spy }
}

describe('director-agent: meta', () => {
  it('exposes the verbs on the module export', () => {
    expect(directorAgent.allocateShots).toBe(allocateShots)
    expect(directorAgent.composeShots).toBe(composeShots)
    expect(directorAgent.generateStoryboardTable).toBe(generateStoryboardTable)
    expect(directorAgent.critiqueTimeline).toBe(critiqueTimeline)
    expect(directorAgent.applyTimelineFixes).toBe(applyTimelineFixes)
    expect(directorAgent.generateKeyframe).toBe(generateKeyframe)
    expect(directorAgent.critiqueVideoConsistency).toBe(critiqueVideoConsistency)
    expect(directorAgent.proposeBridgeRow).toBe(proposeBridgeRow)
    expect(directorAgent.meta.name).toBe('director-agent')
  })

  it('pins keyframe to TokenRouter (the only image backend; never direct OpenAI)', () => {
    expect(KEYFRAME_PROVIDER).toBe('tokenrouter')
    expect(KEYFRAME_MODEL).toBe('openai/gpt-5.4-image-2')
  })
})

describe('allocateShots', () => {
  it('embeds total duration into the prompt as a hard constraint', async () => {
    const { llm, spy } = llmReturning('shot plan text')
    const ctx = createMemoryContext({ llm })
    const out = await driveAuto(
      allocateShots(
        { scriptAnalysis: 'SCRIPT', visualStrategy: 'STRAT', totalDurationSeconds: 45, revisedScript: 'REV' },
        ctx,
      ),
    )
    expect(out).toBe('shot plan text')
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('总时长 = 45 秒')
    expect(sent).toContain('∈ [2, 15]')
  })
})

describe('composeShots', () => {
  it('feeds prior allocation + anchor into the prompt', async () => {
    const { llm, spy } = llmReturning('composition design')
    const ctx = createMemoryContext({ llm })
    const out = await driveAuto(
      composeShots({ shotAllocation: 'ALLOC', visualAnchor: 'ANCHOR' }, ctx),
    )
    expect(out).toBe('composition design')
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('ALLOC')
    expect(sent).toContain('ANCHOR')
    expect(sent).toContain('180°')
  })
})

describe('generateStoryboardTable', () => {
  it('reaffirms the 2-15s per-row bound + total-duration sum lock in the prompt', async () => {
    const { llm, spy } = llmReturning('```json\n[]\n```')
    const ctx = createMemoryContext({ llm })
    await driveAuto(
      generateStoryboardTable(
        {
          artStyle: 'cinematic',
          totalDurationSeconds: 60,
          characterDesigns: '[]',
          sceneDesigns: '[]',
          propDesigns: '[]',
          shotAllocation: 'A',
          shotComposition: 'C',
          visualStrategy: 'S',
          elementContext: 'E',
          revisedScript: 'rev',
        },
        ctx,
      ),
    )
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('60 秒')
    expect(sent).toContain('2 ≤ duration ≤ 15')
    expect(sent).toContain('Σ duration == 60')
  })

  it('teaches the LLM the 1-scene + ≤2-character per-row cap and the split rule', async () => {
    const { llm, spy } = llmReturning('```json\n[]\n```')
    const ctx = createMemoryContext({ llm })
    await driveAuto(
      generateStoryboardTable(
        {
          artStyle: 'cinematic', totalDurationSeconds: 60,
          characterDesigns: '[]', sceneDesigns: '[]', propDesigns: '[]',
          shotAllocation: 'A', shotComposition: 'C', visualStrategy: 'S', elementContext: 'E',
          revisedScript: 'rev',
        },
        ctx,
      ),
    )
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('一个场景')
    expect(sent).toContain('至多两位主要角色')
    expect(sent).toContain('必须拆成多行')
    expect(sent).toContain('character1 + character2')
  })
})

describe('critiqueTimeline', () => {
  it('parses TimelineIssue[] from the LLM response', async () => {
    const { llm } = llmReturning('[{"shot":"S2","issue":"角色瞬移","fix":"补一个过渡镜头"}]')
    const ctx = createMemoryContext({ llm })
    const issues = await driveAuto(critiqueTimeline(
        { storyboardJson: '[]', artStyle: 'cinematic', characterNames: [], targetRowCount: 3, totalDurationSeconds: 30 },
        ctx,
      ))
    expect(issues).toEqual([{ shot: 'S2', issue: '角色瞬移', fix: '补一个过渡镜头' }])
  })

  it('returns an empty list when the model says clean', async () => {
    const { llm } = llmReturning('[]')
    const ctx = createMemoryContext({ llm })
    expect(
      await driveAuto(critiqueTimeline(
        { storyboardJson: '[]', artStyle: 'cinematic', characterNames: [], targetRowCount: 3, totalDurationSeconds: 30 },
        ctx,
      )),
    ).toEqual([])
  })

  it('drops malformed items rather than throwing', async () => {
    const { llm } = llmReturning('[{"shot":"S1","issue":"x","fix":"y"},{"shot":42}]')
    const ctx = createMemoryContext({ llm })
    const issues = await driveAuto(critiqueTimeline(
        { storyboardJson: '[]', artStyle: 'cinematic', characterNames: [], targetRowCount: 3, totalDurationSeconds: 30 },
        ctx,
      ))
    expect(issues).toHaveLength(1)
  })

  it('asks the critic to flag rows with 3+ characters or two scenes and propose a split', async () => {
    const { llm, spy } = llmReturning('[]')
    const ctx = createMemoryContext({ llm })
    await driveAuto(critiqueTimeline(
        { storyboardJson: '[]', artStyle: 'cinematic', characterNames: [], targetRowCount: 3, totalDurationSeconds: 30 },
        ctx,
      ))
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('每行 scene + character 人数上限')
    expect(sent).toContain('3 位以上主要角色')
    expect(sent).toContain('拆成多行')
  })
})

describe('applyTimelineFixes', () => {
  it('joins issues with numbered prefixes and locks the total-duration in the prompt', async () => {
    const { llm, spy } = llmReturning('```json\n[]\n```')
    const ctx = createMemoryContext({ llm })
    await driveAuto(
      applyTimelineFixes(
        {
          storyboardJson: '[]',
          issues: ['S3: 偏差 5s', 'S5: 时长 60s 过长 → 拆分'],
          totalDurationSeconds: 90,
        },
        ctx,
      ),
    )
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('1. S3: 偏差 5s')
    expect(sent).toContain('2. S5: 时长 60s 过长 → 拆分')
    expect(sent).toContain('总时长锁定为 90 秒')
    expect(sent).toContain('duration 必须 ∈ [2, 15] 秒')
  })

  it('preserves the 1-scene + ≤2-character per-row cap during the fix pass', async () => {
    const { llm, spy } = llmReturning('```json\n[]\n```')
    const ctx = createMemoryContext({ llm })
    await driveAuto(
      applyTimelineFixes(
        { storyboardJson: '[]', issues: ['S3: 角色过多'], totalDurationSeconds: 60 },
        ctx,
      ),
    )
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('每行 scene + character 人数上限')
    expect(sent).toContain('character1/character2')
  })
})

describe('generateKeyframe (Hollywood 6-module visual development board)', () => {
  beforeEach(() => mockedRunCapability.mockReset())

  it('builds a Hollywood-template prompt with all 6 modules + ordered image legend', () => {
    const prompt = buildKeyframePrompt({
      row: {
        storyboard_prompts: 'multi-panel director sheet of rooftop chase',
        visual_description: 'rooftop at dusk',
        shot_size: 'medium close-up',
        lighting_atmosphere: 'sodium street lamps spill',
        character_motivation: 'Alice protects the secret',
      },
      shotDurationSeconds: 8,
      projectTitle: '雨夜街角',
      projectType: '短剧单集',
      projectTone: '悬疑救赎',
      visualStyle: 'Cold-toned filmic noir',
      characters: [
        { name: 'Alice', description: 'short hair, grey trench', imageUrls: ['https://a.png'] },
        { name: 'Bob', description: 'rain jacket', imageUrls: ['https://b.png'] },
      ],
      scene: { name: 'Rooftop', description: 'wet concrete + neon', imageUrls: ['https://s.png'] },
      props: [{ name: 'Pocketwatch', description: 'silver', imageUrls: ['https://p.png'] }],
    })

    // Header / module banner.
    expect(prompt).toContain('Hollywood industrial-standard visual development board')
    expect(prompt).toContain('4K ultra-high definition')
    // 6 modules titled by number (Dual protagonist with 2 characters supplied).
    expect(prompt).toContain('Layout (6 modules')
    expect(prompt).toMatch(/### 1\. TOP — Project info bar/)
    expect(prompt).toMatch(/### 2\. TOP-LEFT — Dual protagonist character design column/)
    expect(prompt).toMatch(/### 3\. TOP-RIGHT — Core scene concept art/)
    expect(prompt).toMatch(/### 4\. MIDDLE — 3-shot storyboard sequence/)
    expect(prompt).toMatch(/### 5\. BOTTOM — Professional technical parameters/)
    expect(prompt).toMatch(/### 6\. QUALITY REQUIREMENTS/)
    // Project info propagated — TYPE / TONE / GENRE now appear as
    // prominent header lines (uppercased + bolded for the image model).
    expect(prompt).toContain('雨夜街角')
    expect(prompt).toContain('Shot duration: 8s')
    expect(prompt).toContain('**TYPE**: 短剧单集')
    expect(prompt).toContain('**TONE**: 悬疑救赎')
    expect(prompt).toContain('**GENRE**: 短剧单集 · 悬疑救赎')
    expect(prompt).toContain('Cold-toned filmic noir')
    // Character column. With scene-first ordering, scene is image1 so
    // characters shift to image2/image3.
    expect(prompt).toContain('Character 1: Alice — short hair, grey trench (see image2 for canonical look)')
    expect(prompt).toContain('Character 2: Bob — rain jacket (see image3 for canonical look)')
    expect(prompt).toContain('100% consistent character design across views')
    // Scene block.
    expect(prompt).toContain('Rooftop — wet concrete + neon')
    // Storyboard sequence pulls in row.storyboard_prompts.
    expect(prompt).toContain('multi-panel director sheet of rooftop chase')
    // Image legend in stable order — Scene FIRST as primary style anchor.
    expect(prompt).toContain('image1 = Scene — Rooftop')
    expect(prompt).toContain('image2 = Character — Alice')
    expect(prompt).toContain('image3 = Character — Bob')
    expect(prompt).toContain('image4 = Prop — Pocketwatch')
    // SEEDANCE compatibility note.
    expect(prompt).toContain('SEEDANCE 2.0 video generation pipeline')
  })

  it('legend image numbers put Scene FIRST (image1), regardless of character count', () => {
    // User contract: scene is always image1 when present, because
    // background/lighting/world is the strongest style anchor for the
    // image model. Characters and props follow. See
    // collectOrderedRefs() in director-agent/index.ts for rationale.
    const prompt = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [
        { name: 'C1', imageUrls: ['https://c1.png'] },
        { name: 'C2', imageUrls: ['https://c2.png'] },
      ],
      scene: { name: 'SC', imageUrls: ['https://sc.png'] },
      props: [
        { name: 'P1', imageUrls: ['https://p1.png'] },
        { name: 'P2', imageUrls: ['https://p2.png'] },
      ],
      refs: [{ role: '参考 / Prior reference', imageUrl: 'https://prior.png' }],
    })

    // Pull all legend lines in document order and assert exact sequence.
    const legend = prompt.split('\n').filter((l) => /^- image\d+ =/.test(l))
    expect(legend).toEqual([
      '- image1 = Scene — SC',
      '- image2 = Character — C1',
      '- image3 = Character — C2',
      '- image4 = Prop — P1',
      '- image5 = Prop — P2',
      '- image6 = 参考 / Prior reference',
    ])
  })

  it('when scene is omitted, characters take image1+ (numbering compresses naturally)', () => {
    const prompt = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'Solo', imageUrls: ['https://solo.png'] }],
      props: [{ name: 'P1', imageUrls: ['https://p1.png'] }],
    })
    const legend = prompt.split('\n').filter((l) => /^- image\d+ =/.test(l))
    expect(legend).toEqual([
      '- image1 = Character — Solo',
      '- image2 = Prop — P1',
    ])
  })

  it('drops the character module entirely when no character refs are supplied (landscape / object shot)', () => {
    const prompt = buildKeyframePrompt({
      row: { storyboard_prompts: 'wide rooftop establishing shot' },
      shotDurationSeconds: 5,
      scene: { name: 'Rooftop', description: 'wet concrete + neon' },
    })
    // Layout now declares 5 modules instead of 6.
    expect(prompt).toContain('Layout (5 modules')
    // The character module heading is replaced with an explicit NOTE.
    expect(prompt).not.toMatch(/TOP-LEFT — .* character design column/)
    expect(prompt).toContain('NOTE — No character design column')
    expect(prompt).toContain('Do NOT render any character figures')
    // Scene module moves to TOP (wide) since no character column.
    expect(prompt).toMatch(/TOP \(wide\) — Core scene concept art/)
    // No "see imageN" character hints, no character_motivation in tech params.
    expect(prompt).not.toContain('Character 1:')
    expect(prompt).not.toContain('image1 =')
  })

  it('appends the 3DCG-stylization clause when stylizeFacesFor2D is set (Seedance privacy retry)', () => {
    const baseline = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
    })
    expect(baseline).not.toContain('3DCG STYLIZATION')

    const stylized = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      stylizeFacesFor2D: true,
    })
    expect(stylized).toContain('3DCG STYLIZATION (privacy retry)')
    expect(stylized).toContain('把原来人物脸部3DCG风格化')
    expect(stylized).toContain('尽量保持面部细节')
    expect(stylized).toContain('避免系统误认真人')
    expect(stylized).toContain('其他地方保持原来美术风格')
    // Composition / palette / lighting must be preserved across the retry.
    expect(stylized).toContain('Composition, palette, lighting, props')
  })

  it('labels the character module per actual count (1 / 2 / 3+)', () => {
    const solo = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'Alice' }],
    })
    expect(solo).toContain('TOP-LEFT — Single-character character design column')

    const duo = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'Alice' }, { name: 'Bob' }],
    })
    expect(duo).toContain('TOP-LEFT — Dual protagonist character design column')

    const trio = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    })
    expect(trio).toContain('TOP-LEFT — 3-character ensemble character design column')

    const ensemble = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }],
    })
    expect(ensemble).toContain('TOP-LEFT — 5-character ensemble character design column')
    // Every character gets its own design line — no slicing to first 2.
    expect(ensemble).toContain('Character 5: E')
  })

  it('throws when row lacks both storyboard_prompts and visual_description', async () => {
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(generateKeyframe({ row: {}, shotDurationSeconds: 5 }, ctx)),
    ).rejects.toThrow(/storyboard_prompts or visual_description/)
  })

  it('routes the capability call to TokenRouter (openai/gpt-5.4-image-2) with 4K + HD quality at 16:9 by default', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://kf.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateKeyframe(
        {
          row: { storyboard_prompts: 'p' },
          shotDurationSeconds: 6,
          characters: [{ name: 'Alice', imageUrls: ['https://a.png'] }],
          scene: { name: 'Rooftop', imageUrls: ['https://s.png'] },
        },
        ctx,
      ),
    )
    expect(result.url).toBe('https://kf.png')
    expect(result.imageRefs.map((r) => r.role)).toEqual([
      // Scene FIRST as primary style anchor; characters follow.
      'Scene — Rooftop',
      'Character — Alice',
    ])
    const call = mockedRunCapability.mock.calls[0]![0]
    expect(call.capability).toBe('text-to-image')
    expect(call.params?.provider).toBe('tokenrouter')
    expect(call.params?.model).toBe('openai/gpt-5.4-image-2')
    expect(call.params?.aspect).toBe('16:9')
    expect(call.params?.quality).toBe('hd')
    expect(call.params?.resolution).toBe('4k')
    // 1 text + 2 image refs.
    expect(call.inputs.length).toBe(3)
  })

  it('respects a custom aspect ratio (e.g., vertical 9:16 for douyin)', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      generateKeyframe(
        { row: { storyboard_prompts: 'p' }, shotDurationSeconds: 4, aspect: '9:16' },
        ctx,
      ),
    )
    expect(mockedRunCapability.mock.calls[0]![0].params?.aspect).toBe('9:16')
  })

  it('throws when the capability returns no url', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(generateKeyframe({ row: { storyboard_prompts: 'p' }, shotDurationSeconds: 3 }, ctx)),
    ).rejects.toThrow(/no url/)
  })

  it('still appends legacy refs after structured ones', () => {
    const prompt = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'A', imageUrls: ['https://a.png'] }],
      refs: [{ role: 'PriorKeyframe', description: 'previous shot for style', imageUrl: 'https://prior.png' }],
    })
    expect(prompt).toContain('image1 = Character — A')
    expect(prompt).toContain('image2 = PriorKeyframe (previous shot for style)')
  })

  it('flattens multiple imageUrls per character into separate ordered inputs (three-view case)', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://kf.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateKeyframe(
        {
          row: { storyboard_prompts: 'p' },
          shotDurationSeconds: 6,
          characters: [
            {
              name: 'Alice',
              description: 'short hair, grey trench',
              imageUrls: [
                'https://a-front.png',
                'https://a-side.png',
                'https://a-back.png',
              ],
            },
          ],
          scene: {
            name: 'Rooftop',
            imageUrls: ['https://s-wide.png', 'https://s-closeup.png'],
          },
        },
        ctx,
      ),
    )
    // 3 character views + 2 scene angles + 1 text = 6 capability inputs.
    expect(result.imageRefs).toHaveLength(5)
    expect(mockedRunCapability.mock.calls[0]![0].inputs.length).toBe(6)
    // Legend numbers each image individually with (n/total) suffixes.
    // Scene FIRST, then the 3 character views.
    const prompt = mockedRunCapability.mock.calls[0]![0].inputs[0]!.text!
    expect(prompt).toContain('image1 = Scene — Rooftop (1/2)')
    expect(prompt).toContain('image2 = Scene — Rooftop (2/2)')
    expect(prompt).toContain('image3 = Character — Alice (1/3)')
    expect(prompt).toContain('image4 = Character — Alice (2/3)')
    expect(prompt).toContain('image5 = Character — Alice (3/3)')
    // The character column hint references all 3 indices.
    expect(prompt).toContain('see images 3, 4, 5 for canonical look — multiple views supplied')
  })
})

describe('critiqueVideoConsistency', () => {
  beforeEach(() => mockedRunCapability.mockReset())

  it('routes through storyboard-qc with video + keyframe + expected text', async () => {
    mockedRunCapability.mockResolvedValue({
      outputs: [
        {
          kind: 'text',
          text: '[{"aspect":"characters","severity":"major","summary":"角色服装不一致","fix":"重生成时增加 character refs"}]',
        },
      ],
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const issues = await driveAuto(
      critiqueVideoConsistency(
        {
          videoUrl: 'https://video.mp4',
          keyframeUrl: 'https://kf.png',
          expectedRow: { shot_number: 'S1', visual_description: '少年在雨夜', character_actions: '推门' },
        },
        ctx,
      ),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]!.aspect).toBe('characters')
    expect(issues[0]!.severity).toBe('major')
    const call = mockedRunCapability.mock.calls[0]![0]
    expect(call.capability).toBe('storyboard-qc')
    expect(call.inputs[0]).toEqual({ kind: 'video', url: 'https://video.mp4' })
    expect(call.inputs[1]).toEqual({ kind: 'image', url: 'https://kf.png' })
    expect((call.inputs[2]!.text as string)).toContain('少年在雨夜')
  })

  it('omits the keyframe input when none provided', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'text', text: '[]' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      critiqueVideoConsistency(
        { videoUrl: 'https://v.mp4', expectedRow: { shot_number: 'S2' } },
        ctx,
      ),
    )
    const call = mockedRunCapability.mock.calls[0]![0]
    expect(call.inputs.find((i) => i.kind === 'image')).toBeUndefined()
  })

  it('returns empty list when the model output is empty or malformed', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const issues = await driveAuto(
      critiqueVideoConsistency(
        { videoUrl: 'https://v.mp4', expectedRow: {} },
        ctx,
      ),
    )
    expect(issues).toEqual([])
  })
})

describe('proposeBridgeRow', () => {
  beforeEach(() => mockedRunCapability.mockReset())

  const baseReq = {
    prevRow: {
      shot_number: 'S3',
      duration: 4,
      visual_description: '阿莉躲进巷子，背靠墙急促喘息',
      character_actions: '靠墙喘息',
      emotion_mood: '紧张',
      character1_name: 'Alice',
      scene_name: '雨夜后巷',
    },
    nextRow: {
      shot_number: 'S4',
      duration: 5,
      visual_description: '阿莉坐在咖啡馆窗边，雨已停',
      character_actions: '搅咖啡',
      emotion_mood: '怅然',
      character1_name: 'Alice',
      scene_name: '咖啡馆',
    },
    projectType: '短剧单集',
    projectTone: '悬疑救赎',
    knownCharacterNames: ['Alice', 'Bob'],
    knownSceneNames: ['雨夜后巷', '咖啡馆', '过道'],
    knownPropNames: [],
  }

  it('builds a prompt with the JSON shape + judgement criteria + known assets', () => {
    const text = buildBridgePromptText(baseReq)
    expect(text).toContain('PREV（前一镜）')
    expect(text).toContain('NEXT（后一镜）')
    expect(text).toContain('阿莉躲进巷子')
    expect(text).toContain('阿莉坐在咖啡馆')
    expect(text).toContain('"needed": true/false')
    expect(text).toContain('"duration": 2-6')
    expect(text).toContain('"character1_name"')
    expect(text).toContain('Alice')
    expect(text).toContain('咖啡馆')
    expect(text).not.toContain('image1 =')
  })

  it('lists supplied frames in the image legend', () => {
    const text = buildBridgePromptText({
      ...baseReq,
      prevLastFrameUrl: 'data:image/jpeg;base64,xxxx',
      nextFirstFrameUrl: 'https://cdn/next.jpg',
    })
    expect(text).toContain('image1 = 前一镜的最后一帧')
    expect(text).toContain('image2 = 后一镜的第一帧')
  })

  it('routes to bridge-row-judge capability with text + (only the supplied) images', async () => {
    mockedRunCapability.mockResolvedValue({
      outputs: [{
        kind: 'text',
        text: JSON.stringify({
          needed: true,
          reason: '空间从巷子瞬移到咖啡馆，缺过渡',
          bridge: {
            shot_number: 'S3.5',
            duration: 3,
            visual_description: '阿莉沿湿漉漉的街道走向远处灯光',
            shot_size: '中景',
            character_actions: '步行',
            emotion_mood: '过渡',
            emotion_atmosphere: '雨停，街灯反光',
            lighting_atmosphere: '冷色街灯',
            storyboard_prompts: '中景，阿莉步行穿过湿街',
            motion_prompts: '镜头缓慢跟随',
            sound_effects: '远处雨声渐弱',
            dialogue: '',
            visual_anchor: '湿街反光',
            character1_name: 'Alice',
            character2_name: '',
            scene_name: '过道',
            prop1_name: '',
            prop2_name: '',
          },
        }),
      }],
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const judge = await driveAuto(
      proposeBridgeRow(
        { ...baseReq, prevLastFrameUrl: 'data:image/jpeg;base64,aaaa' },
        ctx,
      ),
    )
    expect(judge.needed).toBe(true)
    expect(judge.bridge?.shot_number).toBe('S3.5')
    expect(judge.bridge?.duration).toBe(3)
    expect(judge.bridge?.character1_name).toBe('Alice')
    expect(judge.bridge?.scene_name).toBe('过道')

    const call = mockedRunCapability.mock.calls[0]![0]
    expect(call.capability).toBe('bridge-row-judge')
    expect(call.inputs.length).toBe(2)
    expect(call.inputs[0]!.kind).toBe('text')
    expect(call.inputs[1]).toEqual({ kind: 'image', url: 'data:image/jpeg;base64,aaaa' })
  })

  it('returns needed=false when the model says clean', async () => {
    mockedRunCapability.mockResolvedValue({
      outputs: [{ kind: 'text', text: '{"needed": false, "reason": "hard cut 合理"}' }],
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const judge = await driveAuto(proposeBridgeRow(baseReq, ctx))
    expect(judge.needed).toBe(false)
    expect(judge.reason).toContain('hard cut')
    expect(judge.bridge).toBeUndefined()
  })

  it('parses fenced ```json blocks', async () => {
    mockedRunCapability.mockResolvedValue({
      outputs: [{
        kind: 'text',
        text: '```json\n{"needed": true, "reason": "x", "bridge": {"shot_number": "S3.5", "duration": 3, "visual_description": "v"}}\n```',
      }],
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const judge = await driveAuto(proposeBridgeRow(baseReq, ctx))
    expect(judge.needed).toBe(true)
    expect(judge.bridge?.duration).toBe(3)
    expect(judge.bridge?.visual_description).toBe('v')
  })

  it('degrades to needed=false when the response is unparseable', async () => {
    mockedRunCapability.mockResolvedValue({
      outputs: [{ kind: 'text', text: 'not json at all' }],
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const judge = await driveAuto(proposeBridgeRow(baseReq, ctx))
    expect(judge.needed).toBe(false)
    expect(judge.reason).toContain('无法解析')
  })
})
