import { describe, it, expect } from 'vitest'
import {
  buildDownloadName,
  extFromMime,
  extFromUrl,
  KIND_DEFAULT_EXT,
  sanitizeFilename,
} from '@/lib/download'

describe('download helpers (pure)', () => {
  describe('sanitizeFilename', () => {
    it('replaces OS-illegal chars with underscore', () => {
      expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    })

    it('trims whitespace', () => {
      expect(sanitizeFilename('  hello  ')).toBe('hello')
    })

    it('falls back to "download" when the name reduces to empty', () => {
      expect(sanitizeFilename('   ')).toBe('download')
      expect(sanitizeFilename('')).toBe('download')
    })

    it('preserves dots and CJK', () => {
      expect(sanitizeFilename('片头.第一幕')).toBe('片头.第一幕')
    })
  })

  describe('extFromUrl', () => {
    it('reads the trailing extension from a simple URL', () => {
      expect(extFromUrl('https://cdn.example.com/clip.mp4')).toBe('mp4')
      expect(extFromUrl('/local/keyframe.png')).toBe('png')
      expect(extFromUrl('something.JPG')).toBe('jpg')
    })

    it('strips query + hash before reading', () => {
      expect(extFromUrl('https://cdn.example.com/clip.mp4?token=abc')).toBe('mp4')
      expect(extFromUrl('https://cdn.example.com/clip.webp#frag')).toBe('webp')
    })

    it('returns undefined when no extension is present', () => {
      expect(extFromUrl('https://cdn.example.com/blob?token=abc')).toBeUndefined()
      expect(extFromUrl('https://cdn.example.com/just-a-path')).toBeUndefined()
    })

    it('returns undefined for extensions too long/short to be plausible', () => {
      // 1-char or 6+-char tails are skipped by the regex.
      expect(extFromUrl('foo.a')).toBeUndefined()
      expect(extFromUrl('foo.toolong')).toBeUndefined()
    })
  })

  describe('extFromMime', () => {
    it('maps common image / video / audio MIMEs', () => {
      expect(extFromMime('image/png')).toBe('png')
      expect(extFromMime('image/jpeg')).toBe('jpg')
      expect(extFromMime('video/mp4')).toBe('mp4')
      expect(extFromMime('audio/mpeg')).toBe('mp3')
    })

    it('strips charset / parameters before lookup', () => {
      expect(extFromMime('image/png; charset=binary')).toBe('png')
      expect(extFromMime('VIDEO/MP4')).toBe('mp4')
    })

    it('returns undefined for unknown / missing MIMEs', () => {
      expect(extFromMime(null)).toBeUndefined()
      expect(extFromMime(undefined)).toBeUndefined()
      expect(extFromMime('application/octet-stream')).toBeUndefined()
    })
  })

  describe('buildDownloadName', () => {
    it('appends the extension when missing', () => {
      expect(buildDownloadName('Alice', 'png')).toBe('Alice.png')
    })

    it("doesn't double-extension when base already ends with target ext", () => {
      expect(buildDownloadName('Alice.png', 'png')).toBe('Alice.png')
      expect(buildDownloadName('clip.MP4', 'mp4')).toBe('clip.MP4')
    })

    it('strips a wrong trailing extension before appending the right one', () => {
      // The caller said "image" but the user typed ".gif" — we trust the
      // inferred ext (third arg) to win.
      expect(buildDownloadName('Alice.gif', 'png')).toBe('Alice.png')
    })

    it('sanitizes path separators before extension logic', () => {
      expect(buildDownloadName('a/b/c', 'png')).toBe('a_b_c.png')
    })
  })

  describe('KIND_DEFAULT_EXT (the fallback table)', () => {
    it('provides sensible defaults for each canvas kind', () => {
      expect(KIND_DEFAULT_EXT.image).toBe('png')
      expect(KIND_DEFAULT_EXT.video).toBe('mp4')
      expect(KIND_DEFAULT_EXT.audio).toBe('mp3')
    })
  })
})
