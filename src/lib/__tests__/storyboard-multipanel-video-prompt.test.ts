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
    expect(generateTableSource).toContain('只要场景不变')
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

  it('asks generation + self-check to design front/back transitions, ~1s 留白, and a transition_note field', () => {
    // Authoring side: generate-storyboard-table must emit + require transition_note,
    // with scene-change rows opening on a transition device and reserving ~1s 留白.
    expect(generateTableSource).toContain('transition_note')
    expect(generateTableSource).toContain('前后衔接')
    expect(generateTableSource).toContain('留白')
    expect(generateTableSource).toContain('对白关键词呼应')
    expect(generateTableSource).toContain('匹配剪辑')

    // Self-check side: critique must actively flag fragmented same-scene short rows
    // and validate the transition_note continuity design; fix must repair it.
    expect(critiqueTimelineSource).toContain('transition_note')
    expect(critiqueTimelineSource).toContain('留白')
    expect(critiqueTimelineSource).toContain('< 10s')
    expect(applyTimelineFixesSource).toContain('transition_note')
    expect(applyTimelineFixesSource).toContain('留白')
  })

  it('formats Beat Video prompts with Seedance-friendly structure instead of leaving row motion as loose prose', async () => {
    const { buildMotionDescription, clampDuration } = await import('@/lib/agents/cinematographer-agent')

    const desc = buildMotionDescription({
      row: {
        shot_number: 'S7',
        duration: 12,
        visual_description: 'rooftop chase under rain',
        character_actions: '阿莉回头确认追兵，压低重心冲向天台边缘',
        motion_prompts: '0-4秒慢推，4-8秒跟拍奔跑，8-12秒低角度仰拍起跳',
        storyboard_prompts: '三格导演分镜图：起跑、回望、跃起；不要理解为最终视频的分屏',
        dialogue: '阿莉：别停！',
        sound_effects: '雨声、急促脚步、衣料摩擦',
        bgm: '禁止配乐，只保留画内声音',
      },
      visualStyle: 'Final Fantasy CG, cinematic rain lighting',
      contextRefs: [
        { role: '角色1', description: '阿莉，红色雨衣' },
        { role: '场景', description: '霓虹天台' },
      ],
    })

    expect(desc).toContain('【Seedance 2.0 视频生成指令】')
    expect(desc).toContain('【分时段动作与运镜】')
    expect(desc).toContain('0-4秒慢推')
    expect(desc).toContain('【导演分镜格信息】')
    expect(desc).toContain('三格导演分镜图')
    expect(desc).toContain('不要理解为最终视频的分屏')
    expect(desc).toContain('not a literal split-screen')
    expect(desc).toContain('【参考素材用途】')
    expect(desc).toContain('角色1：阿莉，红色雨衣')
    expect(desc).toContain('【声音设计】')
    expect(desc).toContain('阿莉：别停！')
    expect(desc).toContain('雨声、急促脚步、衣料摩擦')
    expect(desc).toContain('Final Fantasy CG')

    // Duration is clamped to [5, 15] by clampDuration.
    expect(clampDuration(2)).toBe(5)
    expect(clampDuration(60)).toBe(15)
    expect(clampDuration(8)).toBe(8)
  })

  it('vendors a project-local Canvas Seedance prompt skill that adapts the external Seedance guide to API refs', () => {
    const skill = readFileSync('.claude/skills/canvas-seedance-video-prompt/SKILL.md', 'utf8')
    expect(skill).toContain('Canvas Timeline Seedance Video Prompt')
    expect(skill).toContain('不要原样照搬 @图片1')
    expect(skill).toContain('首帧')
    expect(skill).toContain('角色参考')
    expect(skill).toContain('4–15 秒')
  })

  it('keeps the direct chat storyboard schema aligned with the multi-panel grid contract', () => {
    expect(chatPanelSource).toContain('多格导演分镜图')
    expect(chatPanelSource).toContain('10-15秒')
    expect(chatPanelSource).toContain('不要理解为最终视频的分屏')
  })
})
