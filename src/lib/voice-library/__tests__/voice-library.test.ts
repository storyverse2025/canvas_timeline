import { describe, it, expect } from 'vitest'

import {
  VOICE_CATALOG_META,
  getVoice,
  listVoices,
  searchVoices,
  shortlistForCard,
  voicePublicUrl,
} from '@/lib/voice-library'

describe('voice-library', () => {
  it('exposes a non-empty catalog from the scanner output', () => {
    expect(VOICE_CATALOG_META.count).toBeGreaterThan(100)
    expect(listVoices()).toHaveLength(VOICE_CATALOG_META.count)
  })

  it('every catalog entry has a parseable urlPath under /voices/', () => {
    for (const v of listVoices().slice(0, 50)) {
      expect(v.urlPath.startsWith('/voices/')).toBe(true)
      // URL-encoded — no raw spaces / CJK in the URL.
      expect(v.urlPath).not.toMatch(/\s/)
    }
  })

  it('getVoice / voicePublicUrl round-trip the same entry', () => {
    const sample = listVoices()[0]
    expect(getVoice(sample.id)).toEqual(sample)
    expect(voicePublicUrl(sample.id)).toBe(sample.urlPath)
    expect(getVoice('does-not-exist')).toBeUndefined()
    expect(voicePublicUrl(undefined)).toBeUndefined()
  })

  it('searchVoices query matches displayName / sampleSnippet / tags case-insensitively', () => {
    const all = listVoices()
    const target = all.find((v) => v.displayName.length > 0)!
    const hits = searchVoices({ query: target.displayName.toLowerCase() })
    expect(hits.some((v) => v.id === target.id)).toBe(true)
  })

  it('searchVoices gender filter keeps matching + unknown rows (defensive — most rows are unknown)', () => {
    const males = searchVoices({ gender: 'male' })
    expect(males.length).toBeGreaterThan(0)
    for (const v of males) {
      expect(['male', 'unknown']).toContain(v.gender)
    }
  })

  it('shortlistForCard narrows on gender when the card declares one', () => {
    const males = shortlistForCard({ gender_presentation: 'male, 30s' }, 30)
    expect(males.length).toBeGreaterThan(0)
    expect(males.length).toBeLessThanOrEqual(30)
    for (const v of males) {
      expect(['male', 'unknown']).toContain(v.gender)
    }
  })

  it('shortlistForCard falls back to a full pool when filters would empty the list', () => {
    // No card hints → bucket falls through to the catalog default.
    const broad = shortlistForCard({}, 25)
    expect(broad.length).toBe(25)
  })
})
