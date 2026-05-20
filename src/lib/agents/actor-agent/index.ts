/**
 * actor-agent — plays every character in a storyboard row and rewrites the
 * 5 performance fields (character_actions / character_motivation /
 * character_psychology / dialogue / performance_guidance) so they're
 * playable + voice-printed instead of generic.
 *
 * Two verbs:
 *   enrichRow(req)   → EnrichedPerformanceFields (one row at a time)
 *   enrichTable(req) → Record<rowId, EnrichedPerformanceFields> (batch)
 *
 * No interview turns — inputs come fully specified from the storyboard
 * table + projectDB.script (castingCards + creativeBrief).
 */

import { z } from 'zod'

import { fillTemplate, parseFrontmatter } from '@/lib/agents/_shared/mustache'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import type { AgentGenerator } from '@/lib/agents/_shared/runtime/types'

import skillSource from './SKILL.md?raw'
import enrichRowSource from './prompts/enrich-row.md?raw'
import castVoicesSource from './prompts/cast-voices.md?raw'
import attachVoiceRefsSource from './prompts/attach-voice-refs.md?raw'
import designCharactersSource from './prompts/design-characters.md?raw'

import {
  CharacterDesignsSchema,
  EnrichedPerformanceFieldsSchema,
  VoiceBindingsSchema,
  type ActorCharacterCard,
  type ActorRow,
  type AppearancePillars,
  type AttachVoiceRefsRequest,
  type AttachVoiceRefsResult,
  type CastVoicesRequest,
  type CharacterDesign,
  type CharacterDesigns,
  type DesignCharactersRequest,
  type EnrichRowRequest,
  type EnrichTableRequest,
  type EnrichTableResult,
  type EnrichedPerformanceFields,
  type ExtractedCharacterInput,
  type VoiceBindings,
  type VoiceCandidateSummary,
} from './schema'

const { body: SYSTEM } = parseFrontmatter(skillSource)
const TPL = {
  enrichRow: parseFrontmatter(enrichRowSource).body,
  castVoices: parseFrontmatter(castVoicesSource).body,
  attachVoiceRefs: parseFrontmatter(attachVoiceRefsSource).body,
  designCharacters: parseFrontmatter(designCharactersSource).body,
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Strip the bilingual parenthetical from a name so lookups can match.
 * actor-agent stores castingCards keyed `"莉安 (Lian)"` but the storyboard
 * table fills character1.description with the short form `"莉安, 灰色风衣"`.
 * Without canonicalization the cross-lookup misses every time. Also
 * lowercases so the match is case-insensitive.
 */
export function canonicalName(name: string): string {
  return name.replace(/\s*[\(（][^\)）]*[\)）]/g, '').trim().toLowerCase()
}

/**
 * Extract a character name from a slot description. The storyboard fills
 * character1.description with strings like "林清, 短发，灰色风衣" — we just
 * take the first comma-separated token.
 */
function nameFromSlotDescription(desc?: string): string | undefined {
  if (!desc) return undefined
  const first = desc.split(/[,，。\n]/)[0]?.trim()
  return first || undefined
}

/**
 * Pick the casting cards that match the row's character slots. Falls back
 * to the entire roster when the row lists characters the dossier doesn't
 * know about (rare; happens when the storyboard is hand-edited).
 */
function cardsForRow(
  row: ActorRow,
  allCards: ActorCharacterCard[],
): ActorCharacterCard[] {
  const wanted = new Set(
    [nameFromSlotDescription(row.character1?.description), nameFromSlotDescription(row.character2?.description)]
      .filter((s): s is string => Boolean(s))
      .map(canonicalName),
  )
  if (wanted.size === 0) return []
  const matched = allCards.filter((c) => wanted.has(canonicalName(c.name)))
  // If nothing matched (name mismatch), send the full roster so the LLM
  // can still try to find the right voice prints.
  return matched.length > 0 ? matched : allCards
}

function extractFirstJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidates = [fence?.[1], text].filter((c): c is string => typeof c === 'string')
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start < 0 || end < 0 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try next
    }
  }
  throw new Error('actor-agent: model output did not contain a parseable JSON object')
}

