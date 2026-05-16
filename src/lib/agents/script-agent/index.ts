/**
 * script-agent — the script-domain orchestrator.
 *
 * Interviews the requester for input shape + desired flow + tone, then either
 * delegates to a sub-agent (framework-qa / writing-expansion / doctor-roundtable
 * / dialogue-doctor) or runs the default expand-script flow.
 *
 * The sub-agent folders currently ship as placeholders. They'll be filled in
 * once the `.claude/skills/` markdown sources reach main (PR #13).
 */

import { z } from 'zod'

import { delegate } from '@/lib/agents/_shared/runtime/runner'
import type {
  AgentGenerator,
  AgentModule,
  Answer,
} from '@/lib/agents/_shared/runtime/types'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import {
  fillTemplate,
  parseFrontmatter,
} from '@/lib/agents/_shared/mustache'

import {
  type ScriptDossier,
  type ScriptInputShape,
  type ScriptRequest,
  type ScriptSubAgent,
  ScriptDossierSchema,
  ScriptInputShapeSchema,
  ScriptSubAgentSchema,
} from './schema'

import skillSource from './SKILL.md?raw'
import expandScriptSource from './prompts/expand-script.md?raw'

const { body: SCRIPT_AGENT_SYSTEM } = parseFrontmatter(skillSource)
const { body: EXPAND_SCRIPT_TEMPLATE } = parseFrontmatter(expandScriptSource)

const TONE_OPTIONS = [
  { value: 'drama', label: 'Drama' },
  { value: 'comedy', label: 'Comedy' },
  { value: 'thriller', label: 'Thriller' },
  { value: 'horror', label: 'Horror' },
  { value: 'documentary', label: 'Documentary' },
  { value: 'slice-of-life', label: 'Slice of life' },
  { value: 'mixed', label: 'Mixed / unspecified' },
] as const

const INPUT_SHAPE_OPTIONS: Array<{
  value: ScriptInputShape
  label: string
  description: string
}> = [
  {
    value: 'rough-idea',
    label: 'Rough idea',
    description: 'One-line concept; needs structure and beats built from scratch.',
  },
  {
    value: 'partial-script',
    label: 'Partial script',
    description: 'Some beats or scenes exist; needs filling in.',
  },
  {
    value: 'complete-draft',
    label: 'Complete draft',
    description: 'Full draft; mainly wants critique and cleanup, not regeneration.',
  },
  {
    value: 'specific-scene',
    label: 'Specific scene',
    description: 'Focused expansion of one scene/beat; keep surrounding text untouched.',
  },
]

const SUB_AGENT_OPTIONS: Array<{
  value: ScriptSubAgent
  label: string
  description: string
}> = [
  {
    value: 'default',
    label: 'Full Script → Casting contract',
    description: 'Run expand-script: framework + casting + scene/prop cards + storyboard directives.',
  },
  {
    value: 'framework-qa',
    label: 'Framework discovery (Q&A)',
    description: 'Delegate to framework-qa sub-agent for 7-layer dossier discovery.',
  },
  {
    value: 'writing-expansion',
    label: 'Full screenplay expansion',
    description: 'Delegate to writing-expansion sub-agent (assumes a dossier already exists).',
  },
  {
    value: 'doctor-roundtable',
    label: 'Critique only (no rewrite)',
    description: 'Delegate to doctor-roundtable sub-agent for multi-perspective diagnosis.',
  },
  {
    value: 'dialogue-doctor',
    label: 'Line-by-line dialogue rewrite',
    description: 'Delegate to dialogue-doctor sub-agent.',
  },
]

interface SubAgentRunner {
  run(
    request: { scriptText: string; tone: string; inputShape: ScriptInputShape },
    ctx: ProjectContext,
  ): AgentGenerator<ScriptDossier>
}

export interface ScriptAgentDeps {
  /** Optional override map for sub-agent runners. Tests pass mocks; prod will
   *  resolve from `ctx.tools.peers` once sub-agents have real implementations. */
  subAgents?: Partial<Record<Exclude<ScriptSubAgent, 'default'>, SubAgentRunner>>
  /** Override the default expand-script prompt body (tests). */
  expandScriptPrompt?: string
}

/**
 * Recommend an input shape from the raw text length.
 * Pure heuristic — the requester can always override.
 */
function recommendInputShape(scriptText: string): ScriptInputShape {
  const len = scriptText.trim().length
  if (len < 200) return 'rough-idea'
  if (len < 1500) return 'partial-script'
  return 'complete-draft'
}

function pickFirst<T extends string>(answer: Answer | undefined, fallback: T): T {
  if (!answer) return fallback
  const choice = answer.selected[0] ?? answer.text?.trim() ?? ''
  return (choice as T) || fallback
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
      // try next candidate
    }
  }
  throw new Error('script-agent: model output did not contain a parseable JSON object')
}

