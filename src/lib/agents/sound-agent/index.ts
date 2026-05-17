/**
 * sound-agent — designs per-row sound (BGM brief + SFX list + 3-track
 * mixing brief). Description-first; actual audio generation is a separate
 * capability pass landing in a later PR.
 *
 * Two verbs:
 *   designRow(req)   → SoundBrief (one row at a time)
 *   designTable(req) → Record<rowId, SoundBrief> (batch)
 */

import { z } from 'zod'

import { fillTemplate, parseFrontmatter } from '@/lib/agents/_shared/mustache'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import type { AgentGenerator } from '@/lib/agents/_shared/runtime/types'

import skillSource from './SKILL.md?raw'
import designRowSource from './prompts/design-row.md?raw'

import {
  SoundBriefSchema,
  type DesignRowRequest,
  type DesignTableRequest,
  type DesignTableResult,
  type SoundBrief,
  type SoundRow,
} from './schema'

const { body: SYSTEM } = parseFrontmatter(skillSource)
const TPL = {
  designRow: parseFrontmatter(designRowSource).body,
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Extract the first JSON object from an LLM response. Same shape as the
 * actor-agent helper — accepts fenced ```json blocks or bare JSON, scans
 * for the first { ... } that parses. Throws when none found.
 */
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
      // try next candidate
    }
  }
  throw new Error('sound-agent: model output did not contain a parseable JSON object')
}

function parseSoundBriefStrict(json: unknown): SoundBrief {
  const parsed = SoundBriefSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`sound-agent: SoundBrief JSON failed validation: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

/**
 * Merge an LLM-produced SoundBrief into the row's existing values:
 *   - `overwrite: true`  → every field comes from the LLM
 *   - `overwrite: false` → keep any non-empty existing value, fill only the
 *                          empty/missing ones from the LLM
 * Always returns all three fields populated (the row contract).
 */
function mergeBriefIntoRow(row: SoundRow, llm: SoundBrief, overwrite: boolean): SoundBrief {
  if (overwrite) return llm
  return {
    bgm: (row.bgm ?? '').trim() ? row.bgm! : llm.bgm,
    sound_effects: (row.sound_effects ?? '').trim() ? row.sound_effects! : llm.sound_effects,
    mixing_brief: (row.mixing_brief ?? '').trim() ? row.mixing_brief! : llm.mixing_brief,
  }
}

/** True iff every sound field on the row is already populated. */
function rowAlreadyFullySpec(row: SoundRow): boolean {
  return (
    Boolean((row.bgm ?? '').trim()) &&
    Boolean((row.sound_effects ?? '').trim()) &&
    Boolean((row.mixing_brief ?? '').trim())
  )
}

interface BuildPromptArgs {
  row: SoundRow
  creativeBrief?: DesignRowRequest['creativeBrief']
  visualStyle?: string
}

function buildDesignRowPrompt(args: BuildPromptArgs): string {
  return fillTemplate(TPL.designRow, {
    rowJson: JSON.stringify(args.row, null, 2),
    creativeBriefJson: JSON.stringify(args.creativeBrief ?? {}, null, 2),
    visualStyle: args.visualStyle ?? '(未指定 / unspecified)',
  })
}

// ─── Verb: designRow ─────────────────────────────────────────────

export async function* designRow(
  req: DesignRowRequest,
  ctx: ProjectContext,
): AgentGenerator<SoundBrief> {
  const shot = req.row.shot_number ?? '?'
  const overwrite = req.overwrite ?? false

  // Short-circuit when nothing to do: row is fully spec'd AND we're not
  // forcing an overwrite. Save an LLM call.
  if (!overwrite && rowAlreadyFullySpec(req.row)) {
    yield {
      type: 'progress',
      message: `sound: shot ${shot} already has all 3 sound fields — keeping existing values`,
    }
    yield {
      type: 'result',
      payload: {
        bgm: req.row.bgm!,
        sound_effects: req.row.sound_effects!,
        mixing_brief: req.row.mixing_brief!,
      },
    }
    return
  }

  yield {
    type: 'progress',
    message: `sound: designing shot ${shot} (BGM + SFX + mixing brief${overwrite ? ', overwrite' : ''})`,
  }

  const prompt = buildDesignRowPrompt({
    row: req.row,
    creativeBrief: req.creativeBrief,
    visualStyle: req.visualStyle,
  })

  const llmResponse = await ctx.llm.complete(
    [{ role: 'user', content: prompt }],
    { system: SYSTEM, signal: ctx.abort },
  )
  const json = extractFirstJsonObject(llmResponse)
  const llmBrief = parseSoundBriefStrict(json)
  yield { type: 'result', payload: mergeBriefIntoRow(req.row, llmBrief, overwrite) }
}

// ─── Verb: designTable ───────────────────────────────────────────

export async function* designTable(
  req: DesignTableRequest,
  ctx: ProjectContext,
): AgentGenerator<DesignTableResult> {
  const out: DesignTableResult = {}
  for (const row of req.rows) {
    try {
      const sub = designRow(
        {
          row,
          creativeBrief: req.creativeBrief,
          visualStyle: req.visualStyle,
          overwrite: req.overwrite,
        },
        ctx,
      )
      // Drain the sub-generator manually so per-row progress/result turns
      // surface through THIS generator (no nested chat bridges). Errors on
      // one row don't kill the batch — they get logged and skipped.
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
      ctx.log(`sound: shot ${row.shot_number ?? row.id} design failed: ${(e as Error).message}`)
    }
  }
  yield { type: 'result', payload: out }
}

// Pure helpers exported for tests.
export { buildDesignRowPrompt, mergeBriefIntoRow, rowAlreadyFullySpec }

// ─── Module metadata ─────────────────────────────────────────────

export const soundAgent = {
  meta: {
    name: 'sound-agent',
    description:
      'Designs per-row sound — BGM brief, SFX list, and 3-track mixing brief. Description-first; actual audio generation is a separate capability pass.',
    model: 'claude-sonnet-4-5',
  },
  systemPrompt: SYSTEM,
  designRow,
  designTable,
} as const

export type {
  DesignRowRequest,
  DesignTableRequest,
  DesignTableResult,
  SoundBrief,
  SoundRow,
} from './schema'
