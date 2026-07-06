import { describe, it, expect, vi, beforeEach } from 'vitest'

import { runCapability } from '@/lib/capabilities/client'
import {
  allocateShots,
  applyTimelineFixes,
  buildBridgePromptText,
  buildCleanKeyframePrompt,
  buildIdentitySheetPrompt,
  isHighActionRow,
  isDanceRow,
  buildKeyframePrompt,
  collectIdentitySheetRefs,
  composeShots,
  critiqueTimeline,
  critiqueVideoConsistency,
  directorAgent,
  generateIdentitySheet,
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

  it('teaches the LLM the 1-scene + ≤6-character array per-row cap and the split rule', async () => {
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
    // Characters now live in a `characters` array, up to 6 per row (ensembles
    // like a K-pop group all ride in one row instead of being truncated to 2).
    expect(sent).toContain('`characters` 数组')
    expect(sent).toContain('至多 6')
    expect(sent).toContain('超过 6')
  })
})

describe('critiqueTimeline', () => {
  it('parses TimelineIssue[] from the LLM response', async () => {
    const { llm } = llmReturning('[{"shot":"S2","issue":"角色瞬移","fix":"补一个过渡镜头"}]')
    const ctx = createMemoryContext({ llm })
    const issues = await driveAuto(critiqueTimeline(
        { storyboardJson: '[]', artStyle: 'cinematic', characterNames: [], targetRowCount: 3, totalDurationSeconds: 30, userScript: 'USR', userClarifications: '' },
        ctx,
      ))
    expect(issues).toEqual([{ shot: 'S2', issue: '角色瞬移', fix: '补一个过渡镜头' }])
  })

  it('returns an empty list when the model says clean', async () => {
    const { llm } = llmReturning('[]')
    const ctx = createMemoryContext({ llm })
    expect(
      await driveAuto(critiqueTimeline(
        { storyboardJson: '[]', artStyle: 'cinematic', characterNames: [], targetRowCount: 3, totalDurationSeconds: 30, userScript: 'USR', userClarifications: '' },
        ctx,
      )),
    ).toEqual([])
  })

  it('drops malformed items rather than throwing', async () => {
    const { llm } = llmReturning('[{"shot":"S1","issue":"x","fix":"y"},{"shot":42}]')
    const ctx = createMemoryContext({ llm })
    const issues = await driveAuto(critiqueTimeline(
        { storyboardJson: '[]', artStyle: 'cinematic', characterNames: [], targetRowCount: 3, totalDurationSeconds: 30, userScript: 'USR', userClarifications: '' },
        ctx,
      ))
    expect(issues).toHaveLength(1)
  })

  it('asks the critic to flag rows with 3+ characters or two scenes and propose a split', async () => {
    const { llm, spy } = llmReturning('[]')
    const ctx = createMemoryContext({ llm })
    await driveAuto(critiqueTimeline(
        { storyboardJson: '[]', artStyle: 'cinematic', characterNames: [], targetRowCount: 3, totalDurationSeconds: 30, userScript: 'USR', userClarifications: '' },
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

  it('preserves the 1-scene + ≤6-character array per-row cap during the fix pass', async () => {
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
    expect(sent).toContain('`characters` 数组')
    expect(sent).toContain('至多 6 个')
  })
})

describe('generateKeyframe (slim diagrammatic storyboard sheet)', () => {
  beforeEach(() => { mockedRunCapability.mockReset() })

  it('builds a slim diagrammatic prompt: storyboard grid + conditional diagrams, no heavy text modules', () => {
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

    // Header reads as a B&W HAND-DRAWN director sheet (黑白手绘故事板).
    expect(prompt).toContain('HAND-DRAWN director storyboard sheet')
    expect(prompt).toContain('黑白手绘故事板')
    expect(prompt).toContain('Shot duration: 8s')
    expect(prompt).toContain('Cold-toned filmic noir')

    // Hard style constraint: B&W hand-drawn, photoreal banned (photoreal
    // storyboards break the downstream video step).
    expect(prompt).toMatch(/NO photorealistic/i)
    expect(prompt).toContain('黑白手绘')

    // Colored annotation arrow system: 橙=轮廓光方向, 红=人物动作, 蓝=摄影机运动.
    expect(prompt).toContain('橙色箭头')
    expect(prompt).toContain('轮廓光方向')
    expect(prompt).toContain('红色箭头')
    expect(prompt).toContain('人物动作')
    expect(prompt).toContain('蓝色箭头')
    expect(prompt).toContain('摄影机运动')
    // Exposure + camera moves must be planned into the sheet up front.
    expect(prompt).toContain('曝光与运镜必须提前写进规划')

    // Heavy text modules are GONE: no project info bar, no 3-view column,
    // no technical-param bottom row, no separate concept-art block.
    expect(prompt).not.toMatch(/Project info bar/)
    expect(prompt).not.toMatch(/character design column/i)
    expect(prompt).not.toContain('Professional technical parameters')
    expect(prompt).not.toContain('three-view')
    expect(prompt).not.toContain('Color palette')
    expect(prompt).not.toContain('Cinematography lens parameters')

    // Scene module: explicit 360° panorama crop instruction.
    expect(prompt).toContain('Scene reference (cropped from 360° panorama)')
    expect(prompt).toContain('360° equirectangular PANORAMA')
    expect(prompt).toContain('Do NOT render the whole panorama')
    expect(prompt).toContain('Rooftop — wet concrete + neon')

    // Storyboard grid is the primary content with per-panel time labels
    // AND the 主体/表情/场景/摄像机运动/灯光 annotation strip per panel.
    expect(prompt).toContain('Storyboard panel grid (primary content)')
    expect(prompt).toMatch(/TIME-SLICE LABEL at the top-left/)
    expect(prompt).toContain('sum to exactly 8s')
    expect(prompt).toContain('multi-panel director sheet of rooftop chase')
    expect(prompt).toContain('主体 (subject), 表情 (facial expression — 眼神/眉/嘴/下颌 tension), 场景 (scene), 摄像机运动 (camera move), 灯光 (lighting/exposure)')
    // Facial expression is a first-class panel element (fixes flat/出戏 faces).
    expect(prompt).toContain('FACIAL EXPRESSION is first-class')

    // Diagrams gated by inputs: 2 chars → height strip; 2 chars + 1 prop →
    // size diagram; ≥ 2 chars → spatial floor plan.
    expect(prompt).toContain('Character height comparison strip')
    expect(prompt).toContain('Character × prop relative-size diagram')
    expect(prompt).toContain('Spatial floor plan (top-down, numbered)')
    // Floor plan legend numbering: characters 1..N, props N+1..N+M.
    expect(prompt).toMatch(/1\. Alice/)
    expect(prompt).toMatch(/2\. Bob/)
    expect(prompt).toMatch(/3\. Pocketwatch/)

    // Image legend kept (Scene first as primary style anchor).
    expect(prompt).toContain('image1 = Scene — Rooftop')
    expect(prompt).toContain('image2 = Character — Alice')
    expect(prompt).toContain('image3 = Character — Bob')
    expect(prompt).toContain('image4 = Prop — Pocketwatch')

    // Seedance compatibility note in the slim quality bar.
    expect(prompt).toContain('SEEDANCE 2.0 downstream video pipeline')
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

  it('drops every character/prop diagram when no characters are supplied (pure landscape shot)', () => {
    const prompt = buildKeyframePrompt({
      row: { storyboard_prompts: 'wide rooftop establishing shot' },
      shotDurationSeconds: 5,
      scene: { name: 'Rooftop', description: 'wet concrete + neon' },
    })
    // Scene module still present, panorama-crop instruction still applies.
    expect(prompt).toContain('Scene reference (cropped from 360° panorama)')
    // Storyboard grid is the only required diagram — chars/props/spatial all gone.
    expect(prompt).toContain('Storyboard panel grid (primary content)')
    expect(prompt).not.toContain('Character height comparison strip')
    expect(prompt).not.toContain('Character × prop relative-size diagram')
    expect(prompt).not.toContain('Spatial floor plan')
  })

  it('emits only the spatial floor plan (not the height strip) when a single character has props', () => {
    const prompt = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'Solo' }],
      props: [{ name: 'Pocketwatch' }],
    })
    // Height strip requires ≥ 2 chars; not emitted here.
    expect(prompt).not.toContain('Character height comparison strip')
    // Size diagram is emitted (chars ≥ 1 AND props ≥ 1).
    expect(prompt).toContain('Character × prop relative-size diagram')
    expect(prompt).toContain('Size reference character: Solo')
    // Spatial plan is emitted (props trigger it even with single char).
    expect(prompt).toContain('Spatial floor plan (top-down, numbered)')
    expect(prompt).toMatch(/1\. Solo/)
    expect(prompt).toMatch(/2\. Pocketwatch/)
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

  it('emits height comparison strip and spatial floor plan only when ≥ 2 characters', () => {
    const solo = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'Alice' }],
    })
    expect(solo).not.toContain('Character height comparison strip')
    expect(solo).not.toContain('Spatial floor plan')

    const duo = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'Alice' }, { name: 'Bob' }],
    })
    expect(duo).toContain('Character height comparison strip')
    expect(duo).toContain('Spatial floor plan (top-down, numbered)')
    expect(duo).toMatch(/1\. Alice/)
    expect(duo).toMatch(/2\. Bob/)

    const ensemble = buildKeyframePrompt({
      row: { storyboard_prompts: 'p' },
      shotDurationSeconds: 5,
      characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }],
    })
    // Height strip lists every character left-to-right.
    expect(ensemble).toContain('Character height comparison strip')
    expect(ensemble).toMatch(/1\. A/)
    expect(ensemble).toMatch(/5\. E/)
  })

  it('throws when row lacks both storyboard_prompts and visual_description', async () => {
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(generateKeyframe({ row: {}, shotDurationSeconds: 5 }, ctx)),
    ).rejects.toThrow(/storyboard_prompts or visual_description/)
  })

  it('routes the capability call to TokenRouter (openai/gpt-5.4-image-2) with 4K + HD quality at 16:9 by default', async () => {
    mockedRunCapability.mockImplementation(async (req) =>
      req.capability === 'freeform-text'
        ? { outputs: [{ kind: 'text' as const, text: '' }] }
        : { outputs: [{ kind: 'image' as const, url: 'https://kf.png' }] })
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
    // Call 0 is the freeform-text derive pass (结构模板+参考图+主题 →
    // 黑白手绘故事板提示词); it receives the same ordered ref images.
    const derive = mockedRunCapability.mock.calls[0]![0]
    expect(derive.capability).toBe('freeform-text')
    expect(derive.inputs.filter((i) => i.kind === 'image').length).toBe(2)
    const call = mockedRunCapability.mock.calls[1]![0]
    expect(call.capability).toBe('text-to-image')
    expect(call.params?.provider).toBe('tokenrouter')
    expect(call.params?.model).toBe('openai/gpt-5.4-image-2')
    expect(call.params?.aspect).toBe('16:9')
    expect(call.params?.quality).toBe('hd')
    expect(call.params?.resolution).toBe('4k')
    // 1 text + 2 image refs.
    expect(call.inputs.length).toBe(3)
  })

  it('uses the LLM-derived storyboard prompt when the derive pass returns a substantial text', async () => {
    const derived = `黑白手绘故事板：${'格1 主体/场景/运镜/灯光；橙色轮廓光箭头，红色动作箭头，蓝色运镜箭头。'.repeat(8)}`
    mockedRunCapability.mockImplementation(async (req) =>
      req.capability === 'freeform-text'
        ? { outputs: [{ kind: 'text' as const, text: derived }] }
        : { outputs: [{ kind: 'image' as const, url: 'https://kf.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateKeyframe(
        { row: { storyboard_prompts: 'p' }, shotDurationSeconds: 5 },
        ctx,
      ),
    )
    expect(result.promptDerived).toBe(true)
    expect(result.prompt).toBe(derived)
    // The grid render (first text-to-image call) uses the derived prompt.
    const t2i = mockedRunCapability.mock.calls.find(([r]) => r.capability === 'text-to-image')![0]
    expect((t2i.inputs[0] as { text: string }).text).toBe(derived)
  })

  it('falls back to the structure template when the derive pass fails or returns a stub', async () => {
    mockedRunCapability.mockImplementation(async (req) =>
      req.capability === 'freeform-text'
        ? { outputs: [{ kind: 'text' as const, text: '太短' }] } // < 200 chars → rejected
        : { outputs: [{ kind: 'image' as const, url: 'https://kf.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateKeyframe(
        { row: { storyboard_prompts: 'p' }, shotDurationSeconds: 5 },
        ctx,
      ),
    )
    expect(result.promptDerived).toBe(false)
    expect(result.prompt).toContain('HAND-DRAWN director storyboard sheet')
  })

  it('respects a custom aspect ratio (e.g., vertical 9:16 for douyin)', async () => {
    mockedRunCapability.mockImplementation(async (req) =>
      req.capability === 'freeform-text'
        ? { outputs: [{ kind: 'text' as const, text: '' }] }
        : { outputs: [{ kind: 'image' as const, url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      generateKeyframe(
        { row: { storyboard_prompts: 'p' }, shotDurationSeconds: 4, aspect: '9:16' },
        ctx,
      ),
    )
    const t2i = mockedRunCapability.mock.calls.find(([r]) => r.capability === 'text-to-image')![0]
    expect(t2i.params?.aspect).toBe('9:16')
  })

  it('throws when the capability returns no url', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(generateKeyframe({ row: { storyboard_prompts: 'p' }, shotDurationSeconds: 3 }, ctx)),
    ).rejects.toThrow(/no url/)
  })

  it('dual-keyframe: renders 故事板 then 开场构图 sequentially (clean references the grid) and returns both URLs', async () => {
    let t2i = 0
    mockedRunCapability.mockImplementation(async (req) => {
      if (req.capability === 'freeform-text') return { outputs: [{ kind: 'text' as const, text: '' }] }
      t2i += 1
      return { outputs: [{ kind: 'image' as const, url: `https://kf-${t2i}.png` }] }
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateKeyframe(
        {
          row: { storyboard_prompts: 'p', visual_description: 'rooftop' },
          shotDurationSeconds: 5,
          characters: [{ name: 'A', imageUrls: ['https://a.png'] }],
        },
        ctx,
      ),
    )
    // Three capability calls: derive (freeform-text) + grid + clean t2i —
    // grid FIRST, then clean referencing it (身份版→故事板→开场构图 chain).
    expect(mockedRunCapability).toHaveBeenCalledTimes(3)
    expect(result.url).toBe('https://kf-1.png')
    expect(result.cleanUrl).toBe('https://kf-2.png')
    expect(result.cleanPrompt).toBeTruthy()
    expect(result.gridFailReason).toBeUndefined()
    const t2iCalls = mockedRunCapability.mock.calls.filter(([r]) => r.capability === 'text-to-image')
    // First t2i call carries the grid prompt (multi-panel sheet).
    const gridCallPrompt = (t2iCalls[0]![0].inputs[0] as { text: string }).text
    expect(gridCallPrompt).toMatch(/Storyboard panel grid/i)
    // Second t2i call carries the clean prompt — its 开场构图 must render
    // the storyboard's FIRST panel, so the freshly-rendered grid ships as
    // an extra ref image and the Composition block anchors to 第1格.
    const cleanCall = t2iCalls[1]![0]
    const cleanCallPrompt = (cleanCall.inputs[0] as { text: string }).text
    expect(cleanCallPrompt).toMatch(/开场构图|OPENING FRAME/)
    expect(cleanCallPrompt).toContain('第1格')
    expect(cleanCallPrompt).not.toMatch(/Storyboard panel grid/i)
    const cleanImageUrls = cleanCall.inputs.filter((i) => i.kind === 'image').map((i) => (i as { url: string }).url)
    expect(cleanImageUrls).toContain('https://kf-1.png') // the grid rides as 构图参考
  })

  it('dual-keyframe: falls back to grid url when clean call fails (on both backends)', async () => {
    // Fail by prompt content so BOTH the primary + nano-banana fallback
    // attempts for the clean call throw — otherwise the fallback would
    // silently rescue it and cleanUrl would not be undefined.
    mockedRunCapability.mockImplementation(async (req) => {
      if (req.capability === 'freeform-text') return { outputs: [{ kind: 'text' as const, text: '' }] }
      const prompt = (req.inputs[0] as { text?: string }).text ?? ''
      if (/开场构图|OPENING FRAME/.test(prompt)) throw new Error('content policy')
      return { outputs: [{ kind: 'image' as const, url: 'https://grid.png' }] }
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateKeyframe(
        { row: { storyboard_prompts: 'p' }, shotDurationSeconds: 5 },
        ctx,
      ),
    )
    expect(result.url).toBe('https://grid.png')
    expect(result.cleanUrl).toBeUndefined()
    expect(result.cleanPrompt).toBeUndefined()
    expect(result.gridFailReason).toBeUndefined()
  })

  it('dual-keyframe: falls back to clean url when grid call fails — and flags gridFailReason so callers do not store the clean frame as a 故事板', async () => {
    // Grid fails on BOTH backends (matched by prompt); clean succeeds.
    mockedRunCapability.mockImplementation(async (req) => {
      if (req.capability === 'freeform-text') return { outputs: [{ kind: 'text' as const, text: '' }] }
      const prompt = (req.inputs[0] as { text?: string }).text ?? ''
      if (/Storyboard panel grid/i.test(prompt)) throw new Error('content policy')
      return { outputs: [{ kind: 'image' as const, url: 'https://clean.png' }] }
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateKeyframe(
        { row: { storyboard_prompts: 'p' }, shotDurationSeconds: 5 },
        ctx,
      ),
    )
    expect(result.url).toBe('https://clean.png')
    expect(result.cleanUrl).toBe('https://clean.png')
    // Regression: url === cleanUrl here. Without gridFailReason the caller
    // wrote the clean frame into BOTH keyframeUrl and keyframeCleanUrl —
    // 黑白故事板 and 开场构图 columns silently showed the same image.
    expect(result.gridFailReason).toBe('content policy')
  })

  it('buildCleanKeyframePrompt: explicitly bans panel borders + grid + time labels', () => {
    const prompt = buildCleanKeyframePrompt({
      row: { storyboard_prompts: 'rooftop chase', visual_description: 'rooftop at dusk' },
      shotDurationSeconds: 5,
      characters: [{ name: 'Alice', imageUrls: ['https://a.png'] }],
    })
    expect(prompt).toMatch(/NO panel borders/)
    expect(prompt).toMatch(/NO panel grid/)
    expect(prompt).toMatch(/NO time-slice labels/)
    expect(prompt).toMatch(/ONE continuous cinematic frame/i)
    // Reuses same character ref legend → cinematographer gets a consistent
    // omni-reference matching the grid's casting.
    expect(prompt).toMatch(/image1 = Character — Alice/)
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
  })
})

describe('storyboard grid panel count (25格 for high-action shots)', () => {
  it('fight/chase rows get a fixed 25-panel grid with fast micro-beat pacing', () => {
    const prompt = buildKeyframePrompt({
      row: {
        character_actions: '沈玦挥剑格挡，墨渊锁链反击，二人在断桥交锋',
        visual_description: '暴雪断桥双人打斗',
        storyboard_prompts: 'duel on broken bridge',
      },
      shotDurationSeconds: 10,
    })
    expect(prompt).toContain('25-panel grid（25格，5 columns × 5 rows）')
    expect(prompt).toContain('HIGH-INTENSITY ACTION')
    // ≈0.40s per panel for a 10s shot; fast cutting, real weapon-clash rhythm.
    expect(prompt).toContain('≈ 0.40s')
    expect(prompt).toContain('打击定格')
    // Fight must read as a two-fighter exchange with multiple reversals + collisions.
    expect(prompt).toContain('TWO-FIGHTER EXCHANGE')
    expect(prompt).toContain('≥4 力量反转')
    expect(prompt).toContain('兵器碰撞')
    // Blogger fight camera-language folded in.
    expect(prompt).toContain('六要素')
    expect(prompt).toContain('匹配剪辑')
    expect(prompt).toContain('定格-加速-定格')
    expect(prompt).not.toContain('choose 3–6 panels')
    // Time labels still must sum to the shot duration.
    expect(prompt).toContain('sum to exactly 10s')
  })

  it('high-action rows override a pre-baked 3-panel plan stored in storyboard_prompts', () => {
    const prompt = buildKeyframePrompt({
      row: {
        character_actions: '二人挥剑交锋，锁链缠斗',
        storyboard_prompts: 'Panel 1 (0s): MCU blade clash. Panel 2 (5s): mid shot. Panel 3 (10s): wide.',
      },
      shotDurationSeconds: 10,
    })
    // The baked "Panel 1/2/3" guidance is present but explicitly overridden.
    expect(prompt).toContain('覆盖预烤格数')
    expect(prompt).toContain('忽略它的格数')
  })

  it('calm rows do NOT get the override note even if guidance mentions panels', () => {
    const prompt = buildKeyframePrompt({
      row: {
        character_actions: '两人对坐轻声交谈',
        storyboard_prompts: 'Panel 1: close-up. Panel 2: two-shot.',
      },
      shotDurationSeconds: 9,
    })
    expect(prompt).not.toContain('覆盖预烤格数')
  })

  it('calm dialogue rows keep the 3–6 panel rule', () => {
    const prompt = buildKeyframePrompt({
      row: {
        character_actions: '两人靠在床头轻声交谈，她把头埋进他肩窝',
        visual_description: '深夜卧室暖光对话',
      },
      shotDurationSeconds: 9,
    })
    expect(prompt).toContain('choose 3–6 panels')
    expect(prompt).not.toContain('25-panel grid')
  })

  it('isHighActionRow keys off action-bearing fields', () => {
    expect(isHighActionRow({ motion_prompts: 'fast dolly as they clash swords' })).toBe(true)
    expect(isHighActionRow({ character_actions: '她安静地画画' })).toBe(false)
  })
})

describe('storyboard grid panel count (16格 for dance / 群舞 shots)', () => {
  it('dance rows get a fixed 16-panel (4×4) 漫画式分镜 grid cut on the beat', () => {
    const prompt = buildKeyframePrompt({
      row: {
        character_actions: '五人女团齐舞，队形从箭形展开为横排，C 位与两侧成员中心交换',
        visual_description: '环形舞台群舞，副歌 drop 全员爆发',
        storyboard_prompts: 'kpop girl group dance stage',
      },
      shotDurationSeconds: 12,
    })
    expect(prompt).toContain('16-panel grid（16格，4 columns × 4 rows）')
    expect(prompt).toContain('DANCE / 群舞')
    expect(prompt).toContain('ON THE MUSICAL BEAT')
    // Formation storytelling + all-members-in-frame consistency guidance.
    expect(prompt).toContain('队形叙事')
    expect(prompt).toContain('群体同框')
    // ≈0.75s per panel for a 12s shot.
    expect(prompt).toContain('≈ 0.75s')
    // A dance row is NOT a fight — it must not inherit the 25-panel fight sheet.
    expect(prompt).not.toContain('25-panel grid')
    expect(prompt).not.toContain('choose 3–6 panels')
    expect(prompt).toContain('sum to exactly 12s')
  })

  it('a fight beats dance for the panel count even if both keywords appear', () => {
    const prompt = buildKeyframePrompt({
      row: {
        character_actions: '两名舞者在舞台上拔剑交锋，边跳边打斗',
        visual_description: '舞台打斗',
      },
      shotDurationSeconds: 10,
    })
    // High-action wins: 25-panel fight sheet, not the 16-panel dance sheet.
    expect(prompt).toContain('25-panel grid')
    expect(prompt).not.toContain('16-panel grid')
  })

  it('isDanceRow keys off action-bearing fields', () => {
    expect(isDanceRow({ character_actions: '五人女团齐舞，队形变换' })).toBe(true)
    expect(isDanceRow({ motion_prompts: 'kpop girl group dance formation' })).toBe(true)
    expect(isDanceRow({ character_actions: '两人对坐轻声交谈' })).toBe(false)
  })
})

describe('generateIdentitySheet (角色身份版)', () => {
  beforeEach(() => { mockedRunCapability.mockReset() })

  const req = {
    character: { name: '莉安', description: '灰色风衣，短发', imageUrls: ['https://lian.png'] },
    props: [{ name: '怀表', description: '银色', imageUrls: ['https://watch.png'] }],
    scene: { name: '废弃教堂', description: '彩窗漏光', imageUrls: ['https://church.png'] },
    visualStyle: 'Cold-toned filmic',
    coreEmotion: '压抑的守护欲',
    visualMark: '左颊疤痕',
  }

  it('buildIdentitySheetPrompt lays out 1 anchor + 7 views + 3 silhouettes + 3 expressions + 3 details + ID block on one 16:9 sheet', () => {
    const prompt = buildIdentitySheetPrompt(req)
    expect(prompt).toContain('角色身份版 / CHARACTER IDENTITY SHEET — 莉安')
    expect(prompt).toContain('全身锚点 / Full-body anchor (×1)')
    expect(prompt).toContain('辅助视角 / Auxiliary views (×7)')
    // The 7 views: 正/背/左侧/右侧/3/4侧/仰/俯.
    for (const v of ['正面 front', '背面 back', '左侧 left profile', '右侧 right profile', '仰视 low-angle', '俯视 high-angle']) {
      expect(prompt).toContain(v)
    }
    expect(prompt).toContain('轮廓剪影 / Silhouettes (×3)')
    expect(prompt).toContain('表情 / Expressions (×3)')
    expect(prompt).toContain('细节 / Detail close-ups (×3)')
    expect(prompt).toContain('ID 块 / ID block (×1)')
    // ID block carries 名字/身份/核心情绪/视觉标志.
    expect(prompt).toContain('名字「莉安」')
    expect(prompt).toContain('核心情绪「压抑的守护欲」')
    expect(prompt).toContain('视觉标志「左颊疤痕」')
    // Identity is locked to the reference images.
    expect(prompt).toContain('Identity is NON-NEGOTIABLE')
  })

  it('locks the character↔prop scale via the prop strip and relights the sheet with the scene lighting (刷光)', () => {
    const prompt = buildIdentitySheetPrompt(req)
    expect(prompt).toContain('角色×道具比例条 / Prop scale strip')
    expect(prompt).toContain('TRUE relative scale')
    expect(prompt).toContain('怀表')
    // 刷光: scene ref is the LIGHT source, never a backdrop.
    expect(prompt).toContain('刷光')
    expect(prompt).toContain('Relight the ENTIRE sheet')
    expect(prompt).toContain('do NOT paint the scene as a backdrop')
  })

  it('prop scale is shown visually side-by-side on one ground line — never as text labels', () => {
    const prompt = buildIdentitySheetPrompt(req)
    expect(prompt).toContain('SIDE-BY-SIDE')
    expect(prompt).toContain('ONE shared ground line')
    expect(prompt).toContain('DO NOT convey scale with text, numbers, measurements or annotation labels')
  })

  it('collectIdentitySheetRefs orders refs character-first, props next, scene LAST (lighting source only)', () => {
    const refs = collectIdentitySheetRefs(req)
    expect(refs.map((r) => r.role)).toEqual([
      'Character identity — 莉安',
      'Prop (scale lock) — 怀表',
      'Scene LIGHTING source — 废弃教堂',
    ])
  })

  it('prior identity sheets ride as costume CANON refs right after the identity anchors', () => {
    const withPrior = { ...req, priorSheetUrls: ['https://sheet-row1.png'] }
    const refs = collectIdentitySheetRefs(withPrior)
    expect(refs.map((r) => r.role)).toEqual([
      'Character identity — 莉安',
      'Costume & detail CANON — previous identity sheet of 莉安',
      'Prop (scale lock) — 怀表',
      'Scene LIGHTING source — 废弃教堂',
    ])
    // Prompt hard-locks costume details to the canon sheet.
    const prompt = buildIdentitySheetPrompt(withPrior)
    expect(prompt).toContain('COSTUME DETAIL CANON')
    expect(prompt).toContain('Do NOT re-invent, add, remove or restyle ANY detail')
    // Without prior sheets the canon block is absent.
    expect(buildIdentitySheetPrompt(req)).not.toContain('COSTUME DETAIL CANON')
  })

  it('row context tailors silhouettes, expressions and views to THIS row', () => {
    const withRow = {
      ...req,
      rowContext: {
        shotNumber: 'S2',
        actions: '拔刀回身格挡',
        shotSize: '近景仰拍',
        emotionAtmosphere: '压迫下的爆发',
        performanceGuidance: '先收后放，格挡瞬间眼神变锐',
      },
    }
    const prompt = buildIdentitySheetPrompt(withRow)
    expect(prompt).toContain("THIS ROW'S SHOOTING CONTEXT（S2）")
    expect(prompt).toContain('拔刀回身格挡')
    // Silhouettes come from the row's action arc, not generic poses.
    expect(prompt).toContain("drawn from THIS ROW's actions")
    expect(prompt).toContain('wind-up, peak moment, and follow-through')
    // Expressions center on the row's emotional beat.
    expect(prompt).toContain('压迫下的爆发')
    // The view matching the row's camera is prioritized.
    expect(prompt).toContain('近景仰拍')
    expect(prompt).toContain('先收后放，格挡瞬间眼神变锐')
    // Without rowContext the prompt stays generic.
    expect(buildIdentitySheetPrompt(req)).not.toContain("THIS ROW'S SHOOTING CONTEXT")
  })

  it('renders the sheet through the pinned keyframe backend at 16:9 with the ordered refs', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://sheet.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(generateIdentitySheet(req, ctx))
    expect(result.url).toBe('https://sheet.png')
    expect(result.imageRefs).toHaveLength(3)
    const call = mockedRunCapability.mock.calls[0]![0]
    expect(call.capability).toBe('text-to-image')
    expect(call.params?.provider).toBe(KEYFRAME_PROVIDER)
    expect(call.params?.model).toBe(KEYFRAME_MODEL)
    expect(call.params?.aspect).toBe('16:9')
    // 1 text + 3 ordered ref images.
    expect(call.inputs).toHaveLength(4)
  })

  it('throws when the character name is missing', async () => {
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(generateIdentitySheet({ character: { name: '' } }, ctx)),
    ).rejects.toThrow(/character name/)
  })

  it('falls back to Gemini flash-image (nano-banana) when the primary image backend times out', async () => {
    mockedRunCapability.mockReset()
    // Primary (tokenrouter/gpt-image) times out; fallback (gemini) succeeds.
    mockedRunCapability
      .mockRejectedValueOnce(new Error('图片生成失败 (Apimart): task timed out after 180s'))
      .mockResolvedValueOnce({ outputs: [{ kind: 'image', url: 'https://nano-banana-sheet.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(generateIdentitySheet(req, ctx))
    expect(result.url).toBe('https://nano-banana-sheet.png')
    expect(mockedRunCapability).toHaveBeenCalledTimes(2)
    expect(mockedRunCapability.mock.calls[0]![0].params?.provider).toBe(KEYFRAME_PROVIDER)
    expect(mockedRunCapability.mock.calls[1]![0].params?.provider).toBe('gemini')
    expect(mockedRunCapability.mock.calls[1]![0].params?.model).toBe('google/gemini-3.1-flash-image-preview')
  })

  it('propagates the error when BOTH primary and nano-banana backends fail', async () => {
    mockedRunCapability.mockReset()
    mockedRunCapability
      .mockRejectedValueOnce(new Error('primary timed out'))
      .mockRejectedValueOnce(new Error('fallback also timed out'))
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(driveAuto(generateIdentitySheet(req, ctx))).rejects.toThrow(/fallback also timed out/)
    expect(mockedRunCapability).toHaveBeenCalledTimes(2)
  })
})

describe('critiqueVideoConsistency', () => {
  beforeEach(() => { mockedRunCapability.mockReset() })

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
  beforeEach(() => { mockedRunCapability.mockReset() })

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
