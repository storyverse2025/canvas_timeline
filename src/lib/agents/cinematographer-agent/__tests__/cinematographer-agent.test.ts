import { describe, it, expect, vi, beforeEach } from 'vitest'

import { runCapability } from '@/lib/capabilities/client'
import {
  assembleShootPrompt,
  buildImageLegend,
  buildMotionDescription,
  cinematographerAgent,
  clampDuration,
  pickStrategies,
  predictDialogueDurationSeconds,
  resolveEffectiveDurationSeconds,
  revise,
  shoot,
  shootMultiStrategy,
  SHOOT_MODEL,
  SHOOT_PROVIDER,
} from '@/lib/agents/cinematographer-agent'
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

describe('cinematographer-agent: meta', () => {
  it('exposes shoot + revise on the module export', () => {
    expect(cinematographerAgent.shoot).toBe(shoot)
    expect(cinematographerAgent.revise).toBe(revise)
    expect(cinematographerAgent.meta.name).toBe('cinematographer-agent')
  })

  it('pins to BytePlus海外 Dreamina Seedance 2.0 (full; matches projectDB default)', () => {
    expect(SHOOT_PROVIDER).toBe('doubao')
    expect(SHOOT_MODEL).toBe('dreamina-seedance-2-0-260128')
  })
})

