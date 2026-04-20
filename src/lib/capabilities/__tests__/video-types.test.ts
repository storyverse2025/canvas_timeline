import { describe, it, expect } from 'vitest'
import { detectVideoType, buildContentParts, filterAccessible } from '../video-types'

describe('detectVideoType', () => {
  it('text only → text-to-video', () => {
    expect(detectVideoType({ images: [], videos: [], audios: [] })).toBe('text-to-video')
  })

  it('1 image → image-to-video-first', () => {
    expect(detectVideoType({ images: ['https://a.png'], videos: [], audios: [] })).toBe('image-to-video-first')
  })

  it('2 images default → image-to-video-first-last', () => {
    expect(detectVideoType({ images: ['a', 'b'], videos: [], audios: [] })).toBe('image-to-video-first-last')
  })

  it('2 images with reference mode → reference-to-video', () => {
    expect(detectVideoType({ images: ['a', 'b'], videos: [], audios: [], mode: 'reference' })).toBe('reference-to-video')
  })

  it('3+ images → reference-to-video', () => {
    expect(detectVideoType({ images: ['a', 'b', 'c'], videos: [], audios: [] })).toBe('reference-to-video')
  })

  it('has video → universal-to-video', () => {
    expect(detectVideoType({ images: [], videos: ['v.mp4'], audios: [] })).toBe('universal-to-video')
  })

  it('has audio → universal-to-video', () => {
    expect(detectVideoType({ images: ['a'], videos: [], audios: ['a.mp3'] })).toBe('universal-to-video')
  })

  it('mixed media → universal-to-video', () => {
    expect(detectVideoType({ images: ['a', 'b'], videos: ['v'], audios: ['x'] })).toBe('universal-to-video')
  })
})

describe('buildContentParts', () => {
  it('text-only generates single text part', () => {
    const parts = buildContentParts('a cat', { images: [], videos: [], audios: [] }, 'text-to-video')
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('text')
  })

  it('first frame adds image with role first_frame', () => {
    const parts = buildContentParts('walk', { images: ['https://img.jpg'], videos: [], audios: [] }, 'image-to-video-first')
    expect(parts).toHaveLength(2)
    expect(parts[1].role).toBe('first_frame')
  })

  it('first-last adds two images with first_frame + last_frame', () => {
    const parts = buildContentParts('', { images: ['a', 'b'], videos: [], audios: [] }, 'image-to-video-first-last')
    expect(parts).toHaveLength(3)
    expect(parts[1].role).toBe('first_frame')
    expect(parts[2].role).toBe('last_frame')
  })

  it('reference adds all images with role reference_image', () => {
    const parts = buildContentParts('', { images: ['a', 'b', 'c'], videos: [], audios: [] }, 'reference-to-video')
    expect(parts).toHaveLength(4)
    expect(parts.slice(1).every((p) => p.role === 'reference_image')).toBe(true)
  })

  it('reference caps at 9 images', () => {
    const images = Array.from({ length: 12 }, (_, i) => `img${i}`)
    const parts = buildContentParts('', { images, videos: [], audios: [] }, 'reference-to-video')
    expect(parts).toHaveLength(10) // 1 text + 9 images
  })

  it('universal combines images + videos + audios with correct roles', () => {
    const parts = buildContentParts('', {
      images: ['i1', 'i2'], videos: ['v1'], audios: ['a1'],
    }, 'universal-to-video')
    const types = parts.map((p) => p.type)
    const roles = parts.map((p) => p.role).filter(Boolean)
    expect(types).toContain('image_url')
    expect(types).toContain('video_url')
    expect(types).toContain('audio_url')
    expect(roles).toContain('reference_image')
    expect(roles).toContain('reference_video')
    expect(roles).toContain('reference_audio')
  })

  it('universal caps videos at 3 and audios at 3', () => {
    const videos = Array.from({ length: 5 }, (_, i) => `v${i}`)
    const audios = Array.from({ length: 5 }, (_, i) => `a${i}`)
    const parts = buildContentParts('', { images: [], videos, audios }, 'universal-to-video')
    const videoParts = parts.filter((p) => p.type === 'video_url')
    const audioParts = parts.filter((p) => p.type === 'audio_url')
    expect(videoParts).toHaveLength(3)
    expect(audioParts).toHaveLength(3)
  })
})

describe('filterAccessible', () => {
  it('allows http(s) and data: URLs', () => {
    expect(filterAccessible(['https://example.com/x.jpg', 'http://a.com/b.png', 'data:image/png;base64,abc'])).toHaveLength(3)
  })

  it('rejects relative paths and empty strings', () => {
    expect(filterAccessible(['/uploads/x.png', '', '  '])).toHaveLength(0)
  })

  it('rejects URLs shorter than 11 chars', () => {
    expect(filterAccessible(['http://a'])).toHaveLength(0)
  })
})
