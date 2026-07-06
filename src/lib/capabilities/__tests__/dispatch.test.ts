import { describe, it, expect } from 'vitest'
import { CAPABILITIES, getCapability } from '../registry'

describe('dispatch coverage', () => {
  const expectedHandlers = [
    'script-rewrite', 'script-breakdown', 'element-extraction', 'shot-extraction', 'consistency-check', 'storyboard-qc',
    'bridge-row-judge',
    'cinematography-describe',
    'freeform-text',
    'storyboard-generation', 'voice-casting',
    'text-to-image', 'batch-image', 'smart-edit', 'inpaint', 'upscale-image', 'outpaint',
    'crop-image', 'shot-association', 'multi-angle', 'angle-adjust', 'pose-edit',
    'text-to-video', 'first-last-frame', 'multi-ref-video', 'universal-video',
    'upscale-video', 'lip-sync', 'motion-imitation', 'video-split', 'video-style-transfer',
    'preset-voice', 'voice-clone', 'polyphonic', 'sound-effects',
  ]

  it('every registered capability has a handler', () => {
    for (const cap of CAPABILITIES) {
      expect(expectedHandlers).toContain(cap.id)
    }
  })

  it('every handler has a registered capability', () => {
    for (const id of expectedHandlers) {
      expect(getCapability(id)).toBeDefined()
    }
  })

  it('handler count matches capability count (35)', () => {
    expect(expectedHandlers.length).toBe(35)
    expect(CAPABILITIES.length).toBe(35)
  })
})

describe('input extraction logic', () => {
  type TestInput = { kind: string; text?: string; url?: string }

  function getText(inputs: TestInput[]) {
    return inputs.filter((i) => i.kind === 'text').map((i) => i.text ?? '').join('\n').trim()
  }
  function getImages(inputs: TestInput[]) {
    return inputs.filter((i) => i.kind === 'image' && i.url).map((i) => i.url!)
  }
  function getVideos(inputs: TestInput[]) {
    return inputs.filter((i) => i.kind === 'video' && i.url).map((i) => i.url!)
  }
  function getAudios(inputs: TestInput[]) {
    return inputs.filter((i) => i.kind === 'audio' && i.url).map((i) => i.url!)
  }

  it('getText extracts and joins text inputs', () => {
    const inputs = [
      { kind: 'text', text: 'hello' },
      { kind: 'image', url: 'img.png' },
      { kind: 'text', text: 'world' },
    ]
    expect(getText(inputs)).toBe('hello\nworld')
  })

  it('getText returns empty for no text inputs', () => {
    expect(getText([{ kind: 'image', url: 'x.png' }])).toBe('')
  })

  it('getImages extracts image URLs', () => {
    const inputs = [
      { kind: 'image', url: 'a.png' },
      { kind: 'text', text: 'hi' },
      { kind: 'image', url: 'b.jpg' },
      { kind: 'image' }, // no url
    ]
    expect(getImages(inputs)).toEqual(['a.png', 'b.jpg'])
  })

  it('getVideos extracts video URLs', () => {
    const inputs = [
      { kind: 'video', url: 'clip.mp4' },
      { kind: 'image', url: 'img.png' },
    ]
    expect(getVideos(inputs)).toEqual(['clip.mp4'])
  })

  it('getAudios extracts audio URLs', () => {
    const inputs = [
      { kind: 'audio', url: 'voice.mp3' },
      { kind: 'text', text: 'lyrics' },
    ]
    expect(getAudios(inputs)).toEqual(['voice.mp3'])
  })
})

describe('capability-node type mapping', () => {
  it('image node gets image editing + image-to-video creation, but not video-post capabilities', () => {
    const imageCaps = CAPABILITIES.filter((c) => c.nodeTypes.includes('image'))
    const ids = imageCaps.map((c) => c.id)
    expect(ids).toContain('text-to-video')
    expect(ids).toContain('first-last-frame')
    expect(ids).not.toContain('upscale-video')
    expect(ids).not.toContain('lip-sync')
    expect(ids).not.toContain('video-split')
  })

  it('video node gets capabilities that require current video input', () => {
    const videoCaps = CAPABILITIES.filter((c) => c.nodeTypes.includes('video'))
    const ids = videoCaps.map((c) => c.id)
    expect(ids).toContain('upscale-video')
    expect(ids).toContain('lip-sync')
    expect(ids).toContain('video-split')
    expect(ids).toContain('video-style-transfer')
  })

  it('text node gets agent + generation + audio capabilities', () => {
    const textCaps = CAPABILITIES.filter((c) => c.nodeTypes.includes('text'))
    const categories = new Set(textCaps.map((c) => c.category))
    expect(categories.has('agent')).toBe(true)
    expect(categories.has('image')).toBe(true)
    expect(categories.has('audio')).toBe(true)
  })
})
