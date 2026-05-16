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

  it('buildImageLegend numbers refs in stable order', () => {
    const legend = buildImageLegend([
      { role: 'Keyframe', imageUrl: 'https://k.png' },
      { role: '角色1', description: 'Alice', imageUrl: 'https://a.png' },
    ])
    expect(legend).toContain('image1 = Keyframe')
    expect(legend).toContain('image2 = 角色1 (Alice)')
  })
})

describe('shoot', () => {
  beforeEach(() => mockedRunCapability.mockReset())

  it('routes Seedance 2.0 with provider + model + duration + aspect params', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'https://video.mp4' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })

    const result = await driveAuto(
      shoot(
        {
          row: { shot_number: 'S1', duration: 8, motion_prompts: 'push in' },
          refs: [{ role: 'Keyframe', imageUrl: 'https://k.png' }],
        },
        ctx,
      ),
    )

    expect(result.url).toBe('https://video.mp4')
    expect(result.durationSeconds).toBe(8)
    expect(result.refs).toHaveLength(1)
    expect(result.prompt).toContain('push in')

    const call = mockedRunCapability.mock.calls[0]![0]
    expect(call.capability).toBe('text-to-video')
    expect(call.params?.provider).toBe('doubao')
    expect(call.params?.model).toBe('doubao-seedance-2-0-fast-260128')
    expect(call.params?.duration).toBe('8')
    expect(call.params?.aspect).toBe('16:9')
    // 1 text + 1 image ref.
    expect(call.inputs).toHaveLength(2)
    expect(call.inputs[1]).toEqual({ kind: 'image', url: 'https://k.png' })
  })

  it('clamps short durations up to 5s', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const r = await driveAuto(
      shoot({ row: { duration: 2, motion_prompts: 'p' }, refs: [] }, ctx),
    )
    expect(r.durationSeconds).toBe(5)
    expect(mockedRunCapability.mock.calls[0]![0].params?.duration).toBe('5')
  })

  it('clamps long durations down to 15s', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const r = await driveAuto(
      shoot({ row: { duration: 30, motion_prompts: 'p' }, refs: [] }, ctx),
    )
    expect(r.durationSeconds).toBe(15)
  })

  it('honors durationSecondsOverride before falling back to row.duration', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const r = await driveAuto(
      shoot({ row: { duration: 8, motion_prompts: 'p' }, refs: [], durationSecondsOverride: 12 }, ctx),
    )
    expect(r.durationSeconds).toBe(12)
  })

  it('respects a vertical aspect ratio', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'video', url: 'u' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      shoot({ row: { motion_prompts: 'p' }, refs: [], aspect: '9:16' }, ctx),
    )
    expect(mockedRunCapability.mock.calls[0]![0].params?.aspect).toBe('9:16')
  })

  it('throws when row has no motion fields AND no refs', async () => {
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(shoot({ row: {}, refs: [] }, ctx)),
    ).rejects.toThrow(/needs at least/)
  })

  it('throws when the capability returns no url', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await expect(
      driveAuto(shoot({ row: { motion_prompts: 'p' }, refs: [] }, ctx)),
    ).rejects.toThrow(/no url/)
  })

  it('places reference images in the same order as the prompt legend', () => {
    const prompt = assembleShootPrompt({
      row: { motion_prompts: 'm' },
      refs: [
        { role: 'Keyframe', imageUrl: 'k' },
        { role: '角色1', description: 'Alice', imageUrl: 'a' },
        { role: '场景', description: 'Rooftop', imageUrl: 's' },
      ],
    })
    expect(prompt).toMatch(/image1 = Keyframe[\s\S]*image2 = 角色1[\s\S]*image3 = 场景/)
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
            refs: [{ role: 'Keyframe', imageUrl: 'https://k.png' }],
          },
          feedback: [
            { aspect: 'characters', severity: 'major', summary: '主角换衣服了', fix: '严格匹配 image1' },
            { aspect: 'scene', severity: 'blocking', summary: '场景不是 rooftop', fix: '改为 rooftop' },
          ],
          row: { shot_number: 'S1', duration: 8, motion_prompts: 'push in' },
          refs: [{ role: 'Keyframe', imageUrl: 'https://k.png' }],
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
            previous: { url: 'u', prompt: 'p', durationSeconds: 5, refs: [] },
            feedback: [{ aspect: 'characters', severity: 'minor', summary: '...' }],
            row: { motion_prompts: 'p' },
            refs: [],
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
          previous: { url: 'u', prompt: 'p', durationSeconds: 5, refs: [] },
          feedback: [],
          row: { motion_prompts: 'p' },
          refs: [],
        },
        ctx,
      ),
    )
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('(无 — 上一版通过，但导演要求重拍)')
  })
})