describe('pure helpers', () => {
  it('clampDuration → [5, 15] seconds', () => {
    expect(clampDuration(0)).toBe(5)
    expect(clampDuration(2)).toBe(5)
    expect(clampDuration(8)).toBe(8)
    expect(clampDuration(15)).toBe(15)
    expect(clampDuration(60)).toBe(15)
    expect(clampDuration(7.4)).toBe(7) // rounded
    expect(clampDuration(7.6)).toBe(8)
  })

  it('predictDialogueDurationSeconds → 0 for empty / undefined', () => {
    expect(predictDialogueDurationSeconds(undefined)).toBe(0)
    expect(predictDialogueDurationSeconds('')).toBe(0)
    expect(predictDialogueDurationSeconds('   ')).toBe(0)
  })

  it('predictDialogueDurationSeconds → counts Mandarin chars at ~3.5/sec (ignores punctuation)', () => {
    // 8 Han chars in '我们必须现在离开' / 3.5 ≈ 2.286s. Trailing 。 is not Han.
    expect(predictDialogueDurationSeconds('我们必须现在离开。')).toBeCloseTo(8 / 3.5, 5)
  })

  it('predictDialogueDurationSeconds → counts English words at ~2.5/sec', () => {
    // 5 words / 2.5 = 2.0s
    expect(predictDialogueDurationSeconds('we have to leave now')).toBeCloseTo(5 / 2.5, 5)
  })

  it('predictDialogueDurationSeconds → mixed Chinese + English adds', () => {
    // 'Alice: 我们必须现在离开。' → 1 English word ('Alice') + 8 Han chars
    const seconds = predictDialogueDurationSeconds('Alice: 我们必须现在离开。')
    expect(seconds).toBeCloseTo(1 / 2.5 + 8 / 3.5, 5)
  })

  it('resolveEffectiveDurationSeconds → uses user request when dialogue is short', () => {
    // No dialogue → floor is 0, user gets clamped value
    expect(resolveEffectiveDurationSeconds({ userRequested: 8, dialogue: undefined })).toBe(8)
    expect(resolveEffectiveDurationSeconds({ userRequested: 8, dialogue: '嗯。' })).toBe(8)
  })

  it('resolveEffectiveDurationSeconds → bumps duration to dialogue floor + 0.8s buffer', () => {
    // 28 Han chars / 3.5 = 8.0s + 0.8 buffer = 8.8s → rounds to 9
    const dialogue = '我'.repeat(28)
    expect(resolveEffectiveDurationSeconds({ userRequested: 5, dialogue })).toBe(9)
  })

  it('resolveEffectiveDurationSeconds → respects MAX_DURATION clamp even for long dialogue', () => {
    const huge = '我们必须现在离开'.repeat(20) // 160 Han chars ≈ 46s
    expect(resolveEffectiveDurationSeconds({ userRequested: 5, dialogue: huge })).toBe(15)
  })

  it('buildMotionDescription formats row fields into a Seedance 2.0 structure', () => {
    const desc = buildMotionDescription({
      row: {
        motion_prompts: 'slow push-in',
        storyboard_prompts: '3-panel grid: setup, beat, climax',
        visual_description: 'rooftop at dusk',
        character_actions: 'Alice draws the watch',
        shot_size: 'medium close-up',
        dialogue: 'Alice: We have to go.',
        sound_effects: 'distant thunder; footsteps on wet gravel',
      },
      visualStyle: 'Cold-toned filmic',
      contextRefs: [{ role: '角色1', description: 'Alice, grey trench' }],
    })
    expect(desc).toContain('【Seedance 2.0 视频生成指令】')
    expect(desc).toContain('【参考素材用途】')
    expect(desc).toContain('角色1：Alice, grey trench')
    expect(desc).toContain('【主体 / 场景 / 风格】')
    expect(desc).toContain('rooftop at dusk')
    expect(desc).toContain('Cold-toned filmic')
    expect(desc).toContain('【表演与情绪】')
    expect(desc).toContain('Alice draws the watch')
    expect(desc).toContain('【分时段动作与运镜】')
    expect(desc).toContain('slow push-in')
    expect(desc).toContain('【导演分镜格信息】')
    expect(desc).toContain('3-panel grid')
    expect(desc).toContain('not a literal split-screen')
    expect(desc).toContain('【声音设计】')
    expect(desc).toContain('Alice: We have to go.')
    expect(desc).toContain('distant thunder')
  })

  it('buildMotionDescription still returns a minimal Seedance scaffold when there is no dialogue and no SFX', () => {
    const desc = buildMotionDescription({
      row: { motion_prompts: 'push in', visual_description: 'rooftop' },
      visualStyle: 'Cold-toned filmic',
    })
    expect(desc).toContain('【Seedance 2.0 视频生成指令】')
    expect(desc).toContain('push in')
    expect(desc).toContain('rooftop')
    expect(desc).toContain('Cold-toned filmic')
  })

  it('buildImageLegend lists ONLY the keyframe (omni-reference / 全能参考 mode)', () => {
    const legend = buildImageLegend('https://k.png')
    expect(legend).toContain('omni-reference / 全能参考')
    expect(legend).toContain('image1 / @图片1 = Keyframe')
    // Character / scene / prop are NOT in the legend — they go into the
    // motion text via buildContextRefLine instead.
    expect(legend).not.toContain('image2')
    expect(legend).not.toContain('角色1')
  })

  it('buildImageLegend designates @图片1=首帧 and @图片2=导演思维图 when a grid ref is shipped', () => {
    const legend = buildImageLegend('https://clean.png', true)
    expect(legend).toContain('image1 / @图片1')
    expect(legend).toContain('image2 / @图片2')
    expect(legend).toContain('首帧图')
    expect(legend).toContain('导演思维图')
    // The grid must be reference-only — never rendered into the frame.
    expect(legend).toContain('严禁')
  })

  it('buildImageLegend enumerates the reference pack in order (角色→场景→分镜→机位) and @-points each subject', () => {
    const legend = buildImageLegend('https://clean.png', false, [], [
      { url: 'https://id1.png', label: '角色身份版「莉安」', usage: '锁定角色「莉安」的脸型与服装', subject: '莉安' },
      { url: 'https://scene.png', label: '场景图「废弃教堂」', usage: '锁定场景空间与光线', subject: '废弃教堂' },
      { url: 'https://grid.png', label: '黑白手绘分镜图', usage: '读取调度与箭头标注' },
      { url: 'https://cam.png', label: '机位截图 / 开场构图', usage: '以这张作为开场机位' },
    ])
    expect(legend).toContain('多参考输入合成')
    expect(legend).toContain('image1 / @图片1 = 角色身份版「莉安」')
    expect(legend).toContain('@莉安 即指向这张图中的主体')
    expect(legend).toContain('image2 / @图片2 = 场景图「废弃教堂」')
    expect(legend).toContain('image3 / @图片3 = 黑白手绘分镜图')
    expect(legend).toContain('image4 / @图片4 = 机位截图 / 开场构图')
    // Pack annotations must never be rendered into the frame.
    expect(legend).toContain('严禁')
    // Pack mode replaces the keyframe/grid legend entirely.
    expect(legend).not.toContain('导演思维图 / director storyboard sheet')
  })

  it('buildImageLegend points CASTING 依据 at character refs (never at the empty scene plate)', () => {
    // Regression: a pack whose image1 is the scene plate (an EMPTY
    // environment — NO HUMANS by design) used to inherit shoot.md's
    // hardcoded "casting must match @图片1", sending the model to lock
    // faces in an image that deliberately has none.
    const legend = buildImageLegend('https://cam.png', false, [], [
      { url: 'https://c1.png', label: '角色图「零」', usage: 'u', subject: '零', kind: 'character' },
      { url: 'https://scene.png', label: '场景图「驾驶舱」', usage: 'u', kind: 'scene' },
      { url: 'https://grid.png', label: '黑白手绘分镜图', usage: 'u', kind: 'storyboard' },
      { url: 'https://cam.png', label: '机位截图 / 开场构图', usage: 'u', kind: 'camera' },
    ])
    expect(legend).toContain('CASTING 依据 / casting anchor：@图片1（零）')
  })

  it('buildImageLegend falls back to the camera plate as CASTING 依据 when the pack has no character refs', () => {
    const legend = buildImageLegend('https://cam.png', false, [], [
      { url: 'https://scene.png', label: '场景图「驾驶舱」', usage: 'u', kind: 'scene' },
      { url: 'https://grid.png', label: '黑白手绘分镜图', usage: 'u', kind: 'storyboard' },
      { url: 'https://cam.png', label: '机位截图 / 开场构图', usage: 'u', kind: 'camera' },
    ])
    // Never the scene plate (@图片1) — the camera plate is the only image
    // in this pack that actually shows the characters.
    expect(legend).toContain('CASTING 依据 / casting anchor：@图片3（机位截图中的角色造型）')
    expect(legend).not.toContain('casting anchor：@图片1')
  })

  it('cinematography block labels the TRUE index of the analyzed keyframe in pack mode', () => {
    const prompt = assembleShootPrompt({
      row: { visual_description: 'cockpit' },
      keyframeUrl: 'https://cam.png',
      cinematography: '缓慢推进',
      referencePack: [
        { url: 'https://scene.png', label: '场景图', usage: 'u', kind: 'scene' },
        { url: 'https://grid.png', label: '黑白手绘分镜图', usage: 'u', kind: 'storyboard' },
        { url: 'https://cam.png', label: '机位截图 / 开场构图', usage: 'u', kind: 'camera' },
      ],
    })
    // The describe step read keyframeUrl = the camera plate = @图片3 here.
    expect(prompt).toContain('【镜头语言 / CINEMATOGRAPHY】（基于 @图片3 / image3 的分析）')
    expect(prompt).not.toContain('（基于 @图片1 / image1 的分析）')
  })

  it('buildImageLegend numbers avatar refs AFTER the reference pack', () => {
    const legend = buildImageLegend('https://clean.png', false,
      [{ assetUri: 'asset://a1', characterName: '莉安', slotLabel: '角色1' }],
      [
        { url: 'https://id1.png', label: '角色身份版「莉安」', usage: 'u' },
        { url: 'https://cam.png', label: '机位截图', usage: 'u' },
      ])
    expect(legend).toContain('image3 / @图片3 = 虚拟人像「莉安」')
  })

  it('isValidReferenceImageUrl enforces the reference-pack URL discipline', async () => {
    const { isValidReferenceImageUrl } = await import('@/lib/agents/cinematographer-agent')
    expect(isValidReferenceImageUrl('https://x.com/a.png')).toBe(true)
    expect(isValidReferenceImageUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isValidReferenceImageUrl('data:image/svg+xml;base64,AAAA')).toBe(false)
    expect(isValidReferenceImageUrl('asset://abc')).toBe(false)
    // /uploads/ is where the capability server persists every generated
    // image (keyframes, identity sheets, grids); it inlines them to data:
    // URLs server-side before the provider call, so the client must accept
    // them. Regression: rejecting them stripped 身份版/分镜/机位 from the
    // reference pack and Seedance shot from the scene image alone.
    expect(isValidReferenceImageUrl('/uploads/abc123.png')).toBe(true)
    expect(isValidReferenceImageUrl('/relative/path.png')).toBe(false)
    expect(isValidReferenceImageUrl('[node:abc123]')).toBe(false)
    expect(isValidReferenceImageUrl('')).toBe(false)
    expect(isValidReferenceImageUrl(undefined)).toBe(false)
  })

  it('buildMotionDescription keeps row.bgm strictly as a mood reference with a no-music negative (No-Music-Bed rule, #94)', () => {
    const desc = buildMotionDescription({
      row: { visual_description: 'rooftop', dialogue: 'Alice: go.', bgm: '紧张的弦乐' },
    })
    // The bgm text may appear only as 情绪基调参考 + explicit prohibition —
    // never as a positive "BGM: …" generation instruction.
    expect(desc).not.toContain('BGM/音乐约束')
    expect(desc).toContain('情绪基调参考')
    expect(desc).toContain('紧张的弦乐')
    expect(desc).toContain('严禁出现任何 BGM/配乐/音乐')
    expect(desc).toContain('禁止任何配乐')
  })

  it('buildMotionDescription defers 参考素材用途 to the pack legend in reference-pack mode', () => {
    const desc = buildMotionDescription({
      row: { visual_description: 'rooftop' },
      hasReferencePack: true,
    })
    expect(desc).toContain('多参考输入模式')
    // No hardcoded slot order — pack composition varies per row (身份版/
    // 场景可能缺席), so the legend is the only index authority.
    expect(desc).not.toContain('角色身份版 → 场景图 → 分镜图 → 机位截图')
    expect(desc).toContain('以【参考图】legend 为准')
    expect(desc).toContain('CASTING 依据见 legend 标注')
    expect(desc).not.toContain('首帧：当前 keyframe / image1')
  })
})

