/**
 * Voice library — runtime access to the catalog scanned out of
 * `public/voices/`. The catalog is built by
 * `scripts/build-voice-catalog.ts`; regenerate after re-zipping new
 * voices into `public/voices/`.
 *
 * Consumers:
 *   - actor-agent.castVoices: picks a voice per casting card via LLM,
 *     using `shortlistForCard()` to keep the LLM input small.
 *   - VoiceCastPanel UI: lists / filters / previews voices for manual
 *     swap.
 *   - cinematographer prompt augmentation: looks up `voicePublicUrl(id)`
 *     when injecting `音色文件:` lines into the Seedance prompt.
 */

import catalogJson from './catalog.json'
import type { VoiceAge, VoiceCatalog, VoiceEntry, VoiceGender } from './types'

const catalog = catalogJson as VoiceCatalog
const BY_ID: Record<string, VoiceEntry> = Object.fromEntries(catalog.voices.map((v) => [v.id, v]))

export const VOICE_CATALOG_META = {
  generatedAt: catalog.generatedAt,
  count: catalog.count,
  publicRoot: catalog.publicRoot,
}

export function listVoices(): VoiceEntry[] {
  return catalog.voices
}

export function getVoice(id: string | undefined | null): VoiceEntry | undefined {
  if (!id) return undefined
  return BY_ID[id]
}

export function voicePublicUrl(id: string | undefined | null): string | undefined {
  return getVoice(id)?.urlPath
}

/**
 * Vite's static handler doesn't decode `%2B` back to `+` when matching
 * disk paths, so any URL where `+` was URL-encoded falls through to the
 * SPA index.html (audio plays silently). The build-voice-catalog scanner
 * now keeps `+` literal, but legacy items already persisted in IDB still
 * have `%2B` in their `content`. Normalize on read to keep them playable
 * without forcing a re-spawn.
 */
export function normalizeVoiceUrl(urlPath: string | undefined | null): string {
  if (!urlPath) return ''
  return urlPath.replace(/%2B/g, '+')
}

/**
 * Reverse lookup — find a voice catalog entry by its public URL. Used by
 * the canvas inspector / debug panels to enrich an audio item with its
 * source voice metadata when only the URL was persisted on the item.
 * Tolerant of legacy `%2B`-encoded urls (normalized before lookup).
 */
const BY_URL: Record<string, VoiceEntry> = Object.fromEntries(catalog.voices.map((v) => [v.urlPath, v]))
export function findVoiceByUrl(urlPath: string | undefined | null): VoiceEntry | undefined {
  if (!urlPath) return undefined
  return BY_URL[urlPath] ?? BY_URL[normalizeVoiceUrl(urlPath)]
}

export interface VoiceFilter {
  gender?: VoiceGender
  age?: VoiceAge
  /** Case-insensitive substring match against displayName + sampleSnippet + tags. */
  query?: string
  /** Restrict to this top-level collection path (e.g. '800+音色/智声整理音色/老年'). */
  collection?: string
}

export function searchVoices(filter: VoiceFilter): VoiceEntry[] {
  const q = filter.query?.toLowerCase().trim()
  // STRICT filter: when the caller passes a concrete gender/age, voices
  // tagged as `unknown` are EXCLUDED — they used to slip through via an
  // unknown-escape-hatch, polluting the LLM shortlist with off-archetype
  // candidates (e.g. 傲娇大佬, female+unknown-age, surfacing for a
  // middle-aged mentor). Relaxation to `unknown` candidates is the
  // caller's job — shortlistForCard relaxes through tiers explicitly.
  return catalog.voices.filter((v) => {
    if (filter.gender && filter.gender !== 'unknown' && v.gender !== filter.gender) return false
    if (filter.age && filter.age !== 'unknown' && v.age !== filter.age) return false
    if (filter.collection && !v.collection.startsWith(filter.collection)) return false
    if (q) {
      const hay = (v.displayName + ' ' + v.sampleSnippet + ' ' + v.tags.join(' ')).toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/**
 * Pick up to `limit` voice candidates that plausibly fit a casting card,
 * for the LLM picker. We pre-filter on gender (when known on the card)
 * to keep the LLM input small; if the filter would empty the list we
 * gracefully fall back to a broader pool.
 */
export function shortlistForCard(
  card: {
    gender_presentation?: string
    age_range?: string
    voice_print?: string
  },
  limit = 40,
): VoiceEntry[] {
  const gender = guessGenderFromCard(card)
  const age = guessAgeFromCard(card)

  // Prefer fewer-but-well-matched candidates. Previously we skipped to
  // broader tiers whenever the strict tier had < limit (40), which
  // erased the careful gender/age tagging entirely — a 40-year-old
  // female mentor got every female voice in the pool, including youth
  // archetypes like 傲娇大佬, and the LLM picked one. Now: the FIRST
  // tier with at least MIN_TIER_RESULTS confidently-matched candidates
  // is what we return, even if that's only a handful. Only relax
  // further when the strict tier is too sparse to give the LLM choice.
  const MIN_TIER_RESULTS = 4
  const tiers: VoiceFilter[] = [
    { gender, age },     // strict: same gender + same age bucket (no unknowns)
    { gender },          // relax age (allows unknown-age voices back in)
    {},                  // last resort: anything
  ]
  for (const tier of tiers) {
    const matches = searchVoices(tier)
    if (matches.length >= MIN_TIER_RESULTS) return matches.slice(0, limit)
  }
  return catalog.voices.slice(0, limit)
}

function guessGenderFromCard(card: { gender_presentation?: string }): VoiceGender {
  const s = (card.gender_presentation ?? '').toLowerCase()
  if (!s) return 'unknown'
  if (/(male|男|父|爷|大叔|哥|弟|man|boy|gentleman)/i.test(s)) return 'male'
  if (/(female|女|母|奶|大妈|姐|妹|woman|girl|lady)/i.test(s)) return 'female'
  return 'unknown'
}

function guessAgeFromCard(card: { age_range?: string }): VoiceAge {
  const s = (card.age_range ?? '').toLowerCase()
  if (!s) return 'unknown'
  // 4-bucket vocabulary (幼儿/少年/中年/老年) — `adult` is folded into
  // `middle` because the catalog scanner emits only these four. Keeps
  // prefilter + LLM prompt vocabulary aligned.
  if (/(幼儿|child|kid|infant|童|孩|baby|toddler)/.test(s)) return 'child'
  if (/(少年|少女|teen|youth|青年|学生|高中|初中|大学)/.test(s)) return 'youth'
  if (/(老年|elder|老|senior|60|70|80|90)/.test(s)) return 'elderly'
  if (/(中年|adult|middle|成年|20|30|40|50)/.test(s)) return 'middle'
  return 'unknown'
}

export type { VoiceAge, VoiceCatalog, VoiceEntry, VoiceGender } from './types'
