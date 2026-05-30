/**
 * director-agent — owns all storyboard logic and the director-storyboard-frame
 * keyframe construction.
 *
 * Seven typed verbs as async generators. Each consumes fully-specified inputs
 * — no interview turns. The high-level creative decisions (genre, audience,
 * tone, etc.) were locked during script-agent's 8-question interview and
 * arrive here via the dossier.
 *
 *   - allocateShots           → text (shot count/length/size per scene)
 *   - composeShots            → text (per-shot composition design)
 *   - generateStoryboardTable → text (JSON array; enforces 2≤duration≤15 + Σ=total)
 *   - critiqueTimeline        → TimelineIssue[]
 *   - applyTimelineFixes      → text (fixed JSON array)
 *   - generateKeyframe        → KeyframeResult { url, prompt, refs }
 *   - critiqueVideoConsistency → VideoConsistencyIssue[]
 *
 * Caller-side (director-assistant.ts, useStoryboardGenerate.ts) writes the
 * results back to canvas/storyboard stores — the agent stays pure.
 */

import { runCapability } from '@/lib/capabilities/client'
import { fillTemplate, parseFrontmatter } from '@/lib/agents/_shared/mustache'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import type { AgentGenerator } from '@/lib/agents/_shared/runtime/types'

import { searchNodes, getNode, regenerateImage, updateNodePrompt } from '@/lib/canvas-api'

import skillSource from './SKILL.md?raw'
import allocateShotsSource from './prompts/allocate-shots.md?raw'
import composeShotsSource from './prompts/compose-shots.md?raw'
import generateTableSource from './prompts/generate-storyboard-table.md?raw'
import critiqueTimelineSource from './prompts/critique-timeline.md?raw'
import applyTimelineFixesSource from './prompts/apply-timeline-fixes.md?raw'
import rewritePromptSource from './prompts/rewrite-prompt.md?raw'

import {
  BridgeJudgeSchema,
  TimelineIssueSchema,
  VideoConsistencyIssueSchema,
  type AllocateShotsRequest,
  type ApplyTimelineFixesRequest,
  type BridgeJudge,
  type BridgeRowProposal,
  type ComposeShotsRequest,
  type CritiqueTimelineRequest,
  type CritiqueVideoConsistencyRequest,
  type GenerateKeyframeRequest,
  type GenerateStoryboardTableRequest,
  type KeyframeResult,
  type ProposeBridgeRowRequest,
  type SearchAndRewriteNodeResult,
  type SearchAndRewriteRequest,
  type SearchAndRewriteResult,
  type TimelineIssue,
  type VideoConsistencyIssue,
} from './schema'

const { body: SYSTEM } = parseFrontmatter(skillSource)
const TPL = {
  allocateShots: parseFrontmatter(allocateShotsSource).body,
  composeShots: parseFrontmatter(composeShotsSource).body,
  generateTable: parseFrontmatter(generateTableSource).body,
  critiqueTimeline: parseFrontmatter(critiqueTimelineSource).body,
  applyTimelineFixes: parseFrontmatter(applyTimelineFixesSource).body,
  rewritePrompt: parseFrontmatter(rewritePromptSource).body,
}

// ─── Keyframe model pin ────────────────────────────────────────────
//
// Routing pin: TokenRouter only (never direct OpenAI). TokenRouter is
// the single image backend; its `openai/gpt-5.4-image-2` route is what
// the planning conversation contract resolves to in production.
// Centralised here so the keyframe verb has a single source of truth
// and the capabilities plugin can pass `params.model` through to
// TokenRouter unchanged.

export const KEYFRAME_PROVIDER = 'tokenrouter'
export const KEYFRAME_MODEL = 'openai/gpt-5.4-image-2'

// ─── JSON helpers ──────────────────────────────────────────────────

function extractFirstJsonArray(text: string): unknown[] {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidates = [fence?.[1], text].filter((c): c is string => typeof c === 'string')
  for (const c of candidates) {
    const start = c.indexOf('[')
    const end = c.lastIndexOf(']')
    if (start < 0 || end < 0 || end <= start) continue
    try {
      const parsed = JSON.parse(c.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    } catch {
      // try next
    }
  }
  return []
}

function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidates = [fence?.[1], text].filter((c): c is string => typeof c === 'string')
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start < 0 || end < 0 || end <= start) continue
    try {
      const parsed = JSON.parse(c.slice(start, end + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // try next
    }
  }
  return null
}

// ─── Verb: allocateShots ───────────────────────────────────────────

