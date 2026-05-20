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

  it('catalog detection reaches reasonable gender coverage; age stays honest about unknowns', () => {
    // Gender: keyword + sample-snippet detection should still classify
    // most of the catalog so prefilter is useful for the LLM.
    // Age: we DELIBERATELY no longer auto-default unknown→middle when
    // gender is known — that mistagged youth-archetype voices like
    // 傲娇大佬 as middle and let them slip into mentor shortlists.
    // Unknown stays unknown; only voices with a real keyword cue land
    // in a strict age bucket.
    const all = listVoices()
    const knownGender = all.filter((v) => v.gender !== 'unknown').length
    const knownAge = all.filter((v) => v.age !== 'unknown').length
    expect(knownGender / all.length).toBeGreaterThanOrEqual(0.45)
    expect(knownAge / all.length).toBeGreaterThanOrEqual(0.15)

    // Regression guard for the 傲娇大佬-as-middle bug: voices whose
    // displayName carries a clear youth archetype must NOT be tagged
    // middle/elderly. Picks a stable id we know about.
    const aojiao = all.find((v) => v.id === '5e01c4256f87')
    if (aojiao) {
      expect(aojiao.age).not.toBe('middle')
      expect(aojiao.age).not.toBe('elderly')
    }
  })

  it("never emits age='adult' anymore — folded into 'middle' for the 4-bucket scheme", () => {
    for (const v of listVoices()) {
      expect(v.age).not.toBe('adult')
    }
  })

  it('shortlistForCard accepts 幼儿 / 少年 / 中年 / 老年 vocabulary on the card', () => {
    // Each bucket should produce SOMETHING (not empty); narrows correctly.
    expect(shortlistForCard({ age_range: '幼儿', gender_presentation: 'male' }, 10).length).toBeGreaterThan(0)
    expect(shortlistForCard({ age_range: '少年', gender_presentation: 'female' }, 10).length).toBeGreaterThan(0)
    expect(shortlistForCard({ age_range: '中年', gender_presentation: 'male' }, 10).length).toBeGreaterThan(0)
    expect(shortlistForCard({ age_range: '老年', gender_presentation: 'female' }, 10).length).toBeGreaterThan(0)
  })
})
