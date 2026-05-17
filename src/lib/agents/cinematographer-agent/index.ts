/**
 * cinematographer-agent — shoots beat-video clips via Seedance 2.0 and
 * revises generation prompts when director-agent.critiqueVideoConsistency
 * flags issues.
 *
 * Two async-generator verbs:
 *   - shoot(req)  → BeatVideoResult { url, prompt, durationSeconds, refs }
 *   - revise(req) → BeatVideoResult with the LLM-rewritten prompt that
 *                   addresses each VideoConsistencyIssue, then re-shoots
 *
 * Caller-side (useStoryboardGenerate.generateBeatVideo) writes the
 * resulting URL back to canvas/storyboard stores — the agent stays pure.
 */

import { runCapability } from '@/lib/capabilities/client'
import { fillTemplate, parseFrontmatter } from '@/lib/agents/_shared/mustache'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import type { AgentGenerator } from '@/lib/agents/_shared/runtime/types'

import skillSource from './SKILL.md?raw'
import shootSource from './prompts/shoot.md?raw'
import reviseSource from './prompts/revise.md?raw'

import type {
  BeatVideoContextRef,
  BeatVideoRef,
  BeatVideoResult,
  BeatVideoRow,
  ReviseRequest,
  ShootRequest,
} from './schema'

const { body: SYSTEM } = parseFrontmatter(skillSource)
const TPL = {
  shoot: parseFrontmatter(shootSource).body,
  revise: parseFrontmatter(reviseSource).body,
}

// ─── Seedance pin ──────────────────────────────────────────────────
//
// Seedance 2.0 is the contracted camera. Pin both ids here so successive
// shoots stay deterministic and a future model bump is a one-line change.

export const SHOOT_PROVIDER = 'doubao'
// Default to the full Seedance 2.0 model (not the -fast variant) so 480p
// shoots have the higher-quality model behind them. The capability plugin
// already defaults `resolution: '480p'`, so the keyframe-shot pipeline
// gets 480p Seedance 2.0 out of the box.
export const SHOOT_MODEL = 'doubao-seedance-2-0-260128'
export const SHOOT_RESOLUTION = '480p'
const MIN_DURATION = 5
const MAX_DURATION = 15

function clampDuration(seconds: number): number {
  return Math.min(Math.max(Math.round(seconds), MIN_DURATION), MAX_DURATION)
}

function buildContextRefLine(contextRefs: BeatVideoContextRef[]): string {
  if (contextRefs.length === 0) return ''
  // Bake the names + descriptions into the motion text so the model knows
  // what to read out of the keyframe under omni-reference mode. No image
  // inputs — just text context.
  const parts = contextRefs.map((c) => {
    const desc = c.description ? ` (${c.description})` : ''
    return `${c.role}${desc}`
  })
  return `Featuring / 出场: ${parts.join('；')}.`
}

function buildMotionDescription(req: {
  row: BeatVideoRow
  visualStyle?: string
  contextRefs?: BeatVideoContextRef[]
}): string {
  const r = req.row
  return [
    req.visualStyle ? `Strictly maintain ${req.visualStyle} style throughout the entire clip.` : '',
    r.motion_prompts,
    r.storyboard_prompts
      ? `director storyboard panel progression (read sequentially over time, not a literal split-screen): ${r.storyboard_prompts}`
      : '',
    'Use the storyboard grid as temporal guidance for Seedance 2: each panel is a beat in the video progression, not a literal split-screen layout.',
    r.visual_description,
    r.character_actions,
    r.emotion_mood,
    r.emotion_atmosphere,
    r.character_motivation ? `character motivation: ${r.character_motivation}` : '',
    r.character_psychology ? `inner psychology: ${r.character_psychology}` : '',
    r.performance_guidance ? `performance guidance: ${r.performance_guidance}` : '',
    r.lighting_atmosphere,
    r.shot_size ? `${r.shot_size} shot` : '',
    // Dialogue must travel as part of the motion description so the model
    // knows what is being SAID in this beat — actor-agent.attachVoiceRefs
    // additionally pairs each line with its 音色N audio reference below.
    r.dialogue && r.dialogue.trim() ? `对白 / dialogue spoken in this beat:\n${r.dialogue.trim()}` : '',
    buildContextRefLine(req.contextRefs ?? []),
  ]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join('. ')
}

