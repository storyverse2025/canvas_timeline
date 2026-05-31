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

// Provider id is the BytePlus海外 (Dreamina) route. The string 'doubao' is
// retained as a stable internal identifier so persisted IndexedDB state from
// older builds still resolves; all calls hit ark.ap-southeast.bytepluses.com.
export const SHOOT_PROVIDER = 'doubao'
// Default to Dreamina Seedance 2.0 (full) — matches projectDB.artDirection
// default. The 'Fast' variant caps at 720p / 12s and trades quality for
// throughput; full opens 1080p + 15s and matches the look user pinned in
// art direction. Operators that explicitly want Fast pass the Fast id via
// runShootBeatVideos's `model` param.
export const SHOOT_MODEL = 'dreamina-seedance-2-0-260128'
export const SHOOT_RESOLUTION_DEFAULT: '480p' | '720p' | '1080p' = '480p'
const MIN_DURATION = 5
const MAX_DURATION = 15

function clampDuration(seconds: number): number {
  return Math.min(Math.max(Math.round(seconds), MIN_DURATION), MAX_DURATION)
}

function buildContextRefLine(contextRefs: BeatVideoContextRef[]): string {
  // Context refs (character/scene/prop descriptions) are intentionally NOT
  // baked into the motion text any more — they bias Seedance away from
  // what's actually in the keyframe image. Kept exported for tests/back-compat.
  void contextRefs
  return ''
}

function buildMotionDescription(req: {
  row: BeatVideoRow
  visualStyle?: string
  contextRefs?: BeatVideoContextRef[]
}): string {
  // Only dialogue + SFX survive in this block. motion_prompts / style /
  // scene / mood / motivation / psychology / lighting / shot size used to
  // be stripped because they biased Seedance away from the keyframe — but
  // the keyframe is now visual-only (storyboard panels + diagrams with no
  // embedded text labels), so the camera / lighting / motion vocabulary
  // is re-introduced by a separate `cinematography-describe` LLM step
  // that reads the keyframe image (see describeKeyframeCinematography
  // below). Dialogue + SFX stay here; voice refs are attached later by
  // actor-agent.attachVoiceRefs.
  void req.visualStyle
  void req.contextRefs
  const r = req.row
  const blocks: string[] = []
  if (r.dialogue && r.dialogue.trim()) {
    blocks.push(`【对白 / DIALOGUE】\n${r.dialogue.trim()}`)
  }
  if (r.sound_effects && r.sound_effects.trim()) {
    blocks.push(`【音效 / SFX】\n${r.sound_effects.trim()}`)
  }
  return blocks.join('\n\n')
}

/**
 * Build the row context string passed to the cinematography-describe LLM
 * step. The model uses these textual cues alongside the keyframe image to
 * ground its description in this specific shot rather than producing
 * generic cinematography prose.
 */
function buildCinematographyContext(row: BeatVideoRow, visualStyle?: string): string {
  const lines: string[] = []
  if (row.shot_number) lines.push(`镜头编号：${row.shot_number}`)
  if (row.shot_size) lines.push(`景别（用户已选）：${row.shot_size}`)
  if (row.visual_description) lines.push(`画面：${row.visual_description}`)
  if (row.character_actions) lines.push(`角色动作：${row.character_actions}`)
  if (row.motion_prompts) lines.push(`运镜参考：${row.motion_prompts}`)
  if (row.lighting_atmosphere) lines.push(`光影：${row.lighting_atmosphere}`)
  if (row.emotion_mood) lines.push(`情绪：${row.emotion_mood}`)
  if (visualStyle) lines.push(`视觉风格锁定：${visualStyle}`)
  return [
    '请基于这张分镜板（director storyboard sheet）+ 下面的行字段，写出本镜头的镜头/光线/动作语言：',
    '',
    ...lines,
    '',
    '只输出 4-8 行中文，每行一句，不要标题、不要 JSON、不要 emoji。',
  ].join('\n')
}

