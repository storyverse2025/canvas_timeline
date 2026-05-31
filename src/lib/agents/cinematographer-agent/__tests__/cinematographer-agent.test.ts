import { describe, it, expect, vi, beforeEach } from 'vitest'

import { runCapability } from '@/lib/capabilities/client'
import {
  assembleShootPrompt,
  buildImageLegend,
  buildMotionDescription,
  cinematographerAgent,
  clampDuration,
  revise,
  shoot,
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

  it('buildMotionDescription surfaces every populated row field alongside dialogue + SFX — keyframe + Seedance pull the same direction', () => {
    const desc = buildMotionDescription({
      row: {
        shot_number: 'S7',
        motion_prompts: 'one-shot pan from Riku to Kai',
        storyboard_prompts: '3-panel grid: setup, beat, climax',
        visual_description: '索利斯方舟庭院; mana-rail arc; violet lattice block',
        character_actions: 'Riku zips by on mana-rail; Kai conjures violet lattice',
        emotion_mood: '炫技 / 少年漫',
        emotion_atmosphere: '色彩缤纷与魔法粒子',
        shot_size: 'wide / one-shot',
        lighting_atmosphere: 'sunset palette; magical particle bloom',
        character_motivation: 'establish each student\'s elemental power',
        performance_guidance: 'Riku grins; Kai eyes never leave the book',
        dialogue: 'Alice: We have to go.',
        sound_effects: 'mana-rail hum; lattice crackle',
      },
      visualStyle: 'Cold-toned filmic',
    })
    // Row beat anchors block — labelled list of every populated field.
    expect(desc).toContain('【行字段锚点 / ROW BEAT ANCHORS】')
    expect(desc).toContain('视觉风格 / Style: Cold-toned filmic')
    expect(desc).toContain('镜头编号 / Shot #: S7')
    expect(desc).toContain('景别 / Shot size: wide / one-shot')
    expect(desc).toContain('画面 / Visual: 索利斯方舟庭院')
    expect(desc).toContain('角色动作 / Character actions: Riku zips by on mana-rail')
    expect(desc).toContain('运镜意图 / Motion intent: one-shot pan from Riku to Kai')
    expect(desc).toContain('情绪 / Emotion mood: 炫技 / 少年漫')
    expect(desc).toContain('氛围 / Atmosphere: 色彩缤纷与魔法粒子')
    expect(desc).toContain('光影 / Lighting: sunset palette')
    expect(desc).toContain("动机 / Character motivation: establish each student's elemental power")
    expect(desc).toContain('表演要点 / Performance guidance: Riku grins')
    // Dialogue + SFX still in their own labelled blocks.
    expect(desc).toContain('【对白 / DIALOGUE】')
    expect(desc).toContain('Alice: We have to go.')
    expect(desc).toContain('【音效 / SFX】')
    expect(desc).toContain('mana-rail hum; lattice crackle')
  })

  it('buildMotionDescription returns empty string when row has nothing populated and no dialogue/SFX/style', () => {
    const desc = buildMotionDescription({ row: {} })
    expect(desc).toBe('')
  })

  it('buildMotionDescription with only motion_prompts (no dialogue/SFX) still surfaces the row anchors block', () => {
    const desc = buildMotionDescription({
      row: { motion_prompts: 'push in', visual_description: 'rooftop' },
      visualStyle: 'Cold-toned filmic',
    })
    // Was previously '' because dialogue+SFX were the only kept fields.
    expect(desc).toContain('【行字段锚点 / ROW BEAT ANCHORS】')
    expect(desc).toContain('画面 / Visual: rooftop')
    expect(desc).toContain('运镜意图 / Motion intent: push in')
    expect(desc).toContain('视觉风格 / Style: Cold-toned filmic')
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
})

describe('buildContextRefLine', () => {
  it('returns empty — context refs are no longer baked into the prompt (they biased Seedance away from the keyframe)', async () => {
    const { buildContextRefLine } = await import('@/lib/agents/cinematographer-agent')
    expect(
      buildContextRefLine([
        { role: '角色1', description: 'Alice, grey trench' },
        { role: '场景', description: 'rainy rooftop' },
      ]),
    ).toBe('')
    expect(buildContextRefLine([])).toBe('')
  })
})

describe('shoot', () => {
  beforeEach(() => mockedRunCapability.mockReset())

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
    // Row beat anchors block now surfaces motion_prompts (and shot_number /
    // duration / etc.) — keyframe + Seedance pull the same direction.
    expect(result.prompt).toContain('【全能参考 / Director Reference】')
    expect(result.prompt).toContain('【行字段锚点 / ROW BEAT ANCHORS】')
    expect(result.prompt).toContain('运镜意图 / Motion intent: push in')

    // shoot() now fires cinematography-describe BEFORE the text-to-video
    // call; find the Seedance call by capability name rather than index.
    const call = mockedRunCapability.mock.calls.find((c) => c[0]!.capability === 'text-to-video')![0]!
    expect(call.capability).toBe('text-to-video')
    expect(call.params?.provider).toBe('doubao')
    expect(call.params?.model).toBe('dreamina-seedance-2-0-260128')
    expect(call.params?.duration).toBe('8')
    expect(call.params?.aspect).toBe('16:9')
    // No caller-supplied resolution → falls back to 480p default.
    expect(call.params?.resolution).toBe('480p')
    expect(call.params?.reference_mode).toBe('omni')
    // Exactly 1 text + 1 image (the keyframe). Context refs do NOT land
    // as additional image inputs.
    expect(call.inputs).toHaveLength(2)
    expect(call.inputs[1]).toEqual({ kind: 'image', url: 'https://k.png' })
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

  it('does NOT bake context-ref descriptions into the motion text any more (row beat anchors are the channel now; contextRefs stay out)', () => {
    const prompt = assembleShootPrompt({
      row: { motion_prompts: 'm' },
      keyframeUrl: 'https://k.png',
      contextRefs: [
        { role: '角色1', description: 'Alice' },
        { role: '场景', description: 'Rooftop' },
      ],
    })
    expect(prompt).not.toContain('Featuring')
    // ContextRef descriptions are still NOT injected — anchors carry the
    // structured row text instead, contextRefs were a separate channel.
    expect(prompt).not.toContain('Alice')
    expect(prompt).not.toContain('Rooftop')
    // Legend should still list ONLY image1.
    expect(prompt).toContain('image1 / @图片1 = Keyframe')
    expect(prompt).not.toContain('image2')
  })

  it('keeps the trimmed director-reference + casting-lock + negative blocks in every shoot prompt', () => {
    const prompt = assembleShootPrompt({
      row: { motion_prompts: 'push in', visual_description: 'rooftop' },
      keyframeUrl: 'https://k.png',
    })
    expect(prompt).toContain('【全能参考 / Director Reference】')
    expect(prompt).toContain('@图片1')
    expect(prompt).toContain('起始帧')
    expect(prompt).toContain('【CASTING LOCK / 角色锁定】')
    expect(prompt).toContain('【NEGATIVE】')
    expect(prompt).toContain('不要换角')
    // visual_description NOW appears as part of the ROW BEAT ANCHORS block
    // (reinforces the keyframe instead of being silently dropped).
    expect(prompt).toContain('画面 / Visual: rooftop')
    expect(prompt).toContain('运镜意图 / Motion intent: push in')
  })
})

describe('revise', () => {
  beforeEach(() => mockedRunCapability.mockReset())

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
