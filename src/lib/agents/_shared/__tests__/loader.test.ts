import { describe, it, expect } from 'vitest'
import { parseAgentSource } from '@/lib/agents/_shared/loader'

const SAMPLE = `---
name: script-agent
description: Turns vague ideas into shootable scripts.
model: claude-sonnet-4-5
tools:
  - capability: text-to-image
    provider: openai
    model: gpt-image-2
  - peer: actor-agent
subAgents:
  - framework-qa
  - writing-expansion
---

# Script Agent

Body of the system prompt.
`

describe('parseAgentSource', () => {
  it('parses meta from SKILL.md frontmatter', () => {
    const agent = parseAgentSource(SAMPLE, 'script-agent')
    expect(agent.slug).toBe('script-agent')
    expect(agent.meta.name).toBe('script-agent')
    expect(agent.meta.description).toMatch(/Turns vague ideas/)
    expect(agent.meta.model).toBe('claude-sonnet-4-5')
    expect(agent.meta.subAgents).toEqual(['framework-qa', 'writing-expansion'])
    expect(agent.meta.tools).toEqual([
      { capability: 'text-to-image', provider: 'openai', model: 'gpt-image-2' },
      { peer: 'actor-agent' },
    ])
  })

  it('strips frontmatter from systemPrompt', () => {
    const agent = parseAgentSource(SAMPLE, 'script-agent')
    expect(agent.systemPrompt.startsWith('# Script Agent')).toBe(true)
    expect(agent.systemPrompt).not.toMatch(/^---/)
  })

  it('keeps the raw source intact', () => {
    const agent = parseAgentSource(SAMPLE, 'script-agent')
    expect(agent.raw).toBe(SAMPLE)
  })

  it('falls back gracefully when frontmatter is missing fields', () => {
    const agent = parseAgentSource('# Only body\n', 'mystery')
    expect(agent.meta.name).toBe('unnamed-agent')
    expect(agent.meta.description).toBe('')
    expect(agent.meta.tools).toBeUndefined()
  })
})
