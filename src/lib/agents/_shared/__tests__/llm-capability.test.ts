import { describe, it, expect, vi, beforeEach } from 'vitest'

import { runCapability } from '@/lib/capabilities/client'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'

vi.mock('@/lib/capabilities/client', () => ({
  runCapability: vi.fn(),
}))
const mockedRunCapability = vi.mocked(runCapability)

describe('createCapabilityLLM', () => {
  beforeEach(() => {
    mockedRunCapability.mockReset()
  })

  it('routes calls through the element-extraction capability by default', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'text', text: 'hi' }] })
    const llm = createCapabilityLLM()
    const out = await llm.complete([{ role: 'user', content: 'ping' }])
    expect(out).toBe('hi')
    expect(mockedRunCapability).toHaveBeenCalledWith({
      capability: 'element-extraction',
      inputs: [{ kind: 'text', text: 'ping' }],
    })
  })

  it('prepends the system prompt before user messages', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'text', text: '' }] })
    const llm = createCapabilityLLM()
    await llm.complete([{ role: 'user', content: 'body' }], { system: 'SYS' })
    const sent = mockedRunCapability.mock.calls[0][0].inputs[0].text
    expect(sent.startsWith('SYS\n\n')).toBe(true)
    expect(sent).toContain('body')
  })

  it('preserves assistant turns as quoted prior context', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'text', text: '' }] })
    const llm = createCapabilityLLM()
    await llm.complete([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
    ])
    const sent = mockedRunCapability.mock.calls[0][0].inputs[0].text
    expect(sent).toContain('A')
    expect(sent).toContain('【prior assistant reply】\nB')
    expect(sent).toContain('C')
  })

  it('honors a custom capability id', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'text', text: 'x' }] })
    const llm = createCapabilityLLM({ capabilityId: 'script-rewrite' })
    await llm.complete([{ role: 'user', content: 'y' }])
    expect(mockedRunCapability.mock.calls[0][0].capability).toBe('script-rewrite')
  })

  it('returns empty string when the capability response has no outputs', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [] })
    const llm = createCapabilityLLM()
    const out = await llm.complete([{ role: 'user', content: 'q' }])
    expect(out).toBe('')
  })
})