function persistDossier(dossier: ScriptDossier, ctx: ProjectContext): void {
  for (const card of dossier.casting_cards) {
    ctx.project.characters.add({
      name: card.name,
      description: [
        card.dramatic_function,
        card.appearance_for_image,
        card.personality_layers,
        card.performance_anchors && `表演锚点：${card.performance_anchors}`,
        card.voice_print && `声纹：${card.voice_print}`,
      ]
        .filter(Boolean)
        .join('\n'),
    })
  }
  for (const card of dossier.scene_cards) {
    ctx.project.scenes.add({
      name: card.name,
      description: [card.location, card.time_of_day, card.mood, card.visual_requirements]
        .filter(Boolean)
        .join(' / '),
    })
  }
  for (const card of dossier.prop_cards) {
    ctx.project.props.add({
      name: card.name,
      description: [card.description, card.dramatic_significance].filter(Boolean).join(' — '),
    })
  }
  for (let i = 0; i < dossier.expanded_script_baseline.beat_summary.length; i++) {
    const summary = dossier.expanded_script_baseline.beat_summary[i]
    ctx.project.beats.add({
      id: `B${i + 1}`,
      summary,
      body: summary,
    })
  }
}

export function createScriptAgent(deps: ScriptAgentDeps = {}): AgentModule<
  ScriptRequest,
  ScriptDossier,
  ScriptDossier
> {
  const expandScriptTemplate = deps.expandScriptPrompt ?? EXPAND_SCRIPT_TEMPLATE

  async function* run(
    request: ScriptRequest,
    ctx: ProjectContext,
  ): AgentGenerator<ScriptDossier> {
    if (!request.scriptText || request.scriptText.trim().length === 0) {
      throw new Error('script-agent: scriptText is required')
    }

    const recommendedShape = recommendInputShape(request.scriptText)
    const shapeAnswer = (yield {
      type: 'question',
      question: {
        q: '你带来的是什么形态的输入？',
        header: 'Input shape',
        options: INPUT_SHAPE_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          description: o.description,
        })),
        recommended: recommendedShape,
      },
    }) as Answer | undefined
    const inputShape = ScriptInputShapeSchema.parse(pickFirst(shapeAnswer, recommendedShape))

    const subAgentAnswer = (yield {
      type: 'question',
      question: {
        q: '你希望本轮跑哪一条剧本工作流？',
        header: 'Flow',
        options: SUB_AGENT_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          description: o.description,
        })),
        recommended: 'default',
      },
    }) as Answer | undefined
    const chosen = ScriptSubAgentSchema.parse(pickFirst(subAgentAnswer, 'default'))

    const toneAnswer = (yield {
      type: 'question',
      question: {
        q: '主导情绪基调？(可凭画布风格自动推荐)',
        header: 'Tone',
        options: TONE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        recommended: 'mixed',
      },
    }) as Answer | undefined
    const tone = pickFirst(toneAnswer, 'mixed')

    if (chosen !== 'default') {
      const runner = deps.subAgents?.[chosen]
      if (!runner) {
        throw new Error(
          `script-agent: sub-agent "${chosen}" is not wired yet. ` +
            `Pass deps.subAgents.${chosen} or wait for the sub-agent migration commit.`,
        )
      }
      yield {
        type: 'progress',
        message: `delegating to ${chosen} sub-agent`,
      }
      const sub = runner.run({ scriptText: request.scriptText, tone, inputShape }, ctx)
      const dossier = yield* delegate(sub)
      persistDossier(dossier, ctx)
      yield { type: 'result', payload: dossier }
      return
    }

    yield { type: 'progress', message: 'running default expand-script flow' }

    const filled = fillTemplate(expandScriptTemplate, {
      scriptText: request.scriptText,
      artStyle: ctx.project.style.get().promptText || ctx.project.style.get().presetId,
      canvasContext: request.canvasContext ?? '',
      existingStoryboard: request.existingStoryboard ?? '',
      inputShape,
      tone,
    })

    const llmResponse = await ctx.llm.complete(
      [{ role: 'user', content: filled }],
      { system: SCRIPT_AGENT_SYSTEM, signal: ctx.abort },
    )

    const json = extractFirstJsonObject(llmResponse)
    const dossier = parseDossierStrict(json)
    persistDossier(dossier, ctx)
    yield { type: 'result', payload: dossier }
  }

  return {
    meta: {
      name: 'script-agent',
      description: 'Top-level script-domain agent',
      model: 'claude-sonnet-4-5',
    },
    systemPrompt: SCRIPT_AGENT_SYSTEM,
    run,
  }
}

function parseDossierStrict(json: unknown): ScriptDossier {
  const parsed = ScriptDossierSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `script-agent: dossier JSON failed validation: ${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
}

/** Pre-instantiated default — most callers use this. */
export const scriptAgent = createScriptAgent()

export type { ScriptDossier, ScriptRequest } from './schema'