/**
 * The image legend lists ONLY the keyframe — omni-reference (全能参考) mode
 * means a single image input. Character / scene / prop info goes into the
 * motion text via buildContextRefLine.
 */
function buildImageLegend(_keyframeUrl: string): string {
  void _keyframeUrl
  return [
    '【REFERENCE IMAGE / 参考图】 (omni-reference / 全能参考):',
    '- image1 / @图片1 = Keyframe (the director storyboard sheet — read casting, scene, blocking, lighting from it; do NOT shoot the sheet itself).',
  ].join('\n')
}

function assembleShootPrompt(req: {
  row: BeatVideoRow
  keyframeUrl: string
  contextRefs?: BeatVideoContextRef[]
  visualStyle?: string
}): string {
  const motion = buildMotionDescription(req) || 'cinematic motion'
  const legend = buildImageLegend(req.keyframeUrl)
  return fillTemplate(TPL.shoot, {
    motionDescription: motion,
    imageLegend: legend,
  }).trim()
}

async function callSeedance(opts: {
  prompt: string
  keyframeUrl: string
  voiceAudioUrls?: string[]
  durationSeconds: number
  aspect: '16:9' | '9:16' | '1:1' | '4:3'
}): Promise<string> {
  // ONE image input: the keyframe (omni-reference / 全能参考). We deliberately
  // don't ship character / scene / prop asset images alongside — the model
  // reads casting, scene, blocking, lighting from the keyframe itself.
  //
  // PER-CHARACTER voice files travel as audio inputs (when dialogue exists)
  // so Seedance can match each spoken line to its corresponding 音色N
  // reference. The capability dispatcher auto-routes audios → universal-to-
  // video mode.
  const voiceInputs = (opts.voiceAudioUrls ?? [])
    .filter((u): u is string => Boolean(u && u.trim()))
    .slice(0, 3) // Seedance universal-to-video accepts up to 3 audios
    .map((url) => ({ kind: 'audio' as const, url }))

  const r = await runCapability({
    capability: 'text-to-video',
    inputs: [
      { kind: 'text', text: opts.prompt },
      { kind: 'image', url: opts.keyframeUrl },
      ...voiceInputs,
    ],
    params: {
      provider: SHOOT_PROVIDER,
      model: SHOOT_MODEL,
      duration: String(opts.durationSeconds),
      aspect: opts.aspect,
      // 480p default — explicit so it shows up in capability logs even
      // though the plugin already defaults to '480p' for unspecified
      // requests. Bump to '720p' / '1080p' once we wire a UI toggle.
      resolution: SHOOT_RESOLUTION,
      // Hints to the capability plugin to use omni-reference mode if the
      // provider exposes it as a flag (Doubao Seedance 2.0 supports it).
      reference_mode: 'omni',
    },
  })
  const url = r.outputs[0]?.url
  if (!url) throw new Error('cinematographer: text-to-video returned no url')
  return url
}

// ─── Verb: shoot ───────────────────────────────────────────────────

