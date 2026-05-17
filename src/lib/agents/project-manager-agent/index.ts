/**
 * project-manager-agent — the chat-panel front door.
 *
 * One verb: `interpretRequest(req)` takes a free-form user message + a
 * snapshot of project gaps, and returns a structured plan the chat panel
 * can execute. PM never writes scripts / shots / music itself — it
 * dispatches to whichever downstream agent owns the work.
 */

import { z } from 'zod'

import { fillTemplate, parseFrontmatter } from '@/lib/agents/_shared/mustache'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import type { AgentGenerator } from '@/lib/agents/_shared/runtime/types'

import skillSource from './SKILL.md?raw'
import interpretRequestSource from './prompts/interpret-request.md?raw'

import {
  PMPlanSchema,
  type PMInterpretRequest,
  type PMPlan,
} from './schema'

const { body: SYSTEM } = parseFrontmatter(skillSource)
const TPL = {
  interpretRequest: parseFrontmatter(interpretRequestSource).body,
}

function extractFirstJsonObject(text: string): unknown {
  // PM is asked for raw JSON, but be forgiving in case the model wraps
  // in ```json … ``` anyway.
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
  throw new Error('project-manager-agent: model output did not contain a parseable JSON object')
}

function buildInterpretRequestPrompt(req: PMInterpretRequest): string {
  return fillTemplate(TPL.interpretRequest, {
    userMessage: req.userMessage,
    gapSummaryJson: JSON.stringify(req.gapSummary, null, 2),
    recentMessagesJson: JSON.stringify(req.recentMessages, null, 2),
  })
}

export async function* interpretRequest(
  req: PMInterpretRequest,
  ctx: ProjectContext,
): AgentGenerator<PMPlan> {
  yield { type: 'progress', message: 'PM: routing your request' }

  const prompt = buildInterpretRequestPrompt(req)
  const llmResponse = await ctx.llm.complete(
    [{ role: 'user', content: prompt }],
    { system: SYSTEM, signal: ctx.abort },
  )

  const json = extractFirstJsonObject(llmResponse)
  const parsed = PMPlanSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`project-manager-agent: plan JSON failed validation: ${z.prettifyError(parsed.error)}`)
  }

  // Schema-level rule (also in SKILL): ask-user and chat-response must
  // stand alone in a plan. Reject mixed plans at the agent boundary so
  // the chat panel never has to handle this edge case.
  const exclusiveTypes = new Set(['ask-user', 'chat-response'])
  if (parsed.data.actions.length > 1 && parsed.data.actions.some((a) => exclusiveTypes.has(a.type))) {
    throw new Error('project-manager-agent: ask-user / chat-response cannot be mixed with other actions in a plan')
  }

  yield { type: 'result', payload: parsed.data }
}

// Pure helpers exported for tests.
export { buildInterpretRequestPrompt }

export const projectManagerAgent = {
  meta: {
    name: 'project-manager-agent',
    description: 'Chat-panel front door: routes free-form requests to the right downstream agent or replies in chat.',
    model: 'claude-sonnet-4-5',
  },
  systemPrompt: SYSTEM,
  interpretRequest,
} as const

export type { PMAction, PMGapSummary, PMInterpretRequest, PMPlan, PMRecentMessage } from './schema'
