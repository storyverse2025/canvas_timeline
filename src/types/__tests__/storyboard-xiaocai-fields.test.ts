import { describe, expect, it } from 'vitest'
import { validateStoryboard } from '@/types/storyboard'
import generateTableSource from '@/lib/agents/director-agent/prompts/generate-storyboard-table.md?raw'

describe('XiaoCai storyboard table fields', () => {
  it('defaults the actor motivation and emotion atmosphere fields for every storyboard row', () => {
    const result = validateStoryboard([
      {
        shot_number: 'S1',
        duration: 3,
        visual_description: '角色停在门口。',
      },
    ])

    expect(result.ok).toBe(true)
    expect(result.rows?.[0]).toMatchObject({
      emotion_atmosphere: '',
      character_motivation: '',
      character_psychology: '',
      performance_guidance: '',
    })
  })

  it('asks storyboard generation to use XiaoCai script-to-storyboard rules and output the new table columns', () => {
    // storyboardGeneration migrated to director-agent/prompts/generate-storyboard-table.md.
    expect(generateTableSource).toContain('小蔡剧本转分镜 Skill')
    expect(generateTableSource).toContain('情绪锚点')
    expect(generateTableSource).toContain('角色动机')
    expect(generateTableSource).toContain('心理状态')
    expect(generateTableSource).toContain('emotion_atmosphere')
    expect(generateTableSource).toContain('character_motivation')
    expect(generateTableSource).toContain('character_psychology')
    expect(generateTableSource).toContain('performance_guidance')
  })
})
