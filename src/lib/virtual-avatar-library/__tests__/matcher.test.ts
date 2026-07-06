import { describe, expect, it } from 'vitest'
import type { PersistedCastingCard } from '@/stores/project-db'
import {
  inferNationality,
  isRealPersonStyle,
  normalizeGender,
  parseAgeRange,
  pickAvatarForCard,
  resolveAvatarsForCharacters,
} from '../index'
import type { VirtualAvatarAsset } from '../types'

function card(patch: Partial<PersistedCastingCard>): PersistedCastingCard {
  return { name: 'Test', ...patch }
}

const femaleYoung: VirtualAvatarAsset = {
  id: 'a-female-young', name: '图片1', gender: 'female', ageMin: 18, ageMax: 28, nationality: 'chinese',
}
const femaleOld: VirtualAvatarAsset = {
  id: 'b-female-old', name: '图片2', gender: 'female', ageMin: 45, ageMax: 60,
}
const maleYoung: VirtualAvatarAsset = {
  id: 'c-male-young', name: '图片3', gender: 'male', ageMin: 20, ageMax: 30,
}
const neutral: VirtualAvatarAsset = {
  id: 'd-neutral', name: '图片4', gender: 'neutral', ageMin: 20, ageMax: 40,
}
const CATALOG = [femaleYoung, femaleOld, maleYoung, neutral]

describe('isRealPersonStyle', () => {
  it('is true for a live-action preset', () => {
    expect(isRealPersonStyle('liveaction_nolan_filmic')).toBe(true)
  })
  it('is false for a photoreal 3D preset (at-risk but not 真人)', () => {
    expect(isRealPersonStyle('3d_weta_performance_capture_epic')).toBe(false)
  })
  it('is false for unknown / freeform styles', () => {
    expect(isRealPersonStyle('my custom cinematic look')).toBe(false)
    expect(isRealPersonStyle(undefined)).toBe(false)
    expect(isRealPersonStyle(null)).toBe(false)
  })
})

describe('normalizeGender', () => {
  it('maps English and Chinese to buckets', () => {
    expect(normalizeGender('female')).toBe('female')
    expect(normalizeGender('女')).toBe('female')
    expect(normalizeGender('男性')).toBe('male')
    expect(normalizeGender('man')).toBe('male')
  })
  it('returns null when unknown', () => {
    expect(normalizeGender('nonbinary')).toBeNull()
    expect(normalizeGender(undefined)).toBeNull()
  })
})

describe('parseAgeRange', () => {
  it('parses explicit ranges', () => {
    expect(parseAgeRange('20-30')).toEqual({ min: 20, max: 30 })
    expect(parseAgeRange('30 to 20')).toEqual({ min: 20, max: 30 })
    expect(parseAgeRange('25–35')).toEqual({ min: 25, max: 35 })
  })
  it('parses decade buckets with qualifiers', () => {
    expect(parseAgeRange('20s')).toEqual({ min: 20, max: 29 })
    expect(parseAgeRange('early 30s')).toEqual({ min: 30, max: 33 })
    expect(parseAgeRange('late 40s')).toEqual({ min: 46, max: 49 })
    expect(parseAgeRange('二十多岁')).toEqual({ min: 20, max: 29 })
  })
  it('parses life-stage words', () => {
    expect(parseAgeRange('young adult')).toEqual({ min: 18, max: 30 })
    expect(parseAgeRange('中年')).toEqual({ min: 40, max: 55 })
    expect(parseAgeRange('儿童')).toEqual({ min: 4, max: 12 })
  })
  it('parses single ages', () => {
    expect(parseAgeRange('25岁')).toEqual({ min: 25, max: 25 })
    expect(parseAgeRange('age 42')).toEqual({ min: 42, max: 42 })
  })
  it('returns null when nothing parseable', () => {
    expect(parseAgeRange('')).toBeNull()
    expect(parseAgeRange('unknown')).toBeNull()
    expect(parseAgeRange(undefined)).toBeNull()
  })
})

describe('inferNationality', () => {
  it('infers from appearance prose', () => {
    expect(inferNationality(card({ appearance_for_image: 'a young Chinese woman' }))).toBe('chinese')
    expect(inferNationality(card({ appearance_prompt: '日本武士' }))).toBe('japanese')
  })
  it('returns null when nothing matches', () => {
    expect(inferNationality(card({ appearance_for_image: 'a person in a coat' }))).toBeNull()
  })
})

