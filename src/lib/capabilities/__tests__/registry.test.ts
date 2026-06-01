import { describe, it, expect } from 'vitest'
import {
  CAPABILITIES,
  getCapability,
  getCapabilitiesByCategory,
  getCapabilitiesForNodeType,
} from '../registry'
import type { CapabilitySpec } from '../types'

describe('CAPABILITIES registry', () => {
  it('has all 33 capabilities', () => {
    expect(CAPABILITIES.length).toBe(33)
  })

  it('has unique ids', () => {
    const ids = CAPABILITIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every capability has required fields', () => {
    for (const c of CAPABILITIES) {
      expect(c.id).toBeTruthy()
      expect(c.category).toMatch(/^(agent|image|video|audio)$/)
      expect(c.label).toBeTruthy()
      expect(c.description).toBeTruthy()
      expect(c.inputKinds.length).toBeGreaterThan(0)
      expect(c.outputKind).toMatch(/^(text|image|video|audio)$/)
      expect(c.nodeTypes.length).toBeGreaterThan(0)
    }
  })

  it('categories have expected counts', () => {
    const counts = { agent: 0, image: 0, video: 0, audio: 0 }
    for (const c of CAPABILITIES) counts[c.category]++
    expect(counts.agent).toBe(9)
    expect(counts.image).toBe(11)
    expect(counts.video).toBe(9)
    expect(counts.audio).toBe(4)
  })

  it('param options have value and label', () => {
    for (const c of CAPABILITIES) {
      for (const p of c.params ?? []) {
        if (p.options) {
          for (const o of p.options) {
            expect(o.value).toBeTruthy()
            expect(o.label).toBeTruthy()
          }
        }
      }
    }
  })
})

describe('getCapability', () => {
  it('returns capability by id', () => {
    const c = getCapability('text-to-image')
    expect(c).toBeDefined()
    expect(c!.category).toBe('image')
  })

  it('returns undefined for unknown id', () => {
    expect(getCapability('nonexistent')).toBeUndefined()
  })
})

describe('getCapabilitiesByCategory', () => {
  it('returns only agent capabilities', () => {
    const caps = getCapabilitiesByCategory('agent')
    expect(caps.length).toBe(9)
    expect(caps.every((c) => c.category === 'agent')).toBe(true)
  })

  it('returns only image capabilities', () => {
    const caps = getCapabilitiesByCategory('image')
    expect(caps.length).toBe(11)
    expect(caps.every((c) => c.category === 'image')).toBe(true)
  })

  it('returns only video capabilities', () => {
    const caps = getCapabilitiesByCategory('video')
    expect(caps.length).toBe(9)
  })

  it('returns only audio capabilities', () => {
    const caps = getCapabilitiesByCategory('audio')
    expect(caps.length).toBe(4)
  })
})

describe('getCapabilitiesForNodeType', () => {
  it('returns capabilities for image nodes', () => {
    const caps = getCapabilitiesForNodeType('image')
    expect(caps.length).toBeGreaterThan(0)
    expect(caps.every((c) => c.nodeTypes.includes('image'))).toBe(true)
  })

  it('returns capabilities for text nodes', () => {
    const caps = getCapabilitiesForNodeType('text')
    expect(caps.length).toBeGreaterThan(0)
    expect(caps.every((c) => c.nodeTypes.includes('text'))).toBe(true)
  })

  it('image node has image editing and image-to-video creation capabilities, not video-post capabilities', () => {
    const caps = getCapabilitiesForNodeType('image')
    const ids = caps.map((c) => c.id)
    expect(ids).toContain('smart-edit')
    expect(ids).toContain('upscale-image')
    expect(ids).toContain('outpaint')
    expect(ids).toContain('text-to-video')
    expect(ids).toContain('multi-angle')
    expect(ids).not.toContain('upscale-video')
    expect(ids).not.toContain('lip-sync')
    expect(ids).not.toContain('video-split')
    expect(ids).not.toContain('video-style-transfer')
  })

  it('video node owns video-post capabilities that require current video input', () => {
    const caps = getCapabilitiesForNodeType('video')
    const ids = caps.map((c) => c.id)
    expect(ids).toContain('upscale-video')
    expect(ids).toContain('lip-sync')
    expect(ids).toContain('video-split')
    expect(ids).toContain('video-style-transfer')
    expect(ids).toContain('universal-video')
    expect(ids).not.toContain('smart-edit')
    expect(ids).not.toContain('upscale-image')
  })

  it('text node has agent and generation capabilities', () => {
    const caps = getCapabilitiesForNodeType('text')
    const ids = caps.map((c) => c.id)
    expect(ids).toContain('script-rewrite')
    expect(ids).toContain('script-breakdown')
    expect(ids).toContain('shot-extraction')
    expect(ids).toContain('text-to-image')
    expect(ids).toContain('preset-voice')
  })

  it('returns empty for unknown node type', () => {
    const caps = getCapabilitiesForNodeType('unknown')
    expect(caps.length).toBe(0)
  })
})

describe('capability input/output consistency', () => {
  const imageOutputCaps = CAPABILITIES.filter((c) => c.outputKind === 'image')
  const videoOutputCaps = CAPABILITIES.filter((c) => c.outputKind === 'video')
  const audioOutputCaps = CAPABILITIES.filter((c) => c.outputKind === 'audio')
  const textOutputCaps = CAPABILITIES.filter((c) => c.outputKind === 'text')

  it('image output capabilities accept image or text input', () => {
    for (const c of imageOutputCaps) {
      const hasImageOrText = c.inputKinds.includes('image') || c.inputKinds.includes('text')
      expect(hasImageOrText).toBe(true)
    }
  })

  it('video output capabilities accept video, image, or text input', () => {
    for (const c of videoOutputCaps) {
      const hasInput = c.inputKinds.some((k) => ['video', 'image', 'text'].includes(k))
      expect(hasInput).toBe(true)
    }
  })

  it('audio output capabilities accept text or audio input', () => {
    for (const c of audioOutputCaps) {
      const hasInput = c.inputKinds.some((k) => ['text', 'audio'].includes(k))
      expect(hasInput).toBe(true)
    }
  })
})

describe('specific capability specs', () => {
  it('text-to-video exposes the full 4-15s Seedance 2.0 duration range', () => {
    const c = getCapability('text-to-video')!
    const dur = c.params?.find((p) => p.key === 'duration')
    expect(dur).toBeDefined()
    expect(dur!.options?.map((o) => o.value)).toEqual(
      ['4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
    )
  })

  it('upscale-image has scale param with 2/4 options', () => {
    const c = getCapability('upscale-image')!
    const scale = c.params?.find((p) => p.key === 'scale')
    expect(scale).toBeDefined()
    expect(scale!.options?.map((o) => o.value)).toEqual(['2', '4'])
  })

  it('multi-angle has angle param', () => {
    const c = getCapability('multi-angle')!
    const angle = c.params?.find((p) => p.key === 'angle')
    expect(angle).toBeDefined()
    expect(angle!.options!.length).toBeGreaterThanOrEqual(4)
  })

  it('script-rewrite has style param', () => {
    const c = getCapability('script-rewrite')!
    const style = c.params?.find((p) => p.key === 'style')
    expect(style).toBeDefined()
    expect(style!.options!.length).toBeGreaterThanOrEqual(3)
  })

  it('preset-voice has voice_id param', () => {
    const c = getCapability('preset-voice')!
    const voice = c.params?.find((p) => p.key === 'voice_id')
    expect(voice).toBeDefined()
    expect(voice!.options!.length).toBeGreaterThanOrEqual(4)
  })
})