describe('buildContextRefLine', () => {
  it('formats context refs as text-only Seedance role guidance', async () => {
    const { buildContextRefLine } = await import('@/lib/agents/cinematographer-agent')
    expect(
      buildContextRefLine([
        { role: '角色1', description: 'Alice, grey trench' },
        { role: '场景', description: 'rainy rooftop' },
      ]),
    ).toBe('- 角色1：Alice, grey trench\n- 场景：rainy rooftop')
    expect(buildContextRefLine([])).toBe('')
  })
})

describe('shoot', () => {
  beforeEach(() => { mockedRunCapability.mockReset() })

  it('routes Seedance 2.0 in omni-reference mode (single image input = keyframe only)', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'https://video.mp4' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })

    const result = await driveAuto(
      shoot(
        {
          row: { shot_number: 'S1', duration: 8, motion_prompts: 'push in' },
          keyframeUrl: 'https://k.png',
          contextRefs: [
            { role: '角色1', description: 'Alice' },
            { role: '场景', description: 'rooftop' },
          ],
        },
        ctx,
      ),
    )

    expect(result.url).toBe('https://video.mp4')
    expect(result.durationSeconds).toBe(8)
    expect(result.keyframeUrl).toBe('https://k.png')
    expect(result.contextRefs).toHaveLength(2)
    // Seedance prompt now carries row motion as structured text while keeping
    // media inputs constrained to text + the single keyframe image.
    expect(result.prompt).toContain('【全能参考 / Director Reference】')
    expect(result.prompt).toContain('【Seedance 2.0 视频生成指令】')
    expect(result.prompt).toContain('push in')
    expect(result.prompt).toContain('角色1：Alice')
    expect(result.prompt).toContain('场景：rooftop')

    // shoot() now fires cinematography-describe BEFORE the text-to-video
    // call; find the Seedance call by capability name rather than index.
    const call = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')![0]!
    expect(call.capability).toBe('text-to-video')
    expect(call.params?.provider).toBe('doubao')
    expect(call.params?.model).toBe('dreamina-seedance-2-0-260128')
    expect(call.params?.duration).toBe('8')
    expect(call.params?.aspect).toBe('16:9')
    // No caller-supplied resolution → falls back to 1080p default (full Seedance 2.0 look).
    expect(call.params?.resolution).toBe('1080p')
    expect(call.params?.reference_mode).toBe('omni')
    // Exactly 1 text + 1 image (the keyframe). Context refs do NOT land
    // as additional image inputs.
    expect(call.inputs).toHaveLength(2)
    expect(call.inputs[1]).toEqual({ kind: 'image', url: 'https://k.png' })
  })

  it('reference-pack mode: ships the pack (角色→场景→分镜→机位) as ordered reference images, replacing keyframe+grid', async () => {
    mockedRunCapability.mockImplementation(async (...args: unknown[]) => {
      const req = args[0] as { capability?: string } | undefined
      if (req?.capability === 'cinematography-describe') {
        return { outputs: [{ kind: 'text' as const, text: 'push in' }] }
      }
      return { outputs: [{ kind: 'video' as const, url: 'https://video.mp4' }] }
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })

    const result = await driveAuto(
      shoot(
        {
          row: { shot_number: 'S1', duration: 8 },
          keyframeUrl: 'https://clean.png',
          storyboardRefUrl: 'https://grid.png',
          referencePack: [
            { url: 'https://id1.png', label: '角色身份版「莉安」', usage: '锁定脸型/服装/比例', subject: '莉安' },
            { url: 'https://scene.png', label: '场景图「教堂」', usage: '锁定空间与光线' },
            { url: 'https://grid.png', label: '黑白手绘分镜图', usage: '读取调度' },
            { url: 'https://clean.png', label: '机位截图 / 开场构图', usage: '开场机位' },
            // Invalid URLs are dropped by the pack validator, not shipped.
            { url: 'asset://nope', label: '坏引用', usage: 'x' },
          ],
        },
        ctx,
      ),
    )

    const video = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')![0]!
    // Pack REPLACES the [keyframe, grid] pair: 4 valid pack images in order.
    expect(video.inputs).toHaveLength(5) // text + 4 pack images
    expect(video.inputs.slice(1)).toEqual([
      { kind: 'image', url: 'https://id1.png' },
      { kind: 'image', url: 'https://scene.png' },
      { kind: 'image', url: 'https://grid.png' },
      { kind: 'image', url: 'https://clean.png' },
    ])
    // Multi-image shipment must be all-reference (never mixed with first_frame).
    expect(video.params?.mode).toBe('reference')
    // Prompt legend @-points each pack index at its subject.
    expect(result.prompt).toContain('image1 / @图片1 = 角色身份版「莉安」')
    expect(result.prompt).toContain('@莉安 即指向这张图中的主体')
    expect(result.prompt).toContain('image4 / @图片4 = 机位截图 / 开场构图')
  })

  it('ships clean + grid as TWO reference images in 全能参考/reference mode and designates roles in the prompt (@图片1=首帧, @图片2=导演思维图)', async () => {
    mockedRunCapability.mockImplementation(async (...args: unknown[]) => {
      const req = args[0] as { capability?: string } | undefined
      if (req?.capability === 'cinematography-describe') {
        return { outputs: [{ kind: 'text' as const, text: 'slow push-in, soft key light' }] }
      }
      return { outputs: [{ kind: 'video' as const, url: 'https://video.mp4' }] }
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })

    await driveAuto(
      shoot(
        {
          row: { shot_number: 'S1', duration: 8 },
          keyframeUrl: 'https://clean.png',
          storyboardRefUrl: 'https://grid.png',
        },
        ctx,
      ),
    )

    // The video model gets BOTH images (clean first, grid second), both as
    // references (mode='reference' → reference-to-video). No literal
    // first_frame role — that's forbidden alongside a reference_image.
    const video = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')![0]!
    expect(video.inputs).toHaveLength(3) // text + clean + grid
    expect(video.inputs[1]).toEqual({ kind: 'image', url: 'https://clean.png' })
    expect(video.inputs[2]).toEqual({ kind: 'image', url: 'https://grid.png' })
    expect(video.params?.mode).toBe('reference')
    expect(video.params?.reference_mode).toBeUndefined()

    // The prompt legend designates the roles in text.
    const promptText = (video.inputs[0] as { text: string }).text
    expect(promptText).toContain('@图片1')
    expect(promptText).toContain('@图片2')
    expect(promptText).toContain('首帧')
    expect(promptText).toContain('导演思维图')

    // describe step still reads only the clean keyframe (text + 1 image).
    const describe = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'cinematography-describe')![0]!
    expect(describe.inputs).toHaveLength(2)
    expect(describe.inputs[1]).toEqual({ kind: 'image', url: 'https://clean.png' })
  })

  it('does NOT add a 2nd reference image when grid === clean (dedup → single image, omni hint)', async () => {
    mockedRunCapability.mockImplementation(async (...args: unknown[]) => {
      const req = args[0] as { capability?: string } | undefined
      if (req?.capability === 'cinematography-describe') {
        return { outputs: [{ kind: 'text' as const, text: 'x' }] }
      }
      return { outputs: [{ kind: 'video' as const, url: 'https://video.mp4' }] }
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      shoot(
        { row: { shot_number: 'S1', duration: 5 }, keyframeUrl: 'https://k.png', storyboardRefUrl: 'https://k.png' },
        ctx,
      ),
    )
    const video = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')![0]!
    expect(video.inputs).toHaveLength(2) // text + single image
    expect(video.params?.mode).toBeUndefined()
    expect(video.params?.reference_mode).toBe('omni')
  })

  it('transition mode: routes to first-last-frame capability with prev/next boundary images instead of omni-reference text-to-video', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'https://transition.mp4' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      shoot(
        {
          row: { duration: 3, motion_prompts: 'whip pan', visual_description: 'bridge cut' },
          keyframeUrl: 'https://bridge-keyframe.png',
          transitionFrames: {
            firstFrameUrl: 'https://prev-last-frame.png',
            lastFrameUrl: 'https://next-first-frame.png',
          },
        },
        ctx,
      ),
    )
    expect(result.url).toBe('https://transition.mp4')
    // Routed to first-last-frame, NOT text-to-video.
    const firstLastCall = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'first-last-frame')
    const t2vCall = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')
    expect(firstLastCall).toBeTruthy()
    expect(t2vCall).toBeUndefined()
    const inputs = firstLastCall![0]!.inputs
    // 1 text + 2 images (first + last). Bridge keyframe is intentionally
    // NOT shipped — first-last mode reads start + end from the two images.
    expect(inputs).toHaveLength(3)
    expect(inputs[1]).toEqual({ kind: 'image', url: 'https://prev-last-frame.png' })
    expect(inputs[2]).toEqual({ kind: 'image', url: 'https://next-first-frame.png' })
    // Voice refs / digital assets / reference_mode do NOT bleed into the
    // first-last call — bridges don't carry dialogue and the model only
    // accepts the 2 boundary images.
    expect(firstLastCall![0]!.params?.reference_mode).toBeUndefined()
  })

  it('clamps short durations up to 5s', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const r = await driveAuto(
      shoot({ row: { duration: 2, motion_prompts: 'p' }, keyframeUrl: 'https://k.png' }, ctx),
    )
    expect(r.durationSeconds).toBe(5)
    const seedanceCall = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')![0]!
    expect(seedanceCall.params?.duration).toBe('5')
  })

  it('clamps long durations down to 15s', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const r = await driveAuto(
      shoot({ row: { duration: 30, motion_prompts: 'p' }, keyframeUrl: 'https://k.png' }, ctx),
    )
    expect(r.durationSeconds).toBe(15)
  })

  it('honors durationSecondsOverride before falling back to row.duration', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const r = await driveAuto(
      shoot({ row: { duration: 8, motion_prompts: 'p' }, keyframeUrl: 'https://k.png', durationSecondsOverride: 12 }, ctx),
    )
    expect(r.durationSeconds).toBe(12)
  })

  it('respects a vertical aspect ratio', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      shoot({ row: { motion_prompts: 'p' }, keyframeUrl: 'https://k.png', aspect: '9:16' }, ctx),
    )
    const seedanceCall = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')![0]!
    expect(seedanceCall.params?.aspect).toBe('9:16')
  })

  it('threads caller-supplied resolution through to the capability call', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      shoot({ row: { motion_prompts: 'p' }, keyframeUrl: 'https://k.png', resolution: '1080p' }, ctx),
    )
    const seedanceCall = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')![0]!
    expect(seedanceCall.params?.resolution).toBe('1080p')
  })

  it('throws when keyframeUrl is missing (omni-reference needs the keyframe)', async () => {
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(shoot({ row: { motion_prompts: 'p' }, keyframeUrl: '' }, ctx)),
    ).rejects.toThrow(/requires keyframeUrl/)
  })

  it('throws when the capability returns no url', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(shoot({ row: { motion_prompts: 'p' }, keyframeUrl: 'https://k.png' }, ctx)),
    ).rejects.toThrow(/no url/)
  })

  it('bakes context-ref descriptions into text guidance without adding extra image inputs', () => {
    const prompt = assembleShootPrompt({
      row: { motion_prompts: 'm' },
      keyframeUrl: 'https://k.png',
      contextRefs: [
        { role: '角色1', description: 'Alice' },
        { role: '场景', description: 'Rooftop' },
      ],
    })
    expect(prompt).toContain('【参考素材用途】')
    expect(prompt).toContain('角色1：Alice')
    expect(prompt).toContain('场景：Rooftop')
    expect(prompt).toContain('除显式 reference-pack 模式外，不额外塞图片给 Seedance')
    // Legend should still list ONLY image1.
    expect(prompt).toContain('image1 / @图片1 = Keyframe')
    expect(prompt).not.toContain('image2')
  })

  it('keeps the director-reference + casting-lock + negative blocks while adding the structured Seedance row prompt', () => {
    const prompt = assembleShootPrompt({
      row: { motion_prompts: 'push in', visual_description: 'rooftop' },
      keyframeUrl: 'https://k.png',
    })
    expect(prompt).toContain('【全能参考 / Director Reference】')
    expect(prompt).toContain('@图片1')
    // The header no longer hardcodes @图片1 as 起始帧/casting anchor — the
    // legend is the authority, and single-keyframe mode declares its own
    // CASTING 依据 line pointing at @图片1.
    expect(prompt).toContain('legend 是唯一权威')
    expect(prompt).toContain('CASTING 依据 / casting anchor：@图片1')
    expect(prompt).toContain('【CASTING LOCK / 角色锁定】')
    expect(prompt).toContain('CASTING 依据 / casting anchor')
    expect(prompt).toContain('【NEGATIVE】')
    expect(prompt).toContain('不要换角')
    expect(prompt).toContain('【Seedance 2.0 视频生成指令】')
    expect(prompt).toContain('【主体 / 场景 / 风格】')
    expect(prompt).toContain('rooftop')
    expect(prompt).toContain('【分时段动作与运镜】')
    expect(prompt).toContain('push in')
  })
})

