import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectVideoType,
  filterValidRefs,
  inlineLocalRefsInContentParts,
  isSeedanceMediaUrl,
} from '../../../vite-capabilities-plugin'

describe('isSeedanceMediaUrl — used to gate refs into Seedance calls', () => {
  it('accepts absolute http / https URLs', () => {
    expect(isSeedanceMediaUrl('https://cdn.example.com/keyframe.png')).toBe(true)
    expect(isSeedanceMediaUrl('http://localhost:8080/x.jpg')).toBe(true)
  })

  it('accepts root-relative /uploads/ and /voices/ paths (Vite-served files)', () => {
    // Regression: previously rejected → "全能生视频至少需要 1 张图片或 1 个视频"
    // when the keyframe lived under /uploads/ (right-click → 全能参考生视频).
    expect(isSeedanceMediaUrl('/uploads/abc123.png')).toBe(true)
    expect(isSeedanceMediaUrl('/voices/800+%E9%9F%B3%E8%89%B2/x.mp3')).toBe(true)
  })

  it('accepts supported raster data: URLs', () => {
    // Minimal valid base64 image (the validator just checks shape).
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
    expect(isSeedanceMediaUrl(url)).toBe(true)
  })

  it('rejects garbage strings, empty values, and unsupported data: types', () => {
    expect(isSeedanceMediaUrl('')).toBe(false)
    expect(isSeedanceMediaUrl('x')).toBe(false)
    expect(isSeedanceMediaUrl('not a url')).toBe(false)
    expect(isSeedanceMediaUrl('data:image/gif;base64,xyz')).toBe(false) // gif unsupported
  })
})

describe('filterValidRefs', () => {
  it('drops invalid refs but keeps valid root-relative paths', () => {
    const out = filterValidRefs([
      'https://ok.example.com/a.png',
      '/uploads/local.png',
      '/voices/voice.mp3',
      '',
      'garbage',
    ])
    expect(out).toEqual([
      'https://ok.example.com/a.png',
      '/uploads/local.png',
      '/voices/voice.mp3',
    ])
  })
})

describe('detectVideoType — promotes to universal-to-video when audios or videos are present', () => {
  it('text-only → text-to-video', () => {
    expect(detectVideoType({ images: [], videos: [], audios: [] })).toBe('text-to-video')
  })
  it('one image → image-to-video-first', () => {
    expect(detectVideoType({ images: ['a'], videos: [], audios: [] })).toBe('image-to-video-first')
  })
  it("any audio → universal-to-video (regression: textToVideo used to hard-code audios=[] and silently drop voice refs)", () => {
    expect(detectVideoType({ images: ['a'], videos: [], audios: ['v'] })).toBe('universal-to-video')
  })
  it('any video → universal-to-video', () => {
    expect(detectVideoType({ images: ['a'], videos: ['v'], audios: [] })).toBe('universal-to-video')
  })
})

describe('inlineLocalRefsInContentParts — rewrites root-relative URLs to data: URLs from disk', () => {
  let workdir: string
  let origCwd: string

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'seedance-url-'))
    mkdirSync(join(workdir, 'public', 'uploads'), { recursive: true })
    mkdirSync(join(workdir, 'public', 'voices'), { recursive: true })
    writeFileSync(join(workdir, 'public', 'uploads', 'kf.png'), Buffer.from('PNGDATA'))
    writeFileSync(join(workdir, 'public', 'voices', 'a.mp3'), Buffer.from('MP3DATA'))
    origCwd = process.cwd()
    process.chdir(workdir)
  })
  afterEach(() => {
    process.chdir(origCwd)
    rmSync(workdir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('inlines a root-relative image_url to a base64 data URL', async () => {
    const out = await inlineLocalRefsInContentParts([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: '/uploads/kf.png' }, role: 'first_frame' },
    ])
    expect(out[1].type).toBe('image_url')
    const inlined = (out[1].image_url as { url: string }).url
    expect(inlined.startsWith('data:image/png;base64,')).toBe(true)
    expect(Buffer.from(inlined.split(',')[1], 'base64').toString()).toBe('PNGDATA')
  })

  it('inlines a root-relative audio_url to a base64 data URL', async () => {
    const out = await inlineLocalRefsInContentParts([
      { type: 'audio_url', audio_url: { url: '/voices/a.mp3' }, role: 'reference_audio' },
    ])
    const inlined = (out[0].audio_url as { url: string }).url
    expect(inlined.startsWith('data:audio/mpeg;base64,')).toBe(true)
    expect(Buffer.from(inlined.split(',')[1], 'base64').toString()).toBe('MP3DATA')
  })

  it('leaves absolute http URLs and existing data: URLs untouched', async () => {
    const parts = [
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ]
    const out = await inlineLocalRefsInContentParts(parts)
    expect((out[0].image_url as { url: string }).url).toBe('https://cdn.example.com/a.png')
    expect((out[1].image_url as { url: string }).url).toBe('data:image/png;base64,iVBORw0KGgo=')
  })
})