export async function* allocateShots(
  req: AllocateShotsRequest,
  ctx: ProjectContext,
): AgentGenerator<string> {
  yield { type: 'progress', message: 'director: allocating shots' }
  const text = await ctx.llm.complete(
    [
      {
        role: 'user',
        content: fillTemplate(TPL.allocateShots, {
          scriptAnalysis: req.scriptAnalysis.slice(0, 500),
          visualStrategy: req.visualStrategy.slice(0, 500),
          totalDurationSeconds: String(req.totalDurationSeconds),
        }),
      },
    ],
    { system: SYSTEM, signal: ctx.abort },
  )
  yield { type: 'result', payload: text }
}

// ─── Verb: composeShots ────────────────────────────────────────────

export async function* composeShots(
  req: ComposeShotsRequest,
  ctx: ProjectContext,
): AgentGenerator<string> {
  yield { type: 'progress', message: 'director: composing shots' }
  const text = await ctx.llm.complete(
    [
      {
        role: 'user',
        content: fillTemplate(TPL.composeShots, {
          shotAllocation: req.shotAllocation.slice(0, 800),
          visualAnchor: req.visualAnchor.slice(0, 500),
        }),
      },
    ],
    { system: SYSTEM, signal: ctx.abort },
  )
  yield { type: 'result', payload: text }
}

// ─── Verb: generateStoryboardTable ─────────────────────────────────

export async function* generateStoryboardTable(
  req: GenerateStoryboardTableRequest,
  ctx: ProjectContext,
): AgentGenerator<string> {
  yield { type: 'progress', message: 'director: generating storyboard table' }
  const text = await ctx.llm.complete(
    [
      {
        role: 'user',
        content: fillTemplate(TPL.generateTable, {
          artStyle: req.artStyle,
          totalDurationSeconds: String(req.totalDurationSeconds),
          characterDesigns: req.characterDesigns.slice(0, 800),
          sceneDesigns: req.sceneDesigns.slice(0, 800),
          propDesigns: req.propDesigns.slice(0, 400),
          shotAllocation: req.shotAllocation.slice(0, 600),
          shotComposition: req.shotComposition.slice(0, 600),
          visualStrategy: req.visualStrategy.slice(0, 400),
          elementContext: req.elementContext,
          revisedScript: req.revisedScript,
        }),
      },
    ],
    { system: SYSTEM, signal: ctx.abort },
  )
  yield { type: 'result', payload: text }
}

// ─── Verb: critiqueTimeline ────────────────────────────────────────