describe('revise', () => {
  beforeEach(() => { mockedRunCapability.mockReset() })

  it('rewrites the prompt addressing each director feedback item, then re-shoots', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'https://v2.mp4' }] })
    const { llm, spy: llmSpy } = llmReturning(
      'REVISED PROMPT: strictly match image1 character, fix scene to rooftop, frame 1 matches keyframe',
    )
    const ctx = createMemoryContext({ llm })

    const result = await driveAuto(
      revise(
        {
          previous: {
            url: 'https://v1.mp4',
            prompt: 'OLD prompt',
            durationSeconds: 8,
            keyframeUrl: 'https://k.png',
            contextRefs: [],
          },
          feedback: [
            { aspect: 'characters', severity: 'major', summary: '主角换衣服了', fix: '严格匹配 image1' },
            { aspect: 'scene', severity: 'blocking', summary: '场景不是 rooftop', fix: '改为 rooftop' },
          ],
          row: { shot_number: 'S1', duration: 8, motion_prompts: 'push in' },
          keyframeUrl: 'https://k.png',
        },
        ctx,
      ),
    )

    expect(result.url).toBe('https://v2.mp4')
    expect(result.prompt).toContain('REVISED PROMPT')

    // LLM saw the old prompt + the feedback items formatted with severity.
    const reviseInstruction = llmSpy.mock.calls[0]![0]![0]!.content as string
    expect(reviseInstruction).toContain('OLD prompt')
    expect(reviseInstruction).toContain('[major] (characters)')
    expect(reviseInstruction).toContain('[blocking] (scene)')
    expect(reviseInstruction).toContain('主角换衣服了')

    // Seedance got the REVISED prompt, not the old one.
    const seedanceCall = mockedRunCapability.mock.calls[0]![0]
    expect(seedanceCall.capability).toBe('text-to-video')
    expect(seedanceCall.inputs[0]?.text).toContain('REVISED PROMPT')
    expect(seedanceCall.inputs[0]?.text).not.toContain('OLD prompt')
  })

  it('throws when the LLM rewrite is empty', async () => {
    const { llm } = llmReturning('   ')
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(
        revise(
          {
            previous: { url: 'u', prompt: 'p', durationSeconds: 5, keyframeUrl: 'https://k.png', contextRefs: [] },
            feedback: [{ aspect: 'characters', severity: 'minor', summary: '...' }],
            row: { motion_prompts: 'p' },
            keyframeUrl: 'https://k.png',
          },
          ctx,
        ),
      ),
    ).rejects.toThrow(/empty rewrite/)
  })

  it('handles empty feedback list with a placeholder note (director asked for reshoot anyway)', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u2' }] })
    const { llm, spy } = llmReturning('reshot prompt')
    const ctx = createMemoryContext({ llm })
    await driveAuto(
      revise(
        {
          previous: { url: 'u', prompt: 'p', durationSeconds: 5, keyframeUrl: 'https://k.png', contextRefs: [] },
          feedback: [],
          row: { motion_prompts: 'p' },
          keyframeUrl: 'https://k.png',
        },
        ctx,
      ),
    )
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('(无 — 上一版通过，但导演要求重拍)')
  })
})

