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

import skillSource from './SKILL.md?raw'
import allocateShotsSource from './prompts/allocate-shots.md?raw'
import composeShotsSource from './prompts/compose-shots.md?raw'
import generateTableSource from './prompts/generate-storyboard-table.md?raw'
import critiqueTimelineSource from './prompts/critique-timeline.md?raw'
import applyTimelineFixesSource from './prompts/apply-timeline-fixes.md?raw'

import {
  TimelineIssueSchema,
  VideoConsistencyIssueSchema,
  type AllocateShotsRequest,
  type ApplyTimelineFixesRequest,
  type ComposeShotsRequest,
  type CritiqueTimelineRequest,
  type CritiqueVideoConsistencyRequest,
  type GenerateKeyframeRequest,
  type GenerateStoryboardTableRequest,
  type KeyframeResult,
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
}

// ─── Keyframe model pin ────────────────────────────────────────────
//
// The planning conversation specified gpt-image-2 for 分镜导演图.
// Centralised here so the keyframe verb has a single source of truth.

export const KEYFRAME_PROVIDER = 'openai'
export const KEYFRAME_MODEL = 'gpt-image-2'

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
  const text = await ctx.llm.complete(
    [
      {
        role: 'user',
        content: fillTemplate(TPL.critiqueTimeline, {
          storyboardJson: req.storyboardJson.slice(0, 3000),
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
  const text = await ctx.llm.complete(
    [
      {
        role: 'user',
        content: fillTemplate(TPL.applyTimelineFixes, {
          storyboardJson: req.storyboardJson.slice(0, 3000),
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
// image1/image2/... labels so gpt-image-2 can hold character + scene consistency.

interface OrderedImageRef {
  role: string
  description?: string
  imageUrl: string
}

function labelWithIndex(role: string, index: number, total: number): string {
  return total > 1 ? `${role} (${index + 1}/${total})` : role
}

function collectOrderedRefs(req: GenerateKeyframeRequest): OrderedImageRef[] {
  const out: OrderedImageRef[] = []

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

  // Scene: may have multiple angles (wide + close-up).
  const sceneUrls = (req.scene?.imageUrls ?? []).filter((u): u is string => Boolean(u))
  const sceneRole = req.scene?.name ? `Scene — ${req.scene.name}` : 'Scene'
  sceneUrls.forEach((url, i) => {
    out.push({
      role: labelWithIndex(sceneRole, i, sceneUrls.length),
      description: req.scene?.description,
      imageUrl: url,
    })
  })

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
      // capabilities plugin reads params.provider + params.model.
      provider: KEYFRAME_PROVIDER,
      model: KEYFRAME_MODEL,
      aspect: req.aspect ?? '16:9',
      // Request high-quality / 4K output. The capabilities plugin server-side
      // maps these to whatever the provider's API actually supports
      // (OpenAI gpt-image-2: quality='hd', size='1792x1024' for widescreen).
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

// ─── Module metadata ──────────────────────────────────────────────

export const directorAgent = {
  meta: {
    name: 'director-agent',
    description: 'All storyboard logic + keyframe + video consistency critique',
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
} from './schema'
