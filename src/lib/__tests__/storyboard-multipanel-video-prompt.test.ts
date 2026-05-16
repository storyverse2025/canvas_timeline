import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fillPrompt } from '@/lib/prompts'

const storyboardGenerateSource = readFileSync('src/hooks/useStoryboardGenerate.ts', 'utf8')
const chatPanelSource = readFileSync('src/components/chat/ChatPanel.tsx', 'utf8')

describe('multi-panel director storyboard and Seedance prompt contract', () => {
  it('asks storyboard generation to merge continuous beats into 10-15s rows with multi-panel director grids', () => {
    const prompt = fillPrompt('storyboardGeneration', {
      artStyle: 'Final Fantasy CG',
      characterDesigns: '[]',
      sceneDesigns: '[]',
      propDesigns: '[]',
      shotAllocation: '[]',
      shotComposition: '[]',
      visualStrategy: '',
      elementContext: '',
    })

    expect(prompt).toContain('10-15秒')
    expect(prompt).toContain('尽量合并')
    expect(prompt).toContain('多格导演分镜图')
    expect(prompt).toContain('根据时长和节奏')
    expect(prompt).toContain('允许轻微重复')
    expect(prompt).toContain('强一致动作情节')
    expect(prompt).toContain('不要理解为最终视频的分屏')
  })

  it('makes self-check/fix prompts prefer fewer long video rows and not flag harmless repetition', async () => {
    const timelineCheck = fillPrompt('timelineCheck', { storyboardJson: '[]' })
    // visualBalanceCheck migrated to art-director-agent/prompts/critique-composition.md.
    const critiquePromptSource = (
      await import('@/lib/agents/art-director-agent/prompts/critique-composition.md?raw')
    ).default
    const applyFixes = fillPrompt('applyFixes', { storyboardJson: '[]', issuesList: 'none' })
    const combined = [timelineCheck, critiquePromptSource, applyFixes].join('\n')

    expect(combined).toContain('10-15秒')
    expect(combined).toContain('合并多个分镜')
    expect(combined).toContain('轻微重复')
    expect(combined).toContain('强一致动作情节')
  })

  it('propagates the multi-panel storyboard grid into beat-video prompts instead of only using motion text', () => {
    const beatVideoSection = storyboardGenerateSource.slice(
      storyboardGenerateSource.indexOf('const generateBeatVideo'),
      storyboardGenerateSource.indexOf('const result = await runCapability({', storyboardGenerateSource.indexOf('const generateBeatVideo')),
    )

    expect(beatVideoSection).toContain('row.storyboard_prompts')
    expect(beatVideoSection).toContain('导演分镜格信息')
    expect(beatVideoSection).toContain('not a literal split-screen')
    expect(beatVideoSection).toContain('Math.min(Math.max(Math.round(row.duration), 5), 15)')
  })

  it('keeps the direct chat storyboard schema aligned with the multi-panel grid contract', () => {
    expect(chatPanelSource).toContain('多格导演分镜图')
    expect(chatPanelSource).toContain('10-15秒')
    expect(chatPanelSource).toContain('不要理解为最终视频的分屏')
  })
})
