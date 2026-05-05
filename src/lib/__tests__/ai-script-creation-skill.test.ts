import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const skillPath = path.join(repoRoot, '.claude/skills/ai-script-creation-skill/SKILL.md')
const bridgePath = path.join(repoRoot, 'claude-bridge.mjs')

describe('AI script creation Claude skill', () => {
  it('exists as a user-invocable Claude skill with the required scripting workflow', () => {
    expect(existsSync(skillPath)).toBe(true)

    const skill = readFileSync(skillPath, 'utf8')

    expect(skill).toContain('name: ai-script-creation-skill')
    expect(skill).toContain('user-invocable: true')
    expect(skill).toContain('LLM 不是一次性出稿机器')
    expect(skill).toContain('世界观 → 核心冲突 → 人物小传 → 故事大纲 → 场景设计 → 台词 → 完整剧本 → 分镜提示词')
    expect(skill).toContain('先判断 Seedance 模式')
    expect(skill).toContain('character_reference')
    expect(skill).toContain('不要默认所有带图任务都是 first_frame')
    expect(skill).toContain('项目档案')
  })

  it('runs the Claude bridge from the repo root so project .claude skills are discoverable', () => {
    const bridge = readFileSync(bridgePath, 'utf8')

    expect(bridge).toContain('const PROJECT_ROOT =')
    expect(bridge).toContain('cwd: PROJECT_ROOT')
  })
})
