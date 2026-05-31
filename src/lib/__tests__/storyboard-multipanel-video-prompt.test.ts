import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import generateTableSource from '@/lib/agents/director-agent/prompts/generate-storyboard-table.md?raw'
import critiqueTimelineSource from '@/lib/agents/director-agent/prompts/critique-timeline.md?raw'
import applyTimelineFixesSource from '@/lib/agents/director-agent/prompts/apply-timeline-fixes.md?raw'
import critiqueCompositionSource from '@/lib/agents/art-director-agent/prompts/critique-composition.md?raw'

const storyboardGenerateSource = readFileSync('src/hooks/useStoryboardGenerate.ts', 'utf8')
const chatPanelSource = readFileSync('src/components/chat/ChatPanel.tsx', 'utf8')

describe('multi-panel director storyboard and Seedance prompt contract', () => {
  it('asks storyboard generation to merge continuous beats into 10-15s rows with multi-panel director grids', () => {
    // storyboardGeneration migrated to director-agent/prompts/generate-storyboard-table.md.
    expect(generateTableSource).toContain('10-15秒')
    expect(generateTableSource).toContain('尽量合并')
    expect(generateTableSource).toContain('多格导演分镜图')
    expect(generateTableSource).toContain('根据时长和节奏')
    expect(generateTableSource).toContain('允许轻微重复')
    expect(generateTableSource).toContain('强一致动作情节')
    expect(generateTableSource).toContain('不要理解为最终视频的分屏')
  })

  it('makes self-check/fix prompts prefer fewer long video rows and not flag harmless repetition', () => {
    const combined = [
      critiqueTimelineSource,
      critiqueCompositionSource,
      applyTimelineFixesSource,
    ].join('\n')

    expect(combined).toContain('10-15秒')
    expect(combined).toContain('合并多个分镜')
    expect(combined).toContain('轻微重复')
    expect(combined).toContain('强一致动作情节')
  })

  it('surfaces motion_prompts / visual_description (and the rest of the row beat fields) in the Seedance prompt — keyframe + Seedance now pull the same direction', async () => {
    // History: an earlier contract stripped every row field except
    // dialogue + SFX from the Seedance prompt to avoid biasing the
    // model off the keyframe. In practice that compounded the
    // generation pipeline's info loss — the keyframe itself was already
    // a lossy compression of the script, and dropping the row text on
    // top of that produced videos that visibly ignored the user's
    // script. The keyframe builder (director-agent.buildKeyframePrompt)
    // now surfaces every populated row field too, so reinforcing them
    // in the Seedance prompt keeps both stages aligned with the user's
    // intent instead of fighting each other.
    const { buildMotionDescription, clampDuration } = await import('@/lib/agents/cinematographer-agent')

    const desc = buildMotionDescription({
      row: {
        motion_prompts: 'push in',
        storyboard_prompts: '3-panel grid',
        visual_description: 'rooftop',
      },
    })
    expect(desc).toContain('【行字段锚点 / ROW BEAT ANCHORS】')
    expect(desc).toContain('运镜意图 / Motion intent: push in')
    expect(desc).toContain('画面 / Visual: rooftop')
    // storyboard_prompts is the panel-grid spec for the KEYFRAME, not
    // the video — keep it out of the video text so we don't tell
    // Seedance to literally render a multi-panel grid.
    expect(desc).not.toContain('3-panel grid')

    // Duration is clamped to [5, 15] by clampDuration (was inline math
    // Math.min(Math.max(Math.round(row.duration), 5), 15) in the legacy hook).
    expect(clampDuration(2)).toBe(5)
    expect(clampDuration(60)).toBe(15)
    expect(clampDuration(8)).toBe(8)
  })

  it('keeps the direct chat storyboard schema aligned with the multi-panel grid contract', () => {
    expect(chatPanelSource).toContain('多格导演分镜图')
    expect(chatPanelSource).toContain('10-15秒')
    expect(chatPanelSource).toContain('不要理解为最终视频的分屏')
  })
})
