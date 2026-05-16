import { describe, it, expect } from 'vitest'
import { fillPrompt } from '@/lib/prompts'

describe('storyboardGeneration total-duration constraint', () => {
  it('embeds the requested total duration as a hard rule the LLM must satisfy', () => {
    const prompt = fillPrompt('storyboardGeneration', {
      artStyle: 'cinematic',
      totalDurationSeconds: '60',
      characterDesigns: '[]',
      sceneDesigns: '[]',
      propDesigns: '[]',
      shotAllocation: '[]',
      shotComposition: '[]',
      visualStrategy: '',
      elementContext: '',
    })
    // Header banner appears.
    expect(prompt).toContain('总时长硬约束')
    // Numeric duration substituted in multiple places.
    expect(prompt).toContain('60 秒')
    expect(prompt).toContain('Σ duration == 60')
    // Hard constraint in the field-rules section.
    expect(prompt).toContain('hard constraint')
    expect(prompt).toContain('容差 ±0.5s')
  })

  it('applyFixes also receives the total duration so re-balancing converges to the same target', () => {
    const prompt = fillPrompt('applyFixes', {
      storyboardJson: '[]',
      issuesList: '1. 偏差 5s',
      totalDurationSeconds: '90',
    })
    expect(prompt).toContain('总时长锁定为 90 秒')
    expect(prompt).toContain('容差 ±0.5s')
  })
})
