import { describe, it, expect } from 'vitest'
import { PROVIDERS, getProvider, getModel, getModelsByKind } from '../registry'

describe('Provider Registry', () => {
  it('has 5 providers', () => {
    expect(PROVIDERS).toHaveLength(5)
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(['doubao', 'fal', 'gemini', 'libtv', 'openai'])
  })

  it('has 19+ total models', () => {
    const total = PROVIDERS.reduce((s, p) => s + p.models.length, 0)
    expect(total).toBeGreaterThanOrEqual(19)
  })

  it('has 9+ image models', () => {
    const imageModels = getModelsByKind('image')
    expect(imageModels.length).toBeGreaterThanOrEqual(9)
  })

  it('has 8+ video models', () => {
    const videoModels = getModelsByKind('video')
    expect(videoModels.length).toBeGreaterThanOrEqual(8)
  })

  it('doubao has Seedream 5.0', () => {
    const m = getModel('doubao', 'doubao-seedream-5-0-260128')
    expect(m).toBeDefined()
    expect(m!.kind).toBe('image')
  })

  it('doubao has Seedance 1.5 Pro with audio support', () => {
    const m = getModel('doubao', 'doubao-seedance-1-5-pro-251215')
    expect(m).toBeDefined()
    expect(m!.kind).toBe('video')
    expect(m!.supportsAudio).toBe(true)
    expect(m!.supportsFirstLastFrame).toBe(true)
  })

  it('fal has Kling v1.5 Pro', () => {
    const m = getModel('fal', 'fal-ai/kling-video/v1.5/pro/text-to-video')
    expect(m).toBeDefined()
    expect(m!.kind).toBe('video')
  })

  it('fal has Wan2.6', () => {
    const m = getModel('fal', 'fal-ai/wan-t2v')
    expect(m).toBeDefined()
    expect(m!.kind).toBe('video')
  })

  it('fal has MiniMax Hailuo', () => {
    const m = getModel('fal', 'fal-ai/minimax/video-01/text-to-video')
    expect(m).toBeDefined()
    expect(m!.kind).toBe('video')
  })

  it('fal has FLUX Ultra', () => {
    const m = getModel('fal', 'fal-ai/flux-pro/v1.1-ultra')
    expect(m).toBeDefined()
    expect(m!.kind).toBe('image')
  })

  it('video models have resolution info', () => {
    const seedance = getModel('doubao', 'doubao-seedance-2-0-260128')
    expect(seedance?.resolutions).toBeDefined()
    expect(seedance!.resolutions).toContain('720p')
    expect(seedance!.resolutions).toContain('1080p')
  })

  it('video models have duration info', () => {
    const seedance = getModel('doubao', 'doubao-seedance-2-0-fast-260128')
    expect(seedance?.durations).toBeDefined()
    expect(seedance!.durations).toContain(5)
    expect(seedance!.durations).toContain(10)
  })

  it('getModelsByKind returns provider info', () => {
    const models = getModelsByKind('video')
    const first = models[0]
    expect(first.provider).toBeDefined()
    expect(first.providerLabel).toBeDefined()
  })
})
