/**
 * Virtual Avatar Library (虚拟人像库) — public API.
 *
 * When a 真人 / live-action style is selected, characters are sourced from
 * Volcengine's approved virtual avatar library instead of generated photoreal
 * faces, so the pipeline stays photoreal but never trips Seedance's content
 * review (审查). This module owns:
 *   - `isRealPersonStyle()` — should real-person mode engage for a style?
 *   - `pickAvatarForCard()` — auto-match a casting card to the best avatar.
 *
 * Catalog loading lives in ./data; types in ./types.
 */

import type { PersistedCastingCard } from '@/stores/project-db'
import { getStylePreset, isKnownStylePreset } from '@/lib/style-library'
import { loadAvatarCatalog } from './data'
import type { AvatarGender, AvatarMatch, VirtualAvatarAsset } from './types'

export type { AvatarGender, AvatarMatch, VirtualAvatarAsset } from './types'
export { loadAvatarCatalog, setAvatarCatalogOverride, BUILTIN_VIRTUAL_AVATARS } from './data'

/**
 * True iff the selected style preset is live-action (真人). Keys off the
 * preset's library category, so unknown/freeform style strings return false
 * (real-person mode only engages for a recognised live-action preset). Note
 * this is narrower than `isPhotorealRiskPreset`: photoreal *3D* presets
 * (Pixar/Weta) are at-risk but are not 真人, and keep the CG-stylization
 * rider rather than swapping to avatars.
 */
export function isRealPersonStyle(stylePreset: string | undefined | null): boolean {
  if (!isKnownStylePreset(stylePreset)) return false
  return getStylePreset(stylePreset).category === 'live_action'
}

/** Map a casting card's gender presentation onto an avatar gender bucket. */
export function normalizeGender(raw: string | undefined | null): AvatarGender | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (/(^|[^a-z])(female|woman|women|girl|f)([^a-z]|$)|女/.test(s)) return 'female'
  if (/(^|[^a-z])(male|man|men|boy|m)([^a-z]|$)|男/.test(s)) return 'male'
  return null
}

/**
 * Best-effort parse of a casting card's free-text age into [min, max].
 * Handles digit ranges ("20-30"), single ages ("25"), decade buckets
 * ("20s"/"二十多岁"/"30岁"), early/mid/late qualifiers, and a few Chinese /
 * English life-stage words. Returns null when nothing parseable is found.
 */
export function parseAgeRange(raw: string | undefined | null): { min: number; max: number } | null {
  if (!raw) return null
  const s = raw.toLowerCase().replace(/[—–~]/g, '-')

  // Explicit numeric range: "20-30", "20 to 30"
  const range = s.match(/(\d{1,3})\s*(?:-|to)\s*(\d{1,3})/)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    return { min: Math.min(a, b), max: Math.max(a, b) }
  }

  // Decade bucket: "20s", "二十多", "30岁" → that decade, optionally narrowed
  // by early/mid/late.
  // Two-char decades first: 十 is a substring of 二十/三十/… so it must be
  // checked last, or "二十多" would match the 十 (10) branch.
  const cnDecade: Record<string, number> = { 二十: 20, 三十: 30, 四十: 40, 五十: 50, 六十: 60, 七十: 70, 十: 10 }
  let decade: number | null = null
  const enDecade = s.match(/(\d{1,2})0\s*s/)
  if (enDecade) decade = Number(enDecade[1]) * 10
  if (decade == null) {
    for (const [word, val] of Object.entries(cnDecade)) {
      if (s.includes(`${word}多`) || s.includes(`${word}几`)) {
        decade = val
        break
      }
    }
  }
  if (decade != null) {
    if (/early|初|出头/.test(s)) return { min: decade, max: decade + 3 }
    if (/late|末|快/.test(s)) return { min: decade + 6, max: decade + 9 }
    if (/mid|中/.test(s)) return { min: decade + 3, max: decade + 6 }
    return { min: decade, max: decade + 9 }
  }

  // Life-stage words.
  const stages: Array<[RegExp, { min: number; max: number }]> = [
    [/child|kid|儿童|小孩/, { min: 4, max: 12 }],
    [/teen|adolescent|少年|青少年/, { min: 13, max: 19 }],
    [/young|youth|青年|年轻/, { min: 18, max: 30 }],
    [/middle[\s-]?aged|中年/, { min: 40, max: 55 }],
    [/elderly|old|senior|老年|年长/, { min: 60, max: 80 }],
  ]
  for (const [re, span] of stages) {
    if (re.test(s)) return span
  }

  // Single explicit age: "25", "25岁", "age 25"
  const single = s.match(/(\d{1,3})\s*(?:岁|years?|y\/?o)?/)
  if (single) {
    const n = Number(single[1])
    if (n > 0 && n < 130) return { min: n, max: n }
  }
  return null
}

const NATIONALITY_PATTERNS: Array<[RegExp, string]> = [
  [/chinese|中国|华人|汉/, 'chinese'],
  [/japanese|日本|和风/, 'japanese'],
  [/korean|韩国|韩/, 'korean'],
  [/east[\s-]?asian|东亚|亚洲|asian/, 'east_asian'],
  [/caucasian|white|western|欧美|白人/, 'caucasian'],
  [/african|black|黑人|非洲/, 'african'],
  [/latino|latina|hispanic|拉丁/, 'latino'],
  [/indian|south[\s-]?asian|印度|南亚/, 'south_asian'],
]

/** Infer a nationality token from free text (e.g. appearance prose, avatar tags). */
export function inferNationalityFromText(text: string | undefined | null): string | null {
  if (!text) return null
  const s = text.toLowerCase()
  for (const [re, token] of NATIONALITY_PATTERNS) {
    if (re.test(s)) return token
  }
  return null
}