describe('pickAvatarForCard', () => {
  it('prefers the same gender', () => {
    const m = pickAvatarForCard(card({ gender_presentation: 'male', age_range: '25' }), CATALOG)
    expect(m?.avatar.id).toBe(maleYoung.id)
  })

  it('prefers the closest age within the same gender', () => {
    const m = pickAvatarForCard(card({ gender_presentation: 'female', age_range: '50' }), CATALOG)
    expect(m?.avatar.id).toBe(femaleOld.id)
  })

  it('excludes the opposite, known gender entirely', () => {
    const onlyMale = [maleYoung]
    const m = pickAvatarForCard(card({ gender_presentation: 'female', age_range: '25' }), onlyMale)
    expect(m).toBeNull()
  })

  it('falls back to a neutral avatar when gender is unknown', () => {
    const m = pickAvatarForCard(card({ gender_presentation: 'nonbinary', age_range: '30' }), [neutral, maleYoung])
    // male is excluded? no — gender unknown, so male is allowed but gets no
    // gender bonus; neutral gets +10. Neutral should win on the gender bonus.
    expect(m?.avatar.id).toBe(neutral.id)
  })

  it('rewards an inferred nationality match', () => {
    const plainFemaleYoung: VirtualAvatarAsset = { ...femaleYoung, id: 'z-plain', nationality: undefined }
    const m = pickAvatarForCard(
      card({ gender_presentation: 'female', age_range: '24', appearance_for_image: 'Chinese student' }),
      [plainFemaleYoung, femaleYoung],
    )
    expect(m?.avatar.id).toBe(femaleYoung.id) // the one with nationality: 'chinese'
  })

  it('returns null for an empty catalog', () => {
    expect(pickAvatarForCard(card({ gender_presentation: 'female' }), [])).toBeNull()
  })

  it('is deterministic — ties broken by avatar id', () => {
    const t1: VirtualAvatarAsset = { id: 'tie-b', name: 'b', gender: 'female', ageMin: 20, ageMax: 30 }
    const t2: VirtualAvatarAsset = { id: 'tie-a', name: 'a', gender: 'female', ageMin: 20, ageMax: 30 }
    const c = card({ gender_presentation: 'female', age_range: '25' })
    expect(pickAvatarForCard(c, [t1, t2])?.avatar.id).toBe('tie-a')
    expect(pickAvatarForCard(c, [t2, t1])?.avatar.id).toBe('tie-a')
  })
})

describe('resolveAvatarsForCharacters', () => {
  const cards: PersistedCastingCard[] = [
    { name: '莉安 (Lian)', gender_presentation: 'female', age_range: '24' },
    { name: '陈默 (Chen Mo)', gender_presentation: 'male', age_range: '28' },
  ]

  it('returns [] for a non-real-person style', () => {
    const out = resolveAvatarsForCharacters({
      characters: [{ slotLabel: '角色1', name: '莉安' }],
      castingCards: cards,
      stylePreset: 'anime_2d_makoto_shinkai', // not live_action
      catalog: CATALOG,
    })
    expect(out).toEqual([])
  })

  it('returns [] when the catalog is empty', () => {
    const out = resolveAvatarsForCharacters({
      characters: [{ slotLabel: '角色1', name: '莉安' }],
      castingCards: cards,
      stylePreset: 'liveaction_nolan_filmic',
      catalog: [],
    })
    expect(out).toEqual([])
  })

  it('matches slot names (canonicalized) to cards and assigns distinct avatars', () => {
    const out = resolveAvatarsForCharacters({
      characters: [
        { slotLabel: '角色1', name: '莉安, 灰色风衣' }, // raw slot description form
        { slotLabel: '角色2', name: '陈默' },
      ],
      castingCards: cards,
      stylePreset: 'liveaction_nolan_filmic',
      catalog: CATALOG,
    })
    expect(out.map((r) => r.slotLabel)).toEqual(['角色1', '角色2'])
    expect(out[0]?.avatar.gender).toBe('female')
    expect(out[1]?.avatar.gender).toBe('male')
    // distinct avatars
    expect(out[0]?.avatar.id).not.toBe(out[1]?.avatar.id)
  })

  it('skips slots whose name matches no casting card', () => {
    const out = resolveAvatarsForCharacters({
      characters: [{ slotLabel: '角色1', name: '路人甲' }],
      castingCards: cards,
      stylePreset: 'liveaction_nolan_filmic',
      catalog: CATALOG,
    })
    expect(out).toEqual([])
  })

  it('an explicit binding overrides the auto-match', () => {
    const out = resolveAvatarsForCharacters({
      characters: [{ slotLabel: '角色1', name: '莉安' }], // would auto-match femaleYoung
      castingCards: cards,
      stylePreset: 'liveaction_nolan_filmic',
      catalog: CATALOG,
      bindings: { '莉安': femaleOld.id }, // force the older avatar instead
    })
    expect(out[0]?.avatar.id).toBe(femaleOld.id)
  })

  it('an explicit binding applies even with no matching casting card', () => {
    const out = resolveAvatarsForCharacters({
      characters: [{ slotLabel: '角色1', name: '路人甲' }],
      castingCards: cards,
      stylePreset: 'liveaction_nolan_filmic',
      catalog: CATALOG,
      bindings: { '路人甲': maleYoung.id },
    })
    expect(out[0]?.avatar.id).toBe(maleYoung.id)
  })
})
