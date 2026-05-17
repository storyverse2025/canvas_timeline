import { describe, it, expect, vi, beforeEach } from 'vitest'

import { runCapability } from '@/lib/capabilities/client'
import {
  allocateShots,
  applyTimelineFixes,
  buildKeyframePrompt,
  composeShots,
  critiqueTimeline,
  critiqueVideoConsistency,
  directorAgent,
  generateKeyframe,
  generateStoryboardTable,
  KEYFRAME_MODEL,
  KEYFRAME_PROVIDER,
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
  it('exposes the 7 verbs on the module export', () => {
    expect(directorAgent.allocateShots).toBe(allocateShots)
    expect(directorAgent.composeShots).toBe(composeShots)
    expect(directorAgent.generateStoryboardTable).toBe(generateStoryboardTable)
    expect(directorAgent.critiqueTimeline).toBe(critiqueTimeline)
    expect(directorAgent.applyTimelineFixes).toBe(applyTimelineFixes)
    expect(directorAgent.generateKeyframe).toBe(generateKeyframe)
    expect(directorAgent.critiqueVideoConsistency).toBe(critiqueVideoConsistency)
    expect(directorAgent.meta.name).toBe('director-agent')
  })

  it('pins keyframe to openai/gpt-image-2 (planning conversation contract)', () => {
    expect(KEYFRAME_PROVIDER).toBe('openai')
    expect(KEYFRAME_MODEL).toBe('gpt-image-2')
  })
})

describe('allocateShots', () => {
  it('embeds total duration into the prompt as a hard constraint', async () => {
    const { llm, spy } = llmReturning('shot plan text')
    const ctx = createMemoryContext({ llm })
    const out = await driveAuto(
      allocateShots(
        { scriptAnalysis: 'SCRIPT', visualStrategy: 'STRAT', totalDurationSeconds: 45 },
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
    const issues = await driveAuto(critiqueTimeline({ storyboardJson: '[]' }, ctx))
    expect(issues).toEqual([{ shot: 'S2', issue: '角色瞬移', fix: '补一个过渡镜头' }])
  })

  it('returns an empty list when the model says clean', async () => {
    const { llm } = llmReturning('[]')
    const ctx = createMemoryContext({ llm })
    expect(
      await driveAuto(critiqueTimeline({ storyboardJson: '[]' }, ctx)),
    ).toEqual([])
  })

  it('drops malformed items rather than throwing', async () => {
    const { llm } = llmReturning('[{"shot":"S1","issue":"x","fix":"y"},{"shot":42}]')
    const ctx = createMemoryContext({ llm })
    const issues = await driveAuto(critiqueTimeline({ storyboardJson: '[]' }, ctx))
    expect(issues).toHaveLength(1)
  })

  it('asks the critic to flag rows with 3+ characters or two scenes and propose a split', async () => {
    const { llm, spy } = llmReturning('[]')
    const ctx = createMemoryContext({ llm })
    await driveAuto(critiqueTimeline({ storyboardJson: '[]' }, ctx))
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
    // Character column.
    expect(prompt).toContain('Character 1: Alice — short hair, grey trench (see image1 for canonical look)')
    expect(prompt).toContain('Character 2: Bob — rain jacket (see image2 for canonical look)')
    expect(prompt).toContain('100% consistent character design across views')
    // Scene block.
    expect(prompt).toContain('Rooftop — wet concrete + neon')
    // Storyboard sequence pulls in row.storyboard_prompts.
    expect(prompt).toContain('multi-panel director sheet of rooftop chase')
    // Image legend in stable order.
    expect(prompt).toContain('image1 = Character — Alice')
    expect(prompt).toContain('image2 = Character — Bob')
    expect(prompt).toContain('image3 = Scene — Rooftop')
    expect(prompt).toContain('image4 = Prop — Pocketwatch')
    // SEEDANCE compatibility note.
    expect(prompt).toContain('SEEDANCE 2.0 video generation pipeline')
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

  it('routes the capability call to openai/gpt-image-2 with 4K + HD quality at 16:9 by default', async () => {
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
      'Character — Alice',
      'Scene — Rooftop',
    ])
    const call = mockedRunCapability.mock.calls[0]![0]
    expect(call.capability).toBe('text-to-image')
    expect(call.params?.provider).toBe('openai')
    expect(call.params?.model).toBe('gpt-image-2')
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
    const prompt = mockedRunCapability.mock.calls[0]![0].inputs[0]!.text!
    expect(prompt).toContain('image1 = Character — Alice (1/3)')
    expect(prompt).toContain('image2 = Character — Alice (2/3)')
    expect(prompt).toContain('image3 = Character — Alice (3/3)')
    expect(prompt).toContain('image4 = Scene — Rooftop (1/2)')
    expect(prompt).toContain('image5 = Scene — Rooftop (2/2)')
    // The character column hint references all 3 indices.
    expect(prompt).toContain('see images 1, 2, 3 for canonical look — multiple views supplied')
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
