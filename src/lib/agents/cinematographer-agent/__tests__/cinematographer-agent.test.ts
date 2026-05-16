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

  it('pins to Seedance 2.0 (the planning contract)', () => {
    expect(SHOOT_PROVIDER).toBe('doubao')
    expect(SHOOT_MODEL).toBe('doubao-seedance-2-0-fast-260128')
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

  it('buildMotionDescription stitches together row fields with the panel-progression nudge', () => {
    const desc = buildMotionDescription({
      row: {
        motion_prompts: 'slow push-in',
        storyboard_prompts: '3-panel grid: setup, beat, climax',
        visual_description: 'rooftop at dusk',
        character_actions: 'Alice draws the watch',
        shot_size: 'medium close-up',
      },
      visualStyle: 'Cold-toned filmic',
    })
    expect(desc).toContain('Cold-toned filmic')
    expect(desc).toContain('slow push-in')
    expect(desc).toContain('3-panel grid')
    expect(desc).toContain('temporal guidance for Seedance 2')
    expect(desc).toContain('not a literal split-screen layout')
    expect(desc).toContain('rooftop at dusk')
    expect(desc).toContain('Alice draws the watch')
    expect(desc).toContain('medium close-up shot')
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
  it('bakes character/scene/prop names into a "Featuring / 出场" line for the motion text', async () => {
    const { buildContextRefLine } = await import('@/lib/agents/cinematographer-agent')
    const line = buildContextRefLine([
      { role: '角色1', description: 'Alice, grey trench' },
      { role: '场景', description: 'rainy rooftop' },
    ])
    expect(line).toContain('Featuring / 出场:')
    expect(line).toContain('角色1 (Alice, grey trench)')
    expect(line).toContain('场景 (rainy rooftop)')
    // No image URLs leak in — context refs are text-only.
    expect(line).not.toContain('http')
  })

  it('returns empty when no context refs supplied', async () => {
    const { buildContextRefLine } = await import('@/lib/agents/cinematographer-agent')
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
    expect(result.prompt).toContain('push in')

    const call = mockedRunCapability.mock.calls[0]![0]
    expect(call.capability).toBe('text-to-video')
    expect(call.params?.provider).toBe('doubao')
    expect(call.params?.model).toBe('doubao-seedance-2-0-fast-260128')
    expect(call.params?.duration).toBe('8')
    expect(call.params?.aspect).toBe('16:9')
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
    expect(mockedRunCapability.mock.calls[0]![0].params?.duration).toBe('5')
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
    expect(mockedRunCapability.mock.calls[0]![0].params?.aspect).toBe('9:16')
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

  it('threads context-ref names + descriptions into the motion text (not as image inputs)', () => {
    const prompt = assembleShootPrompt({
      row: { motion_prompts: 'm' },
      keyframeUrl: 'https://k.png',
      contextRefs: [
        { role: '角色1', description: 'Alice' },
        { role: '场景', description: 'Rooftop' },
      ],
    })
    expect(prompt).toContain('Featuring / 出场: 角色1 (Alice)；场景 (Rooftop)')
    // Legend should still list ONLY image1.
    expect(prompt).toContain('image1 / @图片1 = Keyframe')
    expect(prompt).not.toContain('image2')
  })

  it('embeds the Seedance director-reference + casting-lock + negative blocks in every shoot prompt', () => {
    const prompt = assembleShootPrompt({
      row: { motion_prompts: 'push in', visual_description: 'rooftop' },
      keyframeUrl: 'https://k.png',
    })
    // Director Reference block — tells Seedance the storyboard sheet is
    // a blocking reference, not the final shot.
    expect(prompt).toContain('【全能参考 / Director Reference】')
    expect(prompt).toContain('@图片1')
    expect(prompt).toContain('不要拍摄或展示这张图板本身')
    expect(prompt).toContain('最终输出必须是干净的')
    // Casting Lock block — face/hair/clothing/posture/weapon consistency.
    expect(prompt).toContain('【CASTING LOCK / 角色锁定】')
    expect(prompt).toContain('脸型、发型、服装配色、体态、武器')
    // Negative block — no panel frames, UI, character substitution.
    expect(prompt).toContain('【NEGATIVE】')
    expect(prompt).toContain('不要出现图板边框、分栏、网格')
    expect(prompt).toContain('不要换角')
    expect(prompt).toContain('不要把背景人物/路人/怪物/士兵/分身当主角')
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
