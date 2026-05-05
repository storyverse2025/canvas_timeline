import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const skillPath = path.join(repoRoot, '.claude/skills/director-shot-language-skill/SKILL.md')

describe('Director shot language Claude skill', () => {
  it('captures the 13-part directing and storyboard language framework', () => {
    expect(existsSync(skillPath)).toBe(true)

    const skill = readFileSync(skillPath, 'utf8')

    expect(skill).toContain('name: director-shot-language-skill')
    expect(skill).toContain('user-invocable: true')
    expect(skill).toContain('The Subject')
    expect(skill).toContain('Subject Presentation')
    expect(skill).toContain('Camera Angle')
    expect(skill).toContain('Composition · Focal · Aperture')
    expect(skill).toContain('Camera Movement')
    expect(skill).toContain('The 180° Rule')
    expect(skill).toContain('Long Dialogue Scenes')
    expect(skill).toContain('Fight Choreography')
    expect(skill).toContain('Long Exposition')
    expect(skill).toContain('The Director\'s Manifesto')
    expect(skill).toContain('一个镜头一个主体')
    expect(skill).toContain('跳轴必须是"我故意的"')
    expect(skill).toContain('有没有让观众这一秒的情绪，比上一秒更强')
  })
})