/**
 * Read the keyframe image and produce a 4-8 line cinematography paragraph
 * (镜头 / 光线 / 动作). Wired into shoot() so the Seedance text prompt
 * carries explicit camera / lighting / motion language now that the
 * keyframe itself dropped those text labels in favor of pure storyboard
 * panels + diagrams.
 *
 * Failure handling: returns empty string. The shoot proceeds with just
 * dialogue + SFX in the text prompt and the keyframe as the image input —
 * worse than having the cinematography block, but still useful.
 */
async function describeKeyframeCinematography(opts: {
  keyframeUrl: string
  row: BeatVideoRow
  visualStyle?: string
}): Promise<string> {
  try {
    const r = await runCapability({
      capability: 'cinematography-describe',
      inputs: [
        { kind: 'text', text: buildCinematographyContext(opts.row, opts.visualStyle) },
        { kind: 'image', url: opts.keyframeUrl },
      ],
    })
    return (r.outputs[0]?.text ?? '').trim()
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[cinematographer-agent] cinematography-describe failed (${(e as Error).message}); falling back to dialogue/SFX-only prompt`)
    return ''
  }
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
  cinematography?: string
}): string {
  const dialogueAndSfx = buildMotionDescription(req)
  const legend = buildImageLegend(req.keyframeUrl)
  const cinematographyBlock = req.cinematography?.trim()
    ? `【镜头语言 / CINEMATOGRAPHY】（基于 @图片1 / image1 的分析）\n${req.cinematography.trim()}`
    : ''
  return fillTemplate(TPL.shoot, {
    imageLegend: legend,
    cinematographyBlock,
    dialogueAndSfx,
  }).trim()
}

async function callSeedance(opts: {
  prompt: string
  keyframeUrl: string
  voiceAudioUrls?: string[]
  durationSeconds: number
  aspect: '16:9' | '9:16' | '1:1' | '4:3'
  resolution: '480p' | '720p' | '1080p'
  invitedImageAssetIds?: string[]
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
      resolution: opts.resolution,
      // Hints to the capability plugin to use omni-reference mode if the
      // provider exposes it as a flag (Doubao Seedance 2.0 supports it).
      reference_mode: 'omni',
      // Privacy-block fallback: BytePlus digital-asset ids the caller
      // pre-registered. The capability plugin translates these to the
      // Seedance body's `invited_images` field.
      ...(opts.invitedImageAssetIds?.length
        ? { invitedImageAssetIds: opts.invitedImageAssetIds }
        : {}),
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
  const resolution = req.resolution ?? SHOOT_RESOLUTION_DEFAULT

  if (!req.keyframeUrl) {
    throw new Error(
      'cinematographer: shoot requires keyframeUrl (omni-reference mode needs the director keyframe as the single reference image). Generate the keyframe first.',
    )
  }

  yield {
    type: 'progress',
    message: `cinematographer: reading keyframe for cinematography language (shot ${shot})`,
  }
  const cinematography = await describeKeyframeCinematography({
    keyframeUrl: req.keyframeUrl,
    row: req.row,
    visualStyle: req.visualStyle,
  })
  if (cinematography) {
    yield {
      type: 'progress',
      message: `cinematographer: ${cinematography.split('\n').length}-line cinematography block ready`,
    }
  }

  yield {
    type: 'progress',
    message: `cinematographer: composing Seedance prompt for shot ${shot} (${durationSeconds}s, ${aspect}, ${resolution}, omni-reference)`,
  }

  const basePrompt = assembleShootPrompt({
    row: req.row,
    keyframeUrl: req.keyframeUrl,
    contextRefs: req.contextRefs,
    visualStyle: req.visualStyle,
    cinematography,
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
  const url = await callSeedance({
    prompt, keyframeUrl: req.keyframeUrl, voiceAudioUrls, durationSeconds, aspect, resolution,
    invitedImageAssetIds: req.invitedImageAssetIds,
  })

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
  const resolution = req.resolution ?? SHOOT_RESOLUTION_DEFAULT

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
  const url = await callSeedance({ prompt: revisedPrompt, keyframeUrl: req.keyframeUrl, durationSeconds, aspect, resolution })

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
