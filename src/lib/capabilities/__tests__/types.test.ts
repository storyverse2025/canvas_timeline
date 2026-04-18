import { describe, it, expect } from 'vitest'
import type {
  CapabilityCategory,
  InputKind,
  OutputKind,
  CapabilitySpec,
  CapabilityParam,
  CapabilityInput,
  CapabilityRequest,
  CapabilityResponse,
  CapabilityOutput,
} from '../types'

describe('type contracts', () => {
  it('CapabilityRequest can be constructed', () => {
    const req: CapabilityRequest = {
      capability: 'text-to-image',
      inputs: [
        { kind: 'text', text: 'a cat' },
        { kind: 'image', url: 'https://example.com/ref.png' },
      ],
      params: { aspect: '16:9' },
    }
    expect(req.capability).toBe('text-to-image')
    expect(req.inputs.length).toBe(2)
    expect(req.params?.aspect).toBe('16:9')
  })

  it('CapabilityResponse can be constructed', () => {
    const res: CapabilityResponse = {
      outputs: [
        { kind: 'image', url: 'https://example.com/result.png' },
      ],
    }
    expect(res.outputs.length).toBe(1)
    expect(res.outputs[0].kind).toBe('image')
  })

  it('CapabilityRequest works with minimal fields', () => {
    const req: CapabilityRequest = {
      capability: 'upscale-image',
      inputs: [{ kind: 'image', url: 'https://example.com/img.png' }],
    }
    expect(req.params).toBeUndefined()
  })

  it('CapabilityOutput can hold text', () => {
    const out: CapabilityOutput = { kind: 'text', text: 'analysis result' }
    expect(out.text).toBe('analysis result')
    expect(out.url).toBeUndefined()
  })

  it('CapabilitySpec with params validates', () => {
    const spec: CapabilitySpec = {
      id: 'test',
      category: 'image',
      label: 'Test',
      description: 'Test capability',
      inputKinds: ['image', 'text'],
      outputKind: 'image',
      nodeTypes: ['image'],
      params: [
        { key: 'scale', label: 'Scale', type: 'select', options: [{ value: '2', label: '2x' }], default: '2' },
        { key: 'prompt', label: 'Prompt', type: 'string', required: true },
      ],
    }
    expect(spec.params!.length).toBe(2)
    expect(spec.params![0].options!.length).toBe(1)
  })

  it('all category values are valid', () => {
    const valid: CapabilityCategory[] = ['agent', 'image', 'video', 'audio']
    for (const v of valid) {
      expect(['agent', 'image', 'video', 'audio']).toContain(v)
    }
  })

  it('all input/output kind values are valid', () => {
    const validInput: InputKind[] = ['text', 'image', 'video', 'audio']
    const validOutput: OutputKind[] = ['text', 'image', 'video', 'audio']
    expect(validInput).toEqual(validOutput)
  })
})
