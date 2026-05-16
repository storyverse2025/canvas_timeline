import { describe, it, expect, vi } from 'vitest'
import { bindTools } from '@/lib/agents/_shared/tools/binder'
import type { CapabilitySpec } from '@/lib/capabilities/types'
import type { AgentModule } from '@/lib/agents/_shared/runtime/types'

const FAKE_CAPS: CapabilitySpec[] = [
  {
    id: 'text-to-image',
    category: 'image',
    label: 't2i',
    description: '',
    inputKinds: ['text'],
    outputKind: 'image',
    nodeTypes: ['text'],
  },
  {
    id: 'storyboard-qc',
    category: 'agent',
    label: 'qc',
    description: '',
    inputKinds: ['text'],
    outputKind: 'text',
    nodeTypes: ['text'],
  },
]

const fakePeer: AgentModule<unknown, unknown, unknown> = {
  meta: { name: 'actor-agent', description: '' },
  systemPrompt: '',
  run: async function* () {
    yield { type: 'result', payload: null }
  },
}

describe('bindTools', () => {
  it('returns empty bindings when nothing declared', () => {
    const bound = bindTools(undefined, {
      capabilities: FAKE_CAPS,
      peers: {},
      invoker: async () => ({ ok: true }),
    })
    expect(bound.capabilities).toEqual({})
    expect(bound.peers).toEqual({})
  })

  it('binds known capabilities with their invoker', async () => {
    const invoker = vi.fn(async () => ({ ok: true, data: 'img-url' }))
    const bound = bindTools(
      [{ capability: 'text-to-image', provider: 'openai', model: 'gpt-image-2' }],
      { capabilities: FAKE_CAPS, peers: {}, invoker },
    )
    expect(bound.capabilities['text-to-image']).toBeDefined()
    const result = await bound.capabilities['text-to-image'].invoke({ prompt: 'cat' })
    expect(result).toEqual({ ok: true, data: 'img-url' })
    expect(invoker).toHaveBeenCalledWith(
      { capability: 'text-to-image', provider: 'openai', model: 'gpt-image-2' },
      { prompt: 'cat' },
      undefined,
    )
  })

  it('binds peer agents by slug', () => {
    const bound = bindTools(
      [{ peer: 'actor-agent' }],
      { capabilities: FAKE_CAPS, peers: { 'actor-agent': fakePeer }, invoker: async () => ({ ok: true }) },
    )
    expect(bound.peers['actor-agent']).toBe(fakePeer)
  })

  it('throws on unknown capability id', () => {
    expect(() =>
      bindTools(
        [{ capability: 'mystery-tool' }],
        { capabilities: FAKE_CAPS, peers: {}, invoker: async () => ({ ok: true }) },
      ),
    ).toThrow(/unknown capability/)
  })

  it('throws on unknown peer slug', () => {
    expect(() =>
      bindTools(
        [{ peer: 'ghost' }],
        { capabilities: FAKE_CAPS, peers: {}, invoker: async () => ({ ok: true }) },
      ),
    ).toThrow(/unknown agent/)
  })

  it('throws on malformed binding shape', () => {
    expect(() =>
      bindTools(
        [{ wrong: 'shape' } as unknown as { peer: string }],
        { capabilities: FAKE_CAPS, peers: {}, invoker: async () => ({ ok: true }) },
      ),
    ).toThrow(/Unknown tool binding shape/)
  })
})
