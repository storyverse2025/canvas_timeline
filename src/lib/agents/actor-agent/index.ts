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

import {
  EnrichedPerformanceFieldsSchema,
  type ActorCharacterCard,
  type ActorRow,
  type EnrichRowRequest,
  type EnrichTableRequest,
  type EnrichTableResult,
  type EnrichedPerformanceFields,
} from './schema'

const { body: SYSTEM } = parseFrontmatter(skillSource)
const TPL = {
  enrichRow: parseFrontmatter(enrichRowSource).body,
}

// ─── Helpers ──────────────────────────────────────────────────────

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
      .map((s) => s.toLowerCase()),
  )
  if (wanted.size === 0) return []
  const matched = allCards.filter((c) => wanted.has(c.name.toLowerCase()))
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

// Pure helpers exported for tests.
export { buildEnrichRowPrompt, cardsForRow, nameFromSlotDescription }

// ─── Module metadata ─────────────────────────────────────────────

export const actorAgent = {
  meta: {
    name: 'actor-agent',
    description: 'Plays each character and rewrites the 5 storyboard performance fields',
    model: 'claude-sonnet-4-5',
  },
  systemPrompt: SYSTEM,
  enrichRow,
  enrichTable,
} as const

export type {
  ActorCharacterCard,
  ActorRow,
  EnrichRowRequest,
  EnrichTableRequest,
  EnrichTableResult,
  EnrichedPerformanceFields,
} from './schema'