export async function* shoot(
  req: ShootRequest,
  ctx: ProjectContext,
): AgentGenerator<BeatVideoResult> {
  const shot = req.row.shot_number ?? '?'
  const durationSeconds = clampDuration(req.durationSecondsOverride ?? req.row.duration ?? MIN_DURATION)
  const aspect = req.aspect ?? '16:9'

  if (!req.keyframeUrl) {
    throw new Error(
      'cinematographer: shoot requires keyframeUrl (omni-reference mode needs the director keyframe as the single reference image). Generate the keyframe first.',
    )
  }

  yield {
    type: 'progress',
    message: `cinematographer: composing Seedance prompt for shot ${shot} (${durationSeconds}s, ${aspect}, omni-reference)`,
  }

  const basePrompt = assembleShootPrompt({
    row: req.row,
    keyframeUrl: req.keyframeUrl,
    contextRefs: req.contextRefs,
    visualStyle: req.visualStyle,
  })

  void ctx
  // Caller-supplied augmenter runs after the cinematographer prompt is
  // assembled and before Seedance is invoked. actor-agent.attachVoiceRefs
  // both rewrites the prompt (adds 音色1/音色2 dialogue block) AND returns
  // the audio URLs to ship as inputs alongside the keyframe.
  const augmented = req.promptPostProcessor ? await req.promptPostProcessor(basePrompt) : basePrompt
  const prompt = typeof augmented === 'string' ? augmented : augmented.videoPrompt
  const voiceAudioUrls = typeof augmented === 'string' ? undefined : augmented.voiceAudioUrls

  yield {
    type: 'progress',
    message: `cinematographer: rolling on Seedance (${SHOOT_PROVIDER}/${SHOOT_MODEL})${
      voiceAudioUrls?.length ? ` + ${voiceAudioUrls.length} voice ref${voiceAudioUrls.length === 1 ? '' : 's'}` : ''
    }`,
  }
  const url = await callSeedance({ prompt, keyframeUrl: req.keyframeUrl, voiceAudioUrls, durationSeconds, aspect })

  yield {
    type: 'result',
    payload: {
      url,
      prompt,
      durationSeconds,
      keyframeUrl: req.keyframeUrl,
      contextRefs: req.contextRefs ?? [],
    },
  }
}

// ─── Verb: revise ──────────────────────────────────────────────────

/**
 * Format director critique items as a numbered list for the revise prompt.
 * Severity is included so the LLM can prioritize blocking > major > minor.
 */
function formatFeedbackForRevise(feedback: ReviseRequest['feedback']): string {
  if (feedback.length === 0) return '(无 — 上一版通过，但导演要求重拍)'
  return feedback
    .map((f, i) => {
      const fix = f.fix ? ` → fix: ${f.fix}` : ''
      return `${i + 1}. [${f.severity}] (${f.aspect}) ${f.summary}${fix}`
    })
    .join('\n')
}

export async function* revise(
  req: ReviseRequest,
  ctx: ProjectContext,
): AgentGenerator<BeatVideoResult> {
  const shot = req.row.shot_number ?? '?'
  const durationSeconds = clampDuration(req.durationSecondsOverride ?? req.row.duration ?? MIN_DURATION)
  const aspect = req.aspect ?? '16:9'

  if (!req.keyframeUrl) {
    throw new Error('cinematographer: revise requires keyframeUrl (omni-reference mode)')
  }

  yield {
    type: 'progress',
    message: `cinematographer: revising shot ${shot} based on ${req.feedback.length} director note(s)`,
  }

  // Ask the LLM to rewrite the prompt addressing each feedback item, then
  // we re-shoot with the rewritten prompt.
  const reviseInstruction = fillTemplate(TPL.revise, {
    previousPrompt: req.previous.prompt,
    feedback: formatFeedbackForRevise(req.feedback),
  })

  const revisedPrompt = (await ctx.llm.complete(
    [{ role: 'user', content: reviseInstruction }],
    { system: SYSTEM, signal: ctx.abort },
  )).trim()

  if (!revisedPrompt) {
    throw new Error('cinematographer: revise LLM returned empty rewrite')
  }

  yield {
    type: 'progress',
    message: `cinematographer: re-rolling on Seedance with revised prompt`,
  }
  const url = await callSeedance({ prompt: revisedPrompt, keyframeUrl: req.keyframeUrl, durationSeconds, aspect })

  yield {
    type: 'result',
    payload: {
      url,
      prompt: revisedPrompt,
      durationSeconds,
      keyframeUrl: req.keyframeUrl,
      contextRefs: req.contextRefs ?? [],
    },
  }
}

// Pure helpers — exported for tests + reuse.
export {
  buildMotionDescription,
  buildContextRefLine,
  buildImageLegend,
  assembleShootPrompt,
  clampDuration,
}

// ─── Module metadata ──────────────────────────────────────────────

export const cinematographerAgent = {
  meta: {
    name: 'cinematographer-agent',
    description: 'Shoots and revises beat-video clips via Seedance 2.0',
    model: 'claude-sonnet-4-5',
  },
  systemPrompt: SYSTEM,
  shoot,
  revise,
} as const

export type {
  BeatVideoContextRef,
  BeatVideoRef,
  BeatVideoResult,
  BeatVideoRow,
  ShootRequest,
  ReviseRequest,
} from './schema'
