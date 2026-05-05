import { describe, expect, it } from 'vitest'
import { validateStoryboard } from '@/types/storyboard'
import { fillPrompt } from '@/lib/prompts'

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
    const prompt = fillPrompt('storyboardGeneration', {
      artStyle: 'cinematic',
      characterDesigns: '[]',
      sceneDesigns: '[]',
      propDesigns: '[]',
      shotAllocation: '[]',
      shotComposition: '[]',
      visualStrategy: '',
      elementContext: '',
    })

    expect(prompt).toContain('小蔡剧本转分镜 Skill')
    expect(prompt).toContain('情绪锚点')
    expect(prompt).toContain('角色动机')
    expect(prompt).toContain('心理状态')
    expect(prompt).toContain('emotion_atmosphere')
    expect(prompt).toContain('character_motivation')
    expect(prompt).toContain('character_psychology')
    expect(prompt).toContain('performance_guidance')
  })
})