/**
 * Casting cards carry no explicit nationality field, so infer a token from
 * the appearance prose. Returns null when nothing matches.
 */
export function inferNationality(card: PersistedCastingCard): string | null {
  return inferNationalityFromText(
    [card.appearance_for_image, card.appearance_prompt, card.casting_notes, card.name].filter(Boolean).join(' '),
  )
}

const mid = (lo: number, hi: number): number => (lo + hi) / 2

/**
 * Score one avatar against a casting card. Returns null when the avatar is a
 * hard mismatch (opposite, known gender) so it can be excluded entirely
 * rather than picked as a least-bad option.
 */
function scoreAvatar(card: PersistedCastingCard, avatar: VirtualAvatarAsset): number | null {
  let score = 0

  const cardGender = normalizeGender(card.gender_presentation)
  if (cardGender && avatar.gender !== 'neutral') {
    if (avatar.gender === cardGender) score += 100
    else return null // opposite, known gender → exclude
  } else if (avatar.gender === 'neutral') {
    score += 10
  }

  const cardAge = parseAgeRange(card.age_range)
  if (cardAge) {
    const overlaps = cardAge.min <= avatar.ageMax && avatar.ageMin <= cardAge.max
    const distance = Math.abs(mid(cardAge.min, cardAge.max) - mid(avatar.ageMin, avatar.ageMax))
    if (overlaps) score += 50 + Math.max(0, 30 - distance)
    else score += Math.max(0, 20 - distance)
  }

  const cardNat = inferNationality(card)
  if (cardNat && avatar.nationality && cardNat === avatar.nationality) score += 30

  if (avatar.tags?.length) {
    const text = [card.appearance_for_image, card.appearance_prompt, card.personality_layers]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    const hits = avatar.tags.filter((t) => text.includes(t.toLowerCase())).length
    score += hits * 5
  }

  return score
}

/**
 * Auto-match a casting card to the closest virtual avatar. Deterministic:
 * highest score wins, ties broken by avatar id (lexicographic). Returns null
 * when the catalog is empty or every avatar is a hard gender mismatch — the
 * caller should then fall back to the existing privacy-block chain.
 */
export function pickAvatarForCard(
  card: PersistedCastingCard,
  catalog: VirtualAvatarAsset[] = loadAvatarCatalog(),
): AvatarMatch | null {
  let best: AvatarMatch | null = null
  for (const avatar of catalog) {
    const score = scoreAvatar(card, avatar)
    if (score == null) continue
    if (
      best == null ||
      score > best.score ||
      (score === best.score && avatar.id < best.avatar.id)
    ) {
      best = { avatar, score }
    }
  }
  return best
}

/**
 * Reduce a storyboard slot name to a comparable key: take the first
 * comma/period-delimited token ("莉安, 灰色风衣" → "莉安"), strip a bilingual
 * parenthetical ("莉安 (Lian)" → "莉安"), trim and lowercase. Combines
 * actor-agent.nameFromSlotDescription + canonicalName — inlined to keep this
 * lib module free of an agent-layer import.
 */
export function canonicalCharacterName(name: string): string {
  const first = name.split(/[,，。\n]/)[0] ?? name
  return first.replace(/\s*[（(][^)）]*[)）]/g, '').trim().toLowerCase()
}

function matchCard(name: string, cards: PersistedCastingCard[]): PersistedCastingCard | null {
  const key = canonicalCharacterName(name)
  if (!key) return null
  return cards.find((c) => canonicalCharacterName(c.name) === key) ?? null
}

/** One character slot resolved to a concrete avatar. */
export interface ResolvedAvatar {
  slotLabel: string
  characterName: string
  avatar: VirtualAvatarAsset
}

/**
 * For a 真人 / live-action style, resolve each character slot to a distinct
 * virtual avatar (auto-matched by its casting card). Returns [] when the style
 * isn't real-person, the catalog is empty, or no slot matches a card — the
 * caller then keeps the normal (photoreal) path / privacy fallback chain.
 *
 * Avatars are de-duplicated across slots so two characters never collapse onto
 * the same persona.
 */
export function resolveAvatarsForCharacters(opts: {
  characters: Array<{ slotLabel: string; name?: string }>
  castingCards: PersistedCastingCard[]
  stylePreset: string | undefined | null
  catalog?: VirtualAvatarAsset[]
  /**
   * Explicit picks from the casting UI: canonical character name → avatar id.
   * A binding wins over auto-match (and applies even without a casting card).
   * Use `canonicalCharacterName()` to build the keys.
   */
  bindings?: Record<string, string>
}): ResolvedAvatar[] {
  if (!isRealPersonStyle(opts.stylePreset)) return []
  const catalog = opts.catalog ?? loadAvatarCatalog()
  if (catalog.length === 0) return []
  const byId = new Map(catalog.map((a) => [a.id, a]))

  const used = new Set<string>()
  const out: ResolvedAvatar[] = []
  for (const ch of opts.characters) {
    const name = ch.name?.trim()
    if (!name) continue

    // Explicit binding wins over auto-match.
    const boundId = opts.bindings?.[canonicalCharacterName(name)]
    if (boundId && byId.has(boundId)) {
      used.add(boundId)
      out.push({ slotLabel: ch.slotLabel, characterName: name, avatar: byId.get(boundId)! })
      continue
    }

    const card = matchCard(name, opts.castingCards)
    if (!card) continue
    const remaining = catalog.filter((a) => !used.has(a.id))
    const match = pickAvatarForCard(card, remaining)
    if (!match) continue
    used.add(match.avatar.id)
    out.push({ slotLabel: ch.slotLabel, characterName: name, avatar: match.avatar })
  }
  return out
}
