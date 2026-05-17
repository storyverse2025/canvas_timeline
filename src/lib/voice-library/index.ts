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
  return catalog.voices.filter((v) => {
    if (filter.gender && filter.gender !== 'unknown' && v.gender !== filter.gender && v.gender !== 'unknown') return false
    if (filter.age && filter.age !== 'unknown' && v.age !== filter.age && v.age !== 'unknown') return false
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

  // Try strict filter first, then progressively relax.
  const tiers: VoiceFilter[] = [
    { gender, age },
    { gender },
    {},
  ]
  for (const tier of tiers) {
    const matches = searchVoices(tier)
    if (matches.length >= limit) return matches.slice(0, limit)
    if (matches.length > 0 && tier === tiers[tiers.length - 1]) return matches
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
  if (/(child|kid|infant|童|孩|baby|toddler)/.test(s)) return 'child'
  if (/(teen|youth|青年|少年|少女)/.test(s)) return 'youth'
  if (/(middle|中年|40|50)/.test(s)) return 'middle'
  if (/(elder|老|senior|60|70|80|90)/.test(s)) return 'elderly'
  if (/(adult|成年|20|30)/.test(s)) return 'adult'
  return 'unknown'
}

export type { VoiceAge, VoiceCatalog, VoiceEntry, VoiceGender } from './types'
