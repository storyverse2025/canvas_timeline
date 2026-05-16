import { describe, it, expect } from 'vitest'

import generateTableSource from '@/lib/agents/director-agent/prompts/generate-storyboard-table.md?raw'
import applyTimelineFixesSource from '@/lib/agents/director-agent/prompts/apply-timeline-fixes.md?raw'
import critiqueTimelineSource from '@/lib/agents/director-agent/prompts/critique-timeline.md?raw'
import {
  collectDurationIssues,
  MAX_ROW_DURATION_SECONDS,
  MIN_ROW_DURATION_SECONDS,
} from '@/lib/director-assistant'

describe('director-agent duration constraint contract', () => {
  it('generate-storyboard-table prompt embeds the total-duration rule and per-row bounds', () => {
    expect(generateTableSource).toContain('时长硬约束')
    // Template variable {{totalDurationSeconds}} appears multiple times — verify
    // the placeholder is wired in (substitution happens at runtime via fillTemplate).
    expect(generateTableSource).toContain('{{totalDurationSeconds}} 秒')
    expect(generateTableSource).toContain('Σ duration == {{totalDurationSeconds}}')
    expect(generateTableSource).toContain('容差 ±0.5s')
    expect(generateTableSource).toContain('2 ≤ duration ≤ 15')
    expect(generateTableSource).toContain('> 15s 的行必须立即拆分')
    expect(generateTableSource).toContain('< 2s 的行必须与相邻行合并')
  })

  it('apply-timeline-fixes prompt re-locks both bounds so a fix pass never drifts back', () => {
    expect(applyTimelineFixesSource).toContain('总时长锁定为 {{totalDurationSeconds}} 秒')
    expect(applyTimelineFixesSource).toContain('容差 ±0.5s')
    expect(applyTimelineFixesSource).toContain('duration 必须 ∈ [2, 15] 秒')
    expect(applyTimelineFixesSource).toContain('> 15s 的行必须拆分')
    expect(applyTimelineFixesSource).toContain('< 2s 的行必须与相邻行合并')
  })

  it('critique-timeline prompt mentions the per-row duration bounds', () => {
    expect(critiqueTimelineSource).toContain('每行 duration 必须 ∈ [2, 15] 秒')
  })
})

describe('collectDurationIssues', () => {
  it('returns empty for an in-range, well-summed storyboard', () => {
    const json = JSON.stringify([
      { shot_number: 'S1', duration: 5 },
      { shot_number: 'S2', duration: 10 },
      { shot_number: 'S3', duration: 15 },
    ])
    expect(collectDurationIssues(json, 30)).toEqual([])
  })

  it('flags rows above the max bound (the 60s problem)', () => {
    const json = JSON.stringify([{ shot_number: 'S1', duration: 60 }])
    const issues = collectDurationIssues(json, 60)
    expect(issues.some((i) => i.includes('S1') && i.includes('60s 过长'))).toBe(true)
    expect(issues.some((i) => i.includes('拆分为多行'))).toBe(true)
  })

  it('flags rows below the min bound', () => {
    const json = JSON.stringify([
      { shot_number: 'S1', duration: 1 },
      { shot_number: 'S2', duration: 29 }, // also too long, but tests min path
    ])
    const issues = collectDurationIssues(json, 30)
    expect(issues.some((i) => i.includes('S1') && i.includes('过短'))).toBe(true)
  })

  it('flags missing/non-numeric duration', () => {
    const json = JSON.stringify([
      { shot_number: 'S1' },
      { shot_number: 'S2', duration: 'oops' },
    ])
    const issues = collectDurationIssues(json, 10)
    expect(issues.filter((i) => i.includes('缺失或非数字'))).toHaveLength(2)
  })

  it('flags total-duration drift independently of per-row issues', () => {
    const json = JSON.stringify([
      { shot_number: 'S1', duration: 5 },
      { shot_number: 'S2', duration: 5 },
    ])
    const issues = collectDurationIssues(json, 30)
    expect(issues.some((i) => i.startsWith('ALL:'))).toBe(true)
  })

  it('tolerates 0.5s rounding drift on the total', () => {
    const json = JSON.stringify([
      { shot_number: 'S1', duration: 5.4 },
      { shot_number: 'S2', duration: 4.7 },
    ])
    expect(collectDurationIssues(json, 10).filter((i) => i.startsWith('ALL:'))).toHaveLength(0)
  })

  it('returns empty for unparseable input rather than throwing', () => {
    expect(collectDurationIssues('not json', 30)).toEqual([])
  })

  it('exports stable MIN/MAX constants the prompts can stay in sync with', () => {
    expect(MIN_ROW_DURATION_SECONDS).toBe(2)
    expect(MAX_ROW_DURATION_SECONDS).toBe(15)
  })
})