describe('shootMultiStrategy', () => {
  beforeEach(() => { mockedRunCapability.mockReset() })

  it('pickStrategies: 2 → stable+kinetic, 3 → stable+balanced+kinetic, 1 → default', () => {
    expect(pickStrategies(1).map((s) => s.name)).toEqual(['default'])
    expect(pickStrategies(2).map((s) => s.name)).toEqual(['stable', 'kinetic'])
    expect(pickStrategies(3).map((s) => s.name)).toEqual(['stable', 'balanced', 'kinetic'])
  })

  // Mock both the cinematography-describe (pre-roll) and text-to-video
  // (per-variant) capabilities so tests can count text-to-video calls
  // without the describe step poisoning the assertion.
  function mockBothCapabilities(handleVideo: () => { kind: 'video'; url: string } | Error) {
    let videoCall = 0
    mockedRunCapability.mockImplementation(async (...args: unknown[]) => {
      const req = args[0] as { capability?: string } | undefined
      if (req?.capability === 'cinematography-describe') {
        return { outputs: [{ kind: 'text' as const, text: 'stable handheld, soft top light' }] }
      }
      videoCall += 1
      const out = handleVideo()
      if (out instanceof Error) throw out
      return { outputs: [out] }
    })
    return () => videoCall
  }

  function countByCapability(cap: string): number {
    return mockedRunCapability.mock.calls.filter((c) => c[0]!.capability === cap).length
  }

  it('fires N parallel Seedance calls and returns one variant per success', async () => {
    let i = 0
    mockBothCapabilities(() => ({ kind: 'video', url: `https://variant-${++i}.mp4` }))
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      shootMultiStrategy(
        {
          row: { duration: 5, motion_prompts: 'p' },
          keyframeUrl: 'https://k.png',
          variants: 2,
        },
        ctx,
      ),
    )
    // Two text-to-video calls (one per variant). The cinematography-describe
    // pre-roll is separate.
    expect(countByCapability('text-to-video')).toBe(2)
    expect(result.variants).toHaveLength(2)
    expect(result.failures).toHaveLength(0)
    expect(result.variants.map((v) => v.strategyName).sort()).toEqual(['kinetic', 'stable'])
    const stable = result.variants.find((v) => v.strategyName === 'stable')!
    const kinetic = result.variants.find((v) => v.strategyName === 'kinetic')!
    expect(stable.prompt).toContain('STRATEGY OVERLAY: STABLE')
    expect(kinetic.prompt).toContain('STRATEGY OVERLAY: KINETIC')
    expect(stable.url).not.toBe(kinetic.url)
  })

  it('drops failed variants but still returns the survivors', async () => {
    let v = 0
    mockBothCapabilities(() => {
      v += 1
      if (v === 1) return new Error('content policy')
      return { kind: 'video', url: 'https://kinetic.mp4' }
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      shootMultiStrategy(
        { row: { duration: 5, motion_prompts: 'p' }, keyframeUrl: 'https://k.png', variants: 2 },
        ctx,
      ),
    )
    expect(result.variants).toHaveLength(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.reason).toContain('content policy')
  })

  it('throws when every variant fails', async () => {
    // Cinematography-describe succeeds (returns fake text), but every
    // Seedance video call rejects. Use mockResolvedValueOnce/mockRejected-
    // ValueOnce so vitest doesn't flag the rejected promise as unhandled
    // before driveAuto's await unwraps it.
    mockedRunCapability
      .mockResolvedValueOnce({ outputs: [{ kind: 'text', text: 'fake cinematography' }] })
      .mockRejectedValueOnce(new Error('quota exceeded'))
      .mockRejectedValueOnce(new Error('quota exceeded'))
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    let caught: Error | undefined
    try {
      await driveAuto(
        shootMultiStrategy(
          { row: { duration: 5, motion_prompts: 'p' }, keyframeUrl: 'https://k.png', variants: 2 },
          ctx,
        ),
      )
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/all 2 variants failed/)
    expect(caught!.message).toMatch(/quota exceeded/)
  })

  it('clamps variant count to [2, 3]', async () => {
    mockBothCapabilities(() => ({ kind: 'video', url: 'u' }))
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      shootMultiStrategy(
        { row: { duration: 5, motion_prompts: 'p' }, keyframeUrl: 'https://k.png', variants: 10 },
        ctx,
      ),
    )
    expect(countByCapability('text-to-video')).toBe(3)
  })
})