function parseEnrichedStrict(json: unknown): EnrichedPerformanceFields {
  const parsed = EnrichedPerformanceFieldsSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `actor-agent: enriched JSON failed validation: ${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
}

interface BuildPromptArgs {
  row: ActorRow
  cards: ActorCharacterCard[]
  scene?: EnrichRowRequest['scene']
  creativeBrief?: EnrichRowRequest['creativeBrief']
  visualStyle?: string
}

function buildEnrichRowPrompt(args: BuildPromptArgs): string {
  return fillTemplate(TPL.enrichRow, {
    rowJson: JSON.stringify(args.row, null, 2),
    castingCardsJson: JSON.stringify(args.cards, null, 2),
    sceneJson: args.scene ? JSON.stringify(args.scene, null, 2) : '{}',
    creativeBriefJson: JSON.stringify(args.creativeBrief ?? {}, null, 2),
    visualStyle: args.visualStyle ?? '(未指定 / unspecified)',
    projectType: args.creativeBrief?.projectType ?? '未指定',
    tone: args.creativeBrief?.tone ?? '未指定',
    genre: args.creativeBrief?.genre ?? '未指定',
  })
}

// ─── Verb: enrichRow ─────────────────────────────────────────────

export async function* enrichRow(
  req: EnrichRowRequest,
  ctx: ProjectContext,
): AgentGenerator<EnrichedPerformanceFields> {
  const shot = req.row.shot_number ?? '?'
  const cards = cardsForRow(req.row, req.castingCards)

  // Zero-character row: skip the LLM call, return existing values
  // (per SKILL contract — only performance_guidance gets touched).
  if (cards.length === 0) {
    yield {
      type: 'progress',
      message: `actor: shot ${shot} has no character slots — passing through existing values`,
    }
    yield {
      type: 'result',
      payload: {
        character_actions: req.row.character_actions ?? '',
        character_motivation: req.row.character_motivation ?? '',
        character_psychology: req.row.character_psychology ?? '',
        dialogue: req.row.dialogue ?? '',
        performance_guidance:
          req.row.performance_guidance ??
          '镜头主体的身体语言：保持自然呼吸，避免打镜头摆拍。',
      },
    }
    return
  }

  yield {
    type: 'progress',
    message: `actor: performing shot ${shot} (${cards.length} character${cards.length === 1 ? '' : 's'})`,
  }

  const prompt = buildEnrichRowPrompt({
    row: req.row,
    cards,
    scene: req.scene,
    creativeBrief: req.creativeBrief,
    visualStyle: req.visualStyle,
  })

  const llmResponse = await ctx.llm.complete(
    [{ role: 'user', content: prompt }],
    { system: SYSTEM, signal: ctx.abort },
  )
  const json = extractFirstJsonObject(llmResponse)
  const enriched = parseEnrichedStrict(json)
  yield { type: 'result', payload: enriched }
}

// ─── Verb: enrichTable ───────────────────────────────────────────

export async function* enrichTable(
  req: EnrichTableRequest,
  ctx: ProjectContext,
): AgentGenerator<EnrichTableResult> {
  const out: EnrichTableResult = {}
  for (const row of req.rows) {
    // Delegate to enrichRow for each — uniform error surface + per-row
    // chat-bridge progress lines. Errors on one row don't kill the batch.
    try {
      const sub = enrichRow(
        {
          row,
          castingCards: req.castingCards,
          scene: req.scene,
          creativeBrief: req.creativeBrief,
          visualStyle: req.visualStyle,
        },
        ctx,
      )
      // Drive the sub-generator manually so each child progress/result
      // turn surfaces through THIS generator (no nested chat bridges).
      let next = await sub.next()
      while (!next.done) {
        const turn = next.value
        if (turn.type === 'result') {
          out[row.id] = turn.payload
          break
        }
        yield turn
        next = await sub.next()
      }
    } catch (e) {
      ctx.log(`actor: shot ${row.shot_number ?? row.id} enrichment failed: ${(e as Error).message}`)
    }
  }
  yield { type: 'result', payload: out }
}

// ─── Verb: castVoices ────────────────────────────────────────────

interface BuildCastVoicesPromptArgs {
  cards: ActorCharacterCard[]
  candidates: VoiceCandidateSummary[]
  creativeBrief?: CastVoicesRequest['creativeBrief']
}

function buildCastVoicesPrompt(args: BuildCastVoicesPromptArgs): string {
  return fillTemplate(TPL.castVoices, {
    castingCardsJson: JSON.stringify(args.cards, null, 2),
    voiceShortlistJson: JSON.stringify(args.candidates, null, 2),
    creativeBriefJson: JSON.stringify(args.creativeBrief ?? {}, null, 2),
  })
}

/**
 * Generator-style castVoices that lets the caller supply the candidate
 * pool. Decoupled from voice-library so this agent module stays pure
 * (no Vite asset imports); the director-assistant pulls shortlists from
 * the library and feeds them in here.
 *
 * Input: castingCards + a shortlist of voice candidates per character.
 * Output: { characterName: voiceId } map. Bindings are schema-validated
 * to ensure ids actually exist in the supplied candidate pool.
 */
export interface CastVoicesWithCandidatesRequest {
  castingCards: ActorCharacterCard[]
  creativeBrief?: {
    projectType?: string
    tone?: string
    genre?: string
  }
  /** Per-character shortlist of voice candidates, pre-filtered by caller. */
  candidatesPerCard: Record<string, VoiceCandidateSummary[]>
}

export async function* castVoices(
  req: CastVoicesWithCandidatesRequest,
  ctx: ProjectContext,
): AgentGenerator<VoiceBindings> {
  if (req.castingCards.length === 0) {
    yield { type: 'result', payload: {} }
    return
  }

  yield {
    type: 'progress',
    message: `actor: casting voices for ${req.castingCards.length} character${req.castingCards.length === 1 ? '' : 's'}`,
  }

  // Build a union pool — the LLM sees every candidate in its shortlist.
  // Each candidate gets the names of the cards that nominated it so the
  // model can keep gender/age sanity even after the union.
  const seen = new Set<string>()
  const unionPool: VoiceCandidateSummary[] = []
  for (const cands of Object.values(req.candidatesPerCard)) {
    for (const c of cands) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      unionPool.push(c)
    }
  }
  if (unionPool.length === 0) {
    throw new Error('actor-agent: castVoices got empty candidate pool — voice library empty?')
  }

  const prompt = buildCastVoicesPrompt({
    cards: req.castingCards,
    candidates: unionPool,
    creativeBrief: req.creativeBrief,
  })

  const llmResponse = await ctx.llm.complete(
    [{ role: 'user', content: prompt }],
    { system: SYSTEM, signal: ctx.abort },
  )

  const json = extractFirstJsonObject(llmResponse)
  const parsed = VoiceBindingsSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`actor-agent: castVoices JSON failed validation: ${z.prettifyError(parsed.error)}`)
  }

  // Defensive: drop any binding whose voiceId isn't in the pool, so we
  // never persist a phantom id the catalog doesn't know about.
  const validIds = new Set(unionPool.map((v) => v.id))
  const cleaned: VoiceBindings = {}
  const skipped: string[] = []
  for (const [name, voiceId] of Object.entries(parsed.data)) {
    if (validIds.has(voiceId)) {
      cleaned[name] = voiceId
    } else {
      skipped.push(`${name}→${voiceId}`)
    }
  }
  if (skipped.length > 0) {
    ctx.log(`actor: castVoices dropped ${skipped.length} hallucinated voice binding(s): ${skipped.join(', ')}`)
  }

  yield { type: 'result', payload: cleaned }
}

// ─── Verb: attachVoiceRefs (pure post-processor for cinematographer) ─

/**
 * Cinematographer-prompt post-processor. Deterministically appends an
 * audio-reference block to the video prompt so Seedance sees per-character
 * dialogue + voice file urls. No LLM call — purely templated.
 *
 * Idempotent: rerunning with the same inputs produces the same output;
 * caller is responsible for not double-appending across re-shoots.
 */
export async function* attachVoiceRefs(
  req: AttachVoiceRefsRequest,
  ctx: ProjectContext,
): AgentGenerator<AttachVoiceRefsResult> {
  void ctx
  const shot = req.row.shot_number ?? '?'
  const cards = cardsForRow(req.row, req.castingCards)
  // eslint-disable-next-line no-console
  console.log('[voice-debug][attachVoiceRefs] entry', {
    shot,
    rowCharacters: [req.row.character1?.description, req.row.character2?.description].filter(Boolean),
    castingCardsAll: req.castingCards.map((c) => c.name),
    cardsForRow: cards.map((c) => c.name),
    voiceBindingKeys: Object.keys(req.voiceBindings),
    dialoguePresent: Boolean(req.row.dialogue?.trim()),
  })
  if (cards.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[voice-debug][attachVoiceRefs] EXIT: no cards matched row characters → no voice block')
    yield { type: 'result', payload: { videoPrompt: req.videoPrompt, voiceAudioUrls: [], attached: [] } }
    return
  }

  // Parse the row's dialogue into per-character lines. Format produced by
  // enrichRow is `角色名: 台词\n角色名: 台词`. For single-character rows
  // dialogue has no prefix — we attribute it to the lone character.
  const lines = parseDialogueByCharacter(req.row.dialogue ?? '', cards)
  // eslint-disable-next-line no-console
  console.log('[voice-debug][attachVoiceRefs] parsed dialogue', { lines })

  // Build the attached list FIRST (positional 1-indexed slot per character
  // that has both a dialogue line + a voice binding). The slot index maps
  // directly to the `音色N` label in the prompt and the position in the
  // voiceAudioUrls array Seedance receives as inputs.
  const attached: AttachVoiceRefsResult['attached'] = []
  const skipped: Array<{ character: string; reason: string }> = []
  let slot = 0
  for (const card of cards) {
    const line = lines[card.name] ?? ''
    if (!line) {
      skipped.push({ character: card.name, reason: 'no dialogue line for this character' })
      continue
    }
    const voiceId = req.voiceBindings[card.name]
    if (!voiceId) {
      skipped.push({ character: card.name, reason: `no voiceBinding for "${card.name}" (keys present: ${Object.keys(req.voiceBindings).join(',')})` })
      continue
    }
    const voiceUrl = req.voiceUrlFor(voiceId)
    if (!voiceUrl) {
      skipped.push({ character: card.name, reason: `voiceUrlFor(${voiceId}) returned null/empty` })
      continue
    }
    slot += 1
    attached.push({ slot, character: card.name, voiceId, voiceUrl, line })
  }
  // eslint-disable-next-line no-console
  console.log('[voice-debug][attachVoiceRefs] decision', {
    attached: attached.map((a) => ({ slot: a.slot, character: a.character, voiceId: a.voiceId, voiceUrl: a.voiceUrl })),
    skipped,
  })

  if (attached.length === 0) {
    yield { type: 'result', payload: { videoPrompt: req.videoPrompt, voiceAudioUrls: [], attached: [] } }
    return
  }

  // 1) Rewrite the cinematographer's 【对白 / DIALOGUE】 block to cite
  //    音色N inline next to each character that has a voice binding. This
  //    is what Seedance reads first; without the inline tag the dialogue
  //    block and the voice manifest below are disconnected.
  const charSlot = new Map<string, number>(attached.map((a) => [a.character, a.slot]))
  const annotatedDialogue = annotateDialogueWithVoiceTags(req.row.dialogue ?? '', cards, charSlot)
  const oldDialogueBlock = `【对白 / DIALOGUE】\n${(req.row.dialogue ?? '').trim()}`
  const newDialogueBlock = `【对白 / DIALOGUE】(音色对应见下方 VOICE MAPPING)\n${annotatedDialogue}`
  let videoPrompt = req.videoPrompt
  if (videoPrompt.includes(oldDialogueBlock)) {
    videoPrompt = videoPrompt.replace(oldDialogueBlock, newDialogueBlock)
  }

  // 2) Append a compact voice-mapping block at the end. Dialogue isn't
  //    duplicated here — it's already cited inline above. This block is
  //    just the slot→voice manifest + the model instruction.
  const characterLines = attached
    .map((a) => `- 音色${a.slot} = ${a.character} 的配音 (audio reference ${a.slot})`)
    .join('\n')

  const appended = fillTemplate(TPL.attachVoiceRefs, { characterLines })
  videoPrompt = `${videoPrompt.trim()}\n\n${appended.trim()}`
  const voiceAudioUrls = attached.map((a) => a.voiceUrl)
  yield { type: 'result', payload: { videoPrompt, voiceAudioUrls, attached } }
}

/**
 * Rewrite a raw dialogue string so each `Character: line` has its bound
 * voice slot inline, e.g. `Alice (音色1): line`. Characters without a
 * voice binding keep their plain `Name: line` shape. Single-character
 * rows with no `Name:` prefix get the character + slot prepended.
 */
function annotateDialogueWithVoiceTags(
  dialogue: string,
  cards: ActorCharacterCard[],
  charSlot: Map<string, number>,
): string {
  if (!dialogue.trim()) return ''
  const rawLines = dialogue.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const out: string[] = []
  for (const raw of rawLines) {
    const m = raw.match(/^([^:：]{1,16})\s*[:：]\s*(.+)$/)
    if (m) {
      const name = m[1].trim()
      const text = m[2].trim()
      const card = cards.find((c) => canonicalName(c.name) === canonicalName(name))
      if (card) {
        const slot = charSlot.get(card.name)
        const tag = slot ? ` (音色${slot})` : ''
        out.push(`${card.name}${tag}: ${text}`)
        continue
      }
    }
    // Single-character row with no `Name:` prefix → attribute to the lone card.
    if (cards.length === 1) {
      const card = cards[0]
      const slot = charSlot.get(card.name)
      const tag = slot ? ` (音色${slot})` : ''
      out.push(`${card.name}${tag}: ${raw}`)
    } else {
      out.push(raw)
    }
  }
  return out.join('\n')
}

function parseDialogueByCharacter(
  dialogue: string,
  cards: ActorCharacterCard[],
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!dialogue.trim()) return out

  // Multi-character format: `角色名: line` lines (one per line).
  const lines = dialogue.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  let matched = 0
  for (const line of lines) {
    const m = line.match(/^([^:：]{1,16})\s*[:：]\s*(.+)$/)
    if (m) {
      const name = m[1].trim()
      const text = m[2].trim()
      // canonicalName strips the bilingual "(English)" tail so a dialogue
      // prefix `"莉安"` matches a card `"莉安 (Lian)"`.
      const card = cards.find((c) => canonicalName(c.name) === canonicalName(name))
      if (card) {
        out[card.name] = out[card.name] ? `${out[card.name]} ${text}` : text
        matched++
      }
    }
  }
  // Single-character row with no prefix: attribute the whole dialogue
  // to the sole character on stage.
  if (matched === 0 && cards.length === 1) {
    out[cards[0].name] = dialogue.trim()
  }
  return out
}

// ─── Verb: designCharacters ──────────────────────────────────────

interface BuildDesignCharactersPromptArgs {
  extractedCharacters: ExtractedCharacterInput[]
  castingCards: ActorCharacterCard[]
  creativeBrief?: DesignCharactersRequest['creativeBrief']
  visualStyle?: string
}

function buildDesignCharactersPrompt(args: BuildDesignCharactersPromptArgs): string {
  return fillTemplate(TPL.designCharacters, {
    extractedCharactersJson: JSON.stringify(args.extractedCharacters, null, 2),
    castingCardsJson: JSON.stringify(args.castingCards, null, 2),
    creativeBriefJson: JSON.stringify(args.creativeBrief ?? {}, null, 2),
    visualStyle: args.visualStyle ?? '(未指定 / unspecified)',
  })
}

/**
 * Extract a JSON array (the design output) from the LLM response. Mirrors
 * extractFirstJsonObject but for arrays — the design verb returns one
 * design object per character.
 */
function extractFirstJsonArray(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidates = [fence?.[1], text].filter((c): c is string => typeof c === 'string')
  for (const c of candidates) {
    const start = c.indexOf('[')
    const end = c.lastIndexOf(']')
    if (start < 0 || end < 0 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch {
      // try next
    }
  }
  throw new Error('actor-agent: model output did not contain a parseable JSON array')
}

/**
 * Compose the 7 pillars into a single image-generation prompt — used as
 * a safety net when the LLM's `appearance_prompt` is suspiciously short
 * (some models compress aggressively). Pillar 7 always lands last.
 */
function composePillarsIntoPrompt(p: AppearancePillars): string {
  return [
    p.subject,
    p.bone_structure,
    p.features,
    p.expression,
    p.texture_light,
    p.quality,
    p.anti_ai,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * designCharacters — for each extracted character, produce biography +
 * 7-pillar appearance + composed image-prompt. Caller (director-assistant)
 * patches each ExtractedCharacter.image_prompt with the design's
 * appearance_prompt before handing the extraction to art-director.
 */
export async function* designCharacters(
  req: DesignCharactersRequest,
  ctx: ProjectContext,
): AgentGenerator<CharacterDesigns> {
  if (req.extractedCharacters.length === 0) {
    yield { type: 'result', payload: [] }
    return
  }

  yield {
    type: 'progress',
    message: `actor: designing ${req.extractedCharacters.length} character${req.extractedCharacters.length === 1 ? '' : 's'} (biography + 7-pillar appearance)`,
  }

  const prompt = buildDesignCharactersPrompt({
    extractedCharacters: req.extractedCharacters,
    castingCards: req.castingCards,
    creativeBrief: req.creativeBrief,
    visualStyle: req.visualStyle,
  })

  const llmResponse = await ctx.llm.complete(
    [{ role: 'user', content: prompt }],
    { system: SYSTEM, signal: ctx.abort },
  )
  const json = extractFirstJsonArray(llmResponse)
  const parsed = CharacterDesignsSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `actor-agent: designCharacters JSON failed validation: ${z.prettifyError(parsed.error)}`,
    )
  }

  // Safety-net the appearance_prompt — if the LLM compressed it too
  // hard, recompose from the validated pillars so the image model still
  // receives the full directive.
  const enriched: CharacterDesigns = parsed.data.map((d) => {
    const recomposed = composePillarsIntoPrompt(d.appearance_pillars)
    return {
      ...d,
      appearance_prompt:
        d.appearance_prompt.length >= recomposed.length * 0.7
          ? d.appearance_prompt
          : recomposed,
    }
  })

  // Defensive: warn if the LLM skipped any extracted character.
  const designed = new Set(enriched.map((d) => d.name))
  const missing = req.extractedCharacters
    .map((c) => c.name)
    .filter((n) => !designed.has(n))
  if (missing.length > 0) {
    ctx.log(`actor: designCharacters skipped ${missing.length} character(s) — caller will fall back to extracted prompts: ${missing.join(', ')}`)
  }

  yield { type: 'result', payload: enriched }
}

// Pure helpers exported for tests.
export {
  buildCastVoicesPrompt,
  buildDesignCharactersPrompt,
  buildEnrichRowPrompt,
  cardsForRow,
  composePillarsIntoPrompt,
  nameFromSlotDescription,
  parseDialogueByCharacter,
}

// ─── Module metadata ─────────────────────────────────────────────

export const actorAgent = {
  meta: {
    name: 'actor-agent',
    description: 'Plays characters, rewrites performance fields, designs biographies + 7-pillar appearances, picks voices, augments cinematographer prompts',
    model: 'claude-sonnet-4-5',
  },
  systemPrompt: SYSTEM,
  enrichRow,
  enrichTable,
  designCharacters,
  castVoices,
  attachVoiceRefs,
} as const

export type {
  ActorCharacterCard,
  ActorRow,
  AppearancePillars,
  AttachVoiceRefsRequest,
  AttachVoiceRefsResult,
  CastVoicesRequest,
  CharacterDesign,
  CharacterDesigns,
  DesignCharactersRequest,
  EnrichRowRequest,
  EnrichTableRequest,
  EnrichTableResult,
  EnrichedPerformanceFields,
  ExtractedCharacterInput,
  VoiceBindings,
  VoiceCandidateSummary,
} from './schema'