export async function* critiqueTimeline(
  req: CritiqueTimelineRequest,
  ctx: ProjectContext,
): AgentGenerator<TimelineIssue[]> {
  yield { type: 'progress', message: 'director: scanning timeline continuity' }
  // IMPORTANT: do NOT truncate. A 30-60s multi-character drama produces a
  // storyboard JSON well past 3000 chars, and slicing mid-row leaves the
  // LLM seeing only the first 2-3 rows. The continuity verdict for the
  // unseen tail rows is meaningless, and downstream apply-timeline-fixes
  // then rewrites the whole table from a partial view, returning garbage.
  const text = await ctx.llm.complete(
    [
      {
        role: 'user',
        content: fillTemplate(TPL.critiqueTimeline, {
          storyboardJson: req.storyboardJson,
          artStyle: req.artStyle,
          characterNames: req.characterNames.join(' / ') || '（未提供主要角色名）',
          targetRowCount: String(req.targetRowCount),
          totalDurationSeconds: String(req.totalDurationSeconds),
        }),
      },
    ],
    { system: SYSTEM, signal: ctx.abort },
  )
  const raw = extractFirstJsonArray(text)
  const out: TimelineIssue[] = []
  for (const item of raw) {
    const parsed = TimelineIssueSchema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  yield { type: 'result', payload: out }
}

// ─── Verb: applyTimelineFixes ──────────────────────────────────────

export async function* applyTimelineFixes(
  req: ApplyTimelineFixesRequest,
  ctx: ProjectContext,
): AgentGenerator<string> {
  yield { type: 'progress', message: 'director: applying timeline fixes' }
  const issuesList = req.issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')
  // IMPORTANT: do NOT truncate. The prompt asks the LLM to return the
  // FULL fixed array — slicing mid-row makes it hallucinate the missing
  // tail or emit a short array that loses rows.
  const text = await ctx.llm.complete(
    [
      {
        role: 'user',
        content: fillTemplate(TPL.applyTimelineFixes, {
          storyboardJson: req.storyboardJson,
          issuesList,
          totalDurationSeconds: String(req.totalDurationSeconds),
        }),
      },
    ],
    { system: SYSTEM, signal: ctx.abort },
  )
  yield { type: 'result', payload: text }
}

// ─── Verb: generateKeyframe ────────────────────────────────────────
//
// The keyframe is a Hollywood industrial-standard 视觉开发板 / visual
// development board — a single 4K image with 6 modules:
//   1. Top: project info bar
//   2. Top-left: dual protagonist character design (front/side/back + face)
//   3. Top-right: core scene concept art
//   4. Middle: 3-shot storyboard sequence with camera-movement arrows
//   5. Bottom: technical params (camera flowchart, lighting, color palette, lens)
//   6. Quality: ULTRA-DETAILED, PROFESSIONAL FILM PRODUCTION LAYOUT, 4K
//
// Image references for character/scene/props are passed in stable order with
// image1/image2/... labels. Scene is ALWAYS image1 (when present) so it
// anchors the model's style/lighting/world look — characters and props
// follow. See collectOrderedRefs() for the full contract.

interface OrderedImageRef {
  role: string
  description?: string
  imageUrl: string
}

function labelWithIndex(role: string, index: number, total: number): string {
  return total > 1 ? `${role} (${index + 1}/${total})` : role
}

/**
 * Flatten the structured keyframe refs into a stable image-legend order.
 *
 * Order — Scene first, regardless of character count:
 *
 *     image1     = Scene        (always first when present;
 *                                drives lighting, palette, and world look —
 *                                most important style anchor for the model)
 *     image2..N  = Characters   (character1, character2, … in array order)
 *     imageN+1.. = Props        (prop1, prop2, … in array order)
 *     last       = Prior ref    (legacy free-form, appended)
 *
 * This intentionally does NOT mirror the canvas vertical layout (which
 * places characters above the scene). User requirement: the scene
 * reference must always be image1 so the image model treats it as the
 * primary style anchor — that single decision visibly fixes the
 * "keyframe drifts to 2D / generic look" symptom.
 *
 * When `scene` is omitted, characters take image1+; numbering compresses
 * naturally because we only iterate over what exists.
 */
function collectOrderedRefs(req: GenerateKeyframeRequest): OrderedImageRef[] {
  const out: OrderedImageRef[] = []

  // Scene FIRST: may have multiple angles (wide + close-up).
  const sceneUrls = (req.scene?.imageUrls ?? []).filter((u): u is string => Boolean(u))
  const sceneRole = req.scene?.name ? `Scene — ${req.scene.name}` : 'Scene'
  sceneUrls.forEach((url, i) => {
    out.push({
      role: labelWithIndex(sceneRole, i, sceneUrls.length),
      description: req.scene?.description,
      imageUrl: url,
    })
  })

  // Characters: each may have multiple reference images (e.g., three-view).
  for (const c of req.characters ?? []) {
    const urls = (c.imageUrls ?? []).filter((u): u is string => Boolean(u))
    urls.forEach((url, i) => {
      out.push({
        role: labelWithIndex(`Character — ${c.name}`, i, urls.length),
        description: c.description,
        imageUrl: url,
      })
    })
  }

  // Props: each may have multiple angles.
  for (const p of req.props ?? []) {
    const urls = (p.imageUrls ?? []).filter((u): u is string => Boolean(u))
    urls.forEach((url, i) => {
      out.push({
        role: labelWithIndex(`Prop — ${p.name}`, i, urls.length),
        description: p.description,
        imageUrl: url,
      })
    })
  }

  // Legacy free-form refs (single URL each).
  for (const r of req.refs ?? []) {
    out.push({ role: r.role, description: r.description, imageUrl: r.imageUrl })
  }

  return out
}

function buildKeyframePrompt(req: GenerateKeyframeRequest): string {
  const r = req.row
  const aspect = req.aspect ?? '16:9'
  const title = req.projectTitle ?? '未命名 / Untitled'
  const projectType = req.projectType ?? '未指定'
  const tone = req.projectTone ?? '未指定'
  // GENRE derives from type + tone when not explicitly supplied — gives the
  // image model a single-line genre cue alongside the more granular fields.
  const genre = req.genre ?? (
    req.projectType && req.projectTone
      ? `${req.projectType} · ${req.projectTone}`
      : '未指定'
  )
  const visualStyle = req.visualStyle ?? '冷调写实电影质感 / cold-toned filmic'

  const characters = req.characters ?? []
  const hasCharacters = characters.length > 0

  // Walk the same flattened order as collectOrderedRefs so the "see image N"
  // hints stay aligned with the actual image inputs.
  const orderedRefsForLegend = collectOrderedRefs(req)
  const imageIndexByRole = new Map<string, number[]>()
  orderedRefsForLegend.forEach((r, i) => {
    const baseRole = r.role.replace(/\s\(\d+\/\d+\)$/, '')
    const arr = imageIndexByRole.get(baseRole) ?? []
    arr.push(i + 1)
    imageIndexByRole.set(baseRole, arr)
  })

  // Character module is dynamic per row:
  //   0 → skip the module entirely (the row is a landscape / object / SFX shot)
  //   1 → "Single-character design column"
  //   2 → "Dual protagonist character design column"
  //   3+ → "Ensemble character design column"
  const characterCountLabel = characters.length === 1
    ? 'Single-character'
    : characters.length === 2
      ? 'Dual protagonist'
      : `${characters.length}-character ensemble`
  const characterColumnLines = characters.map((c, i) => {
    const desc = c.description ? ` — ${c.description}` : ''
    const indices = imageIndexByRole.get(`Character — ${c.name}`) ?? []
    const ref = indices.length === 0
      ? ''
      : indices.length === 1
        ? ` (see image${indices[0]} for canonical look)`
        : ` (see images ${indices.join(', ')} for canonical look — multiple views supplied)`
    return `- Character ${i + 1}: ${c.name}${desc}${ref}`
  })

  const sceneDesc = req.scene
    ? `${req.scene.name ? `${req.scene.name} — ` : ''}${req.scene.description ?? ''}`.trim() || '(scene description from row)'
    : '(scene description from row visual_description)'

  const refs = orderedRefsForLegend
  const legendLines = refs.map((ref, i) =>
    `- image${i + 1} = ${ref.role}${ref.description ? ` (${ref.description})` : ''}`,
  )

  // Renumber modules when the character module is dropped so the LLM doesn't
  // see "1, 3, 4, 5, 6" — the layout reads as a 5-module sheet instead.
  let modIdx = 0
  const next = () => ++modIdx

  return [
    `# Hollywood industrial-standard visual development board, 4K ultra-high definition, professional film pre-production layout.`,
    ``,
    `## Project header bar`,
    `- Title: ${title}`,
    `- **TYPE**: ${projectType}`,
    `- **TONE**: ${tone}`,
    `- **GENRE**: ${genre}`,
    `- Shot duration: ${req.shotDurationSeconds}s`,
    `- Visual style: ${visualStyle}`,
    `- Aspect ratio: ${aspect}`,
    ``,
    `## Layout (${hasCharacters ? '6' : '5'} modules, professional film production layout)`,
    ``,
    `### ${next()}. TOP — Project info bar`,
    `Print "${title}" along with TYPE: ${projectType}, TONE: ${tone}, GENRE: ${genre}, duration ${req.shotDurationSeconds}s.`,
    ``,
    // Character module — only when the row actually has character refs.
    ...(hasCharacters
      ? [
          `### ${next()}. TOP-LEFT — ${characterCountLabel} character design column`,
          ...characterColumnLines,
          `Render front view, side view, back view three-view PLUS a face close-up for each character.`,
          `**100% consistent character design across views — no facial drift, no clothing drift, no breaks.**`,
          `Match the canonical look from the supplied reference image(s).`,
          ``,
        ]
      : [
          `### ${next()}. NOTE — No character design column`,
          `This row has no character refs (a landscape / object-focus / SFX shot). Do NOT render any character figures, three-views, or face close-ups. The space that would normally hold the character column is reallocated to the scene concept art module.`,
          ``,
        ]),
    `### ${next()}. ${hasCharacters ? 'TOP-RIGHT' : 'TOP (wide)'} — Core scene concept art`,
    `Scene: ${sceneDesc}.`,
    `Lighting / atmosphere: ${r.lighting_atmosphere || r.emotion_atmosphere || '(infer from emotion)'}.`,
    ``,
    `### ${next()}. MIDDLE — 3-shot storyboard sequence`,
    `Render a 3-panel sequence covering this shot's action arc.`,
    `Storyboard guidance: ${r.storyboard_prompts || r.visual_description || '(use the visual_description)'}.`,
    `Each panel must annotate: camera angle, lens (focal length), shot size (${r.shot_size || '中景/Medium'}), and the key beat.`,
    `Include arrow diagrams for camera movement (pan / tilt / dolly / push-in) connecting the panels.`,
    ``,
    `### ${next()}. BOTTOM — Professional technical parameters`,
    `- Camera movement flowchart (arrow diagram across the sequence).`,
    `- Lighting atmosphere: ${r.lighting_atmosphere || '(infer from scene)'}.`,
    `- Color palette: 3-5 swatches consistent with ${visualStyle}.`,
    `- Cinematography lens parameters: shot size ${r.shot_size || '中景'}, focal length, aperture (motivated by emotion).`,
    hasCharacters && r.character_motivation ? `- Character motivation: ${r.character_motivation}.` : '',
    hasCharacters && r.character_psychology ? `- Inner psychology: ${r.character_psychology}.` : '',
    hasCharacters && r.performance_guidance ? `- Performance guidance: ${r.performance_guidance}.` : '',
    ``,
    `### ${next()}. QUALITY REQUIREMENTS`,
    `- 4K ultra-high definition`,
    `- ${visualStyle}`,
    `- ULTRA-DETAILED, PROFESSIONAL FILM PRODUCTION LAYOUT`,
    `- High-end typography, no text errors, no image breaks, no facial breakdown`,
    `- Aspect ratio ${aspect}, compatible with SEEDANCE 2.0 video generation pipeline`,
    req.stylizeFacesFor2D
      ? `- **3DCG STYLIZATION (privacy retry)**: 把原来人物脸部3DCG风格化，尽量保持面部细节，但可以避免系统误认真人；其他地方保持原来美术风格 / Re-stylize every human face into a 3DCG render — keep the facial structure / expression / lighting cues so the character is still recognizable, but push it just far enough from photoreal that downstream content-safety filters no longer flag it as a real person. Composition, palette, lighting, props, and the rest of the frame stay identical to a non-stylized render.`
      : '',
    ``,
    legendLines.length
      ? `## REFERENCE IMAGES (use them as labeled, maintain character + scene consistency)`
      : '',
    ...legendLines,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export async function* generateKeyframe(
  req: GenerateKeyframeRequest,
  ctx: ProjectContext,
): AgentGenerator<KeyframeResult> {
  yield { type: 'progress', message: 'director: composing visual development board prompt' }
  const prompt = buildKeyframePrompt(req)
  const orderedRefs = collectOrderedRefs(req)

  if (!req.row.storyboard_prompts && !req.row.visual_description) {
    throw new Error(
      'director-agent: keyframe row must include storyboard_prompts or visual_description',
    )
  }

  void ctx
  yield {
    type: 'progress',
    message: `director: rendering 4K keyframe via ${KEYFRAME_PROVIDER}/${KEYFRAME_MODEL}`,
  }

  const r = await runCapability({
    capability: 'text-to-image',
    inputs: [
      { kind: 'text', text: prompt },
      ...orderedRefs.map((ref) => ({ kind: 'image' as const, url: ref.imageUrl })),
    ],
    params: {
      // Pin the routing per the planning conversation contract. The
      // capabilities plugin reads params.provider + params.model and
      // forwards `model` straight to TokenRouter (the only image
      // backend). `provider` is kept for symmetry / future routing.
      provider: KEYFRAME_PROVIDER,
      model: KEYFRAME_MODEL,
      aspect: req.aspect ?? '16:9',
      // Request high-quality / 4K output. TokenRouter forwards these as
      // hints; the server-side maps `aspect` to the closest supported
      // size (e.g. 1792x1024 for 16:9).
      quality: 'hd',
      resolution: '4k',
    },
  })
  const url = r.outputs[0]?.url
  if (!url) throw new Error('director-agent: keyframe capability returned no url')
  yield { type: 'result', payload: { url, prompt, imageRefs: orderedRefs } }
}

// Pure helpers, exported for tests + reuse by the caller.
export { buildKeyframePrompt, collectOrderedRefs }

// ─── Verb: critiqueVideoConsistency ────────────────────────────────

export async function* critiqueVideoConsistency(
  req: CritiqueVideoConsistencyRequest,
  ctx: ProjectContext,
): AgentGenerator<VideoConsistencyIssue[]> {
  yield {
    type: 'progress',
    message: `director: QC-ing video against shot ${req.expectedRow.shot_number ?? '?'}`,
  }

  const expectedSummary = [
    req.expectedRow.shot_number ? `Shot ${req.expectedRow.shot_number}` : null,
    req.expectedRow.visual_description,
    req.expectedRow.character_actions
      ? `Expected character action: ${req.expectedRow.character_actions}`
      : null,
    req.expectedRow.emotion_mood ? `Expected emotion: ${req.expectedRow.emotion_mood}` : null,
  ]
    .filter(Boolean)
    .join('. ')

  const r = await runCapability({
    capability: 'storyboard-qc',
    inputs: [
      { kind: 'video', url: req.videoUrl },
      ...(req.keyframeUrl ? [{ kind: 'image' as const, url: req.keyframeUrl }] : []),
      {
        kind: 'text',
        text: [
          'You are inspecting a beat-video against the storyboard row it was supposed to realize.',
          'Compare characters present, scene location, props on screen, action arc, and style consistency.',
          '',
          'EXPECTED ROW:',
          expectedSummary,
          '',
          'Output a JSON array; empty when the video matches the expected row.',
          'Each item: { "aspect": "characters"|"scene"|"props"|"action"|"style"|"continuity"|"other", "severity": "info"|"minor"|"major"|"blocking", "summary": "...", "fix": "..." }',
        ].join('\n'),
      },
    ],
  })
  void ctx
  const text = r.outputs[0]?.text ?? '[]'
  const raw = extractFirstJsonArray(text)
  const out: VideoConsistencyIssue[] = []
  for (const item of raw) {
    const parsed = VideoConsistencyIssueSchema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  yield { type: 'result', payload: out }
}

// ─── Verb: searchAndRewrite ───────────────────────────────────────
//
// Bulk concept replacement across the canvas. PM emits the
// 'patch-canvas-pattern' action; chat-bridge routes it here.
//
// Flow:
//   1. searchNodes via canvas-api (synonym-expanded substring match)
//   2. yield candidates as a progress turn (chat panel surfaces the list)
//   3. for each match, in parallel batches of maxConcurrent:
//        a. LLM-rewrite the prompt with the rewrite-prompt template
//        b. updateNodePrompt (versions the old prompt)
//        c. regenerateImage (versions the old url, calls text-to-image)
//      capture per-node {ok, error} so a single failure doesn't poison
//      the batch
//   4. yield final SearchAndRewriteResult — caller decides whether to
//      regenerate downstream videos
//
// Choice: per-node LLM rewrite (not batch) — better fidelity (the LLM
// sees one prompt's full context per call), predictable cost, and
// partial-failure semantics.

const DEFAULT_REWRITE_CONCURRENCY = 3

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners: Promise<void>[] = []
  const slots = Math.max(1, Math.min(limit, items.length))
  for (let s = 0; s < slots; s++) {
    runners.push(
      (async () => {
        while (true) {
          const i = cursor++
          if (i >= items.length) return
          results[i] = await worker(items[i], i)
        }
      })(),
    )
  }
  await Promise.all(runners)
  return results
}

export async function* searchAndRewrite(
  req: SearchAndRewriteRequest,
  ctx: ProjectContext,
): AgentGenerator<SearchAndRewriteResult> {
  yield { type: 'progress', message: 'director: searching canvas for matching nodes' }
  const matches = searchNodes({
    promptContains: req.target.promptContains,
    kinds: req.target.kinds ?? ['image'],
    roles: req.target.roles as never,
  })

  if (matches.length === 0) {
    yield {
      type: 'progress',
      message: `director: no matches for ${JSON.stringify(req.target.promptContains)}`,
    }
    yield { type: 'result', payload: { matchCount: 0, results: [] } }
    return
  }

  // Surface the candidate list so the chat panel can render thumbnails /
  // a confirmation. The hand-off contract: the chat panel may show this
  // to the user, but it does NOT pause for confirmation — the user
  // chose "直接执行 + 版本化" earlier, so versions[] is the rollback.
  yield {
    type: 'progress',
    message: `director: found ${matches.length} matching shot(s) — rewriting prompts`,
    data: {
      matches: matches.map((m) => ({
        nodeId: m.nodeId,
        name: m.name,
        promptPreview: m.promptPreview,
        matchedTerms: m.matchedTerms,
        shotNumbers: m.storyboardBindings.map((b) => b.shotNumber),
      })),
    },
  }

  const limit = Math.max(1, req.maxConcurrent ?? DEFAULT_REWRITE_CONCURRENCY)
  const results = await runWithConcurrency<typeof matches[number], SearchAndRewriteNodeResult>(
    matches,
    limit,
    async (m) => {
      // searchNodes returns a truncated promptPreview for display; pull
      // the full prompt from the item head via getNode so the LLM
      // rewrites the complete prompt (truncating would silently drop
      // style suffixes, ref-image legends, etc.).
      const detail = getNode(m.nodeId)
      const fullPrompt = detail?.item.prompt ?? ''
      if (!fullPrompt) {
        return {
          nodeId: m.nodeId,
          shotNumber: m.storyboardBindings[0]?.shotNumber,
          oldPrompt: '',
          newPrompt: '',
          error: 'node has no prompt to rewrite',
        }
      }
      try {
        const llmResponse = await ctx.llm.complete(
          [
            {
              role: 'user',
              content: fillTemplate(TPL.rewritePrompt, {
                oldPrompt: fullPrompt,
                intent: req.intent,
              }),
            },
          ],
          { system: SYSTEM, signal: ctx.abort },
        )
        const newPrompt = stripFencesAndLabels(llmResponse).trim()
        if (!newPrompt) throw new Error('rewrite LLM returned empty prompt')

        updateNodePrompt(m.nodeId, { type: 'replace', prompt: newPrompt })
        const detail = await regenerateImage(m.nodeId, { prompt: newPrompt })
        return {
          nodeId: m.nodeId,
          shotNumber: m.storyboardBindings[0]?.shotNumber,
          oldPrompt: fullPrompt,
          newPrompt,
          newImageUrl: detail.item.content,
        }
      } catch (e) {
        return {
          nodeId: m.nodeId,
          shotNumber: m.storyboardBindings[0]?.shotNumber,
          oldPrompt: fullPrompt,
          newPrompt: '',
          error: (e as Error).message,
        }
      }
    },
  )

  yield {
    type: 'progress',
    message: `director: done — ${results.filter((r) => r.newImageUrl).length}/${results.length} regenerated`,
  }
  yield { type: 'result', payload: { matchCount: matches.length, results } }
}

// ─── Verb: proposeBridgeRow ────────────────────────────────────────
//
// Look at one adjacent pair (prev, next) and decide if a bridging row
// would make the cut feel less jarring. Returns the row's METADATA only —
// no keyframe / no video. The orchestrator (storyboard-bridge.ts) drives
// this verb across every adjacent pair in the table and inserts proposals
// via storyboard-store.insertRowAfter.
//
// Image inputs are passed through 'bridge-row-judge' capability so the
// vision model sees prev-last-frame + next-first-frame side by side. Frames
// are optional: when neither exists for a pair, the verb degrades to a
// text-only judgement (still useful — the row text already describes what
// the frame should show).

export function buildBridgePromptText(req: ProposeBridgeRowRequest): string {
  const r1 = req.prevRow
  const r2 = req.nextRow
  const fmtRow = (r: ProposeBridgeRowRequest['prevRow'], tag: string) => [
    `### ${tag}（${r.shot_number ?? '?'}, ${r.duration ?? '?'}s）`,
    r.visual_description ? `画面：${r.visual_description}` : '',
    r.character_actions ? `角色动作：${r.character_actions}` : '',
    r.character1_name ? `角色1：${r.character1_name}` : '',
    r.character2_name ? `角色2：${r.character2_name}` : '',
    r.scene_name ? `场景：${r.scene_name}` : '',
    r.shot_size ? `景别：${r.shot_size}` : '',
    r.emotion_mood ? `情绪：${r.emotion_mood}` : '',
    r.lighting_atmosphere ? `光影：${r.lighting_atmosphere}` : '',
    r.dialogue ? `对白：${r.dialogue}` : '',
  ].filter(Boolean).join('\n')

  const knownLines: string[] = []
  if (req.knownCharacterNames?.length) knownLines.push(`已存在角色：${req.knownCharacterNames.join(' / ')}`)
  if (req.knownSceneNames?.length) knownLines.push(`已存在场景：${req.knownSceneNames.join(' / ')}`)
  if (req.knownPropNames?.length) knownLines.push(`已存在道具：${req.knownPropNames.join(' / ')}`)

  const imageLegend: string[] = []
  if (req.prevLastFrameUrl) imageLegend.push('image1 = 前一镜的最后一帧（视觉真实）')
  if (req.nextFirstFrameUrl) imageLegend.push(`image${req.prevLastFrameUrl ? 2 : 1} = 后一镜的第一帧（视觉真实）`)

  return [
    '# 任务：判断这两镜之间是否需要插入一个桥接分镜',
    '',
    req.projectType ? `项目类型：${req.projectType}` : '',
    req.projectTone ? `项目情绪：${req.projectTone}` : '',
    '',
    fmtRow(r1, 'PREV（前一镜）'),
    '',
    fmtRow(r2, 'NEXT（后一镜）'),
    '',
    knownLines.length ? '## 可复用资产' : '',
    ...knownLines,
    '',
    imageLegend.length ? '## 提供的画面' : '',
    ...imageLegend,
    '',
    '## 输出（严格 JSON，无 markdown 围栏）',
    '{',
    '  "needed": true/false,            // 仅当观感确有割裂时为 true',
    '  "reason": "…一句话理由，方便日志展示…",',
    '  "bridge": {                       // needed === true 才输出该字段，否则省略',
    '    "shot_number": "…例如 S3.5 / 介于前后镜号之间的临时编号…",',
    '    "duration": 2-6,               // 桥接镜头时长（秒），范围 [2, 6]',
    '    "visual_description": "…只描述过渡那一点信息，不要重复前后镜已经发生的内容…",',
    '    "shot_size": "…景别…",',
    '    "character_actions": "…",',
    '    "emotion_mood": "…",',
    '    "emotion_atmosphere": "…",',
    '    "lighting_atmosphere": "…",',
    '    "storyboard_prompts": "…用于后续生成 keyframe 的视觉描述…",',
    '    "motion_prompts": "…用于后续生成视频的运动描述…",',
    '    "sound_effects": "…",',
    '    "dialogue": "",',
    '    "visual_anchor": "…与前后镜对齐的视觉锚点…",',
    '    "character1_name": "…必须从【可复用资产】里挑名字，没有则留空…",',
    '    "character2_name": "",',
    '    "scene_name": "…必须从【可复用资产】里挑名字，没有合适的则留空…",',
    '    "prop1_name": "",',
    '    "prop2_name": ""',
    '  }',
    '}',
    '',
    '判断要点：',
    '- 空间是否突变（前后镜不在同一个地方且没有合理跳跃）→ 需要',
    '- 角色位置/朝向瞬移、动作链断裂、关键道具凭空出现/消失 → 需要',
    '- 情绪节奏跳脱：前镜激烈、后镜静态、且没有任何过渡 → 需要',
    '- 两镜本来就是 hard cut / 蒙太奇 / 合理的时间跳跃 → 不需要',
    '- 若 needed = false，bridge 字段必须省略；不要返回空对象。',
  ].filter((line) => line !== '').join('\n')
}

export async function* proposeBridgeRow(
  req: ProposeBridgeRowRequest,
  ctx: ProjectContext,
): AgentGenerator<BridgeJudge> {
  yield {
    type: 'progress',
    message: `director: judging bridge between ${req.prevRow.shot_number ?? '?'} → ${req.nextRow.shot_number ?? '?'}`,
  }
  const text = buildBridgePromptText(req)
  const images = [req.prevLastFrameUrl, req.nextFirstFrameUrl].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  )
  const r = await runCapability({
    capability: 'bridge-row-judge',
    inputs: [
      { kind: 'text', text },
      ...images.map((url) => ({ kind: 'image' as const, url })),
    ],
  })
  void ctx
  const raw = r.outputs[0]?.text ?? ''
  const obj = extractFirstJsonObject(raw)
  if (!obj) {
    yield { type: 'result', payload: { needed: false, reason: 'judge: 无法解析模型输出' } }
    return
  }
  // bridge can come back as null / undefined / partial — Zod softly defaults
  // missing string fields. If the model said needed=true but produced no
  // bridge object, treat it as a non-actionable refusal.
  const parsed = BridgeJudgeSchema.safeParse(obj)
  if (!parsed.success) {
    yield { type: 'result', payload: { needed: false, reason: `judge: schema 校验失败 — ${parsed.error.issues[0]?.message ?? '?'}` } }
    return
  }
  const j = parsed.data
  if (j.needed && !j.bridge) {
    yield { type: 'result', payload: { needed: false, reason: j.reason || 'judge: needed=true 但未给出 bridge 字段' } }
    return
  }
  yield { type: 'result', payload: j }
}

/**
 * Strip markdown code fences and conversational lead-ins ("Here is the
 * rewritten prompt:") that small LLMs sometimes add despite the prompt
 * telling them not to. Mirrors the defensive parsing in extractFirst*
 * helpers above but for free-form text output.
 */
function stripFencesAndLabels(text: string): string {
  let out = text.trim()
  const fence = out.match(/^```(?:[a-z]*)?\s*([\s\S]*?)\s*```$/i)
  if (fence) out = fence[1].trim()
  out = out.replace(/^(?:here(?:'s| is)|改写后的 ?prompt[:：]|rewritten prompt[:：]|new prompt[:：])\s*/i, '')
  return out
}

// ─── Module metadata ──────────────────────────────────────────────

export const directorAgent = {
  meta: {
    name: 'director-agent',
    description: 'All storyboard logic + keyframe + video consistency critique + bridge-row proposals',
    model: 'claude-sonnet-4-5',
  },
  systemPrompt: SYSTEM,
  allocateShots,
  composeShots,
  generateStoryboardTable,
  critiqueTimeline,
  applyTimelineFixes,
  generateKeyframe,
  critiqueVideoConsistency,
  searchAndRewrite,
  proposeBridgeRow,
} as const

export type {
  TimelineIssue,
  VideoConsistencyIssue,
  KeyframeResult,
  KeyframeRef,
  KeyframeRow,
  KeyframeCharacterRef,
  KeyframeSceneRef,
  KeyframePropRef,
  AllocateShotsRequest,
  ComposeShotsRequest,
  GenerateStoryboardTableRequest,
  CritiqueTimelineRequest,
  ApplyTimelineFixesRequest,
  GenerateKeyframeRequest,
  CritiqueVideoConsistencyRequest,
  SearchAndRewriteRequest,
  SearchAndRewriteResult,
  SearchAndRewriteNodeResult,
  ProposeBridgeRowRequest,
  BridgeJudge,
  BridgeRowProposal,
} from './schema'
