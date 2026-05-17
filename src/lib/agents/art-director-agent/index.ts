/**
 * art-director-agent — owns the visual production pack.
 *
 * Exposes four typed verbs as async generators. Each verb consumes
 * fully-specified inputs (no interview turns) and yields progress + result.
 *
 *   - extractElements        → character / scene / prop sheets
 *   - generateAssetImages    → fills img_url on each element via text-to-image
 *   - generateStyleBible     → visual anchor + visual strategy
 *   - critiqueComposition    → CompositionIssue[] for a storyboard JSON
 *
 * Callers drive verbs the same way they drive script-agent — via
 * `drive()` / `driveAuto()` — so the runtime contract is uniform across agents.
 */

import { z } from 'zod'

import { runCapability } from '@/lib/capabilities/client'
import { fillTemplate, parseFrontmatter } from '@/lib/agents/_shared/mustache'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import type { AgentGenerator } from '@/lib/agents/_shared/runtime/types'

import skillSource from './SKILL.md?raw'
import extractCharactersSource from './prompts/extract-characters.md?raw'
import extractScenesSource from './prompts/extract-scenes.md?raw'
import extractPropsSource from './prompts/extract-props.md?raw'
import visualAnchorSource from './prompts/visual-anchor.md?raw'
import visualStrategySource from './prompts/visual-strategy.md?raw'
import critiqueCompositionSource from './prompts/critique-composition.md?raw'
import characterImageSource from './prompts/character-image.md?raw'
import sceneImageSource from './prompts/scene-image.md?raw'
import propImageSource from './prompts/prop-image.md?raw'

import {
  CompositionIssueSchema,
  ExtractedCharacterSchema,
  ExtractedPropSchema,
  ExtractedSceneSchema,
  StyleBibleSchema,
  type CompositionIssue,
  type CritiqueCompositionRequest,
  type ExtractElementsRequest,
  type ExtractionResult,
  type ExtractedCharacter,
  type ExtractedProp,
  type ExtractedScene,
  type GenerateAssetImagesRequest,
  type GenerateStyleBibleRequest,
  type StyleBible,
} from './schema'

const { body: SYSTEM } = parseFrontmatter(skillSource)
const TPL = {
  extractCharacters: parseFrontmatter(extractCharactersSource).body,
  extractScenes: parseFrontmatter(extractScenesSource).body,
  extractProps: parseFrontmatter(extractPropsSource).body,
  visualAnchor: parseFrontmatter(visualAnchorSource).body,
  visualStrategy: parseFrontmatter(visualStrategySource).body,
  critiqueComposition: parseFrontmatter(critiqueCompositionSource).body,
  characterImage: parseFrontmatter(characterImageSource).body,
  sceneImage: parseFrontmatter(sceneImageSource).body,
  propImage: parseFrontmatter(propImageSource).body,
}

// ─── JSON helpers ───────────────────────────────────────────────────

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
      // try next candidate
    }
  }
  return []
}

function parseArrayWith<T>(text: string, schema: z.ZodType<T>): T[] {
  const raw = extractFirstJsonArray(text)
  const out: T[] = []
  for (const item of raw) {
    const parsed = schema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
    // Silent skip on bad items — extraction is best-effort; downstream
    // pipelines tolerate empty arrays better than they tolerate throws.
  }
  return out
}

// ─── Verb: extractElements ──────────────────────────────────────────

export async function* extractElements(
  req: ExtractElementsRequest,
  ctx: ProjectContext,
): AgentGenerator<ExtractionResult> {
  const vars = { scriptAnalysis: req.scriptAnalysis, artStyle: req.artStyle }

  yield { type: 'progress', message: 'art-director: extracting characters' }
  const charText = await ctx.llm.complete(
    [{ role: 'user', content: fillTemplate(TPL.extractCharacters, vars) }],
    { system: SYSTEM, signal: ctx.abort },
  )
  const characters = parseArrayWith(charText, ExtractedCharacterSchema)

  yield { type: 'progress', message: 'art-director: extracting scenes' }
  const sceneText = await ctx.llm.complete(
    [{ role: 'user', content: fillTemplate(TPL.extractScenes, vars) }],
    { system: SYSTEM, signal: ctx.abort },
  )
  const scenes = parseArrayWith(sceneText, ExtractedSceneSchema)

  yield { type: 'progress', message: 'art-director: extracting props' }
  const propText = await ctx.llm.complete(
    [{ role: 'user', content: fillTemplate(TPL.extractProps, vars) }],
    { system: SYSTEM, signal: ctx.abort },
  )
  const props = parseArrayWith(propText, ExtractedPropSchema)

  yield { type: 'result', payload: { characters, scenes, props } }
}

// ─── Verb: generateAssetImages ──────────────────────────────────────

export interface AssetImageContext {
  artStyle: string
  template: string
  buildDescription: (e: ExtractedCharacter | ExtractedScene | ExtractedProp) => string
  /** Aspect ratio. Scenes use '16:9' for canvas display but the underlying
   *  panorama is rendered as a 2:1 equirectangular by the prompt body. */
  aspect: '1:1' | '16:9'
  /** Extra capability params (e.g., quality / resolution) for this asset kind. */
  extraParams?: Record<string, unknown>
}

/**
 * Templates each kind uses + the per-kind timeout. Exported so callers that
 * want to fire individual image generations (e.g. canvas-elements running
 * them in parallel as a background task) can reuse the agent's authoritative
 * prompts + deadlines instead of duplicating them.
 */
export function characterImageContext(artStyle: string): AssetImageContext {
  return {
    artStyle,
    template: TPL.characterImage,
    buildDescription: (e) => {
      const c = e as ExtractedCharacter
      return `${c.name}, ${c.gender}, ${c.appearance}, wearing ${c.clothing}, ${c.expression}`
    },
    aspect: '1:1',
  }
}
export function sceneImageContext(artStyle: string): AssetImageContext {
  return {
    artStyle,
    template: TPL.sceneImage,
    buildDescription: (e) => {
      const s = e as ExtractedScene
      return `${s.name}, ${s.location}, ${s.lighting}, ${s.mood}`
    },
    aspect: '16:9',
    extraParams: { quality: 'hd', resolution: '4k' },
  }
}
export function propImageContext(artStyle: string): AssetImageContext {
  return {
    artStyle,
    template: TPL.propImage,
    buildDescription: (e) => {
      const p = e as ExtractedProp
      return `${p.name}, ${p.description}`
    },
    aspect: '1:1',
  }
}

// Per-asset deadlines. runCapability has no built-in timeout, so a hung
// provider would otherwise freeze the entire director pipeline (no way
// to ever recover without a page reload). Generous enough for slow
// remote image models on a cold start; aggressive enough to fail-and-
// move-on instead of waiting forever.
export const ASSET_TIMEOUT_MS = {
  character: 3 * 60_000,
  prop: 3 * 60_000,
  // 4K HD equirectangular panoramas can legitimately take 90-150s on
  // gpt-image-2; give them more headroom but still cap the wait.
  scene: 6 * 60_000,
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — provider hung; moving on`)),
        ms,
      ),
    ),
  ])
}

export async function generateOneImage(
  element: ExtractedCharacter | ExtractedScene | ExtractedProp,
  imgCtx: AssetImageContext,
  ctx: ProjectContext,
  timeoutMs: number,
): Promise<{ url: string | undefined; prompt: string }> {
  // ALWAYS run the template. The earlier `image_prompt ? raw : template`
  // short-circuit meant the LLM-built image_prompt bypassed every
  // template directive (360° + NO HUMANS + turnaround + no-face). With
  // the extractor always producing a non-empty image_prompt, the
  // templates were dead code on every real run. Now the extracted prompt
  // feeds into the template's *Description slot and the template wraps
  // it with the kind-specific composition + negative directives.
  const description = element.image_prompt && element.image_prompt.trim().length > 0
    ? element.image_prompt
    : imgCtx.buildDescription(element)
  const prompt = fillTemplate(imgCtx.template, {
    characterDescription: description,
    sceneDescription: description,
    propDescription: description,
    artStyle: imgCtx.artStyle,
  })
  void ctx
  const label = `art-director text-to-image (${element.name})`
  const r = await withTimeout(
    runCapability({
      capability: 'text-to-image',
      inputs: [{ kind: 'text', text: prompt }],
      params: { aspect: imgCtx.aspect, ...(imgCtx.extraParams ?? {}) },
    }),
    timeoutMs,
    label,
  )
  return { url: r.outputs[0]?.url, prompt }
}

export async function* generateAssetImages(
  req: GenerateAssetImagesRequest,
  ctx: ProjectContext,
): AgentGenerator<ExtractionResult> {
  const skipIfDone = req.skipIfAlreadyGenerated ?? true
  const out: ExtractionResult = {
    characters: req.extraction.characters.map((c) => ({ ...c })),
    scenes: req.extraction.scenes.map((s) => ({ ...s })),
    props: req.extraction.props.map((p) => ({ ...p })),
  }

  const cap = req.maxPerKind ?? {}
  const charLimit = cap.characters ?? out.characters.length
  const sceneLimit = cap.scenes ?? out.scenes.length
  const propLimit = cap.props ?? out.props.length

  for (let i = 0; i < Math.min(out.characters.length, charLimit); i++) {
    const ch = out.characters[i]!
    if (skipIfDone && ch.img_url) continue
    yield { type: 'progress', message: `art-director: generating character image ${ch.name}` }
    try {
      const { url, prompt } = await generateOneImage(
        ch,
        {
          artStyle: req.artStyle,
          template: TPL.characterImage,
          buildDescription: (e) => {
            const c = e as ExtractedCharacter
            return `${c.name}, ${c.gender}, ${c.appearance}, wearing ${c.clothing}, ${c.expression}`
          },
          aspect: '1:1',
        },
        ctx,
        ASSET_TIMEOUT_MS.character,
      )
      ch.img_url = url
      ch.generation_prompt = prompt
      yield { type: 'progress', message: `art-director: ✓ character ${ch.name} ready` }
    } catch (e) {
      const msg = (e as Error).message
      ctx.log(`art-director: ✗ character ${ch.name} image failed: ${msg}`)
      yield { type: 'progress', message: `art-director: ✗ character ${ch.name} failed — ${msg}` }
    }
  }

  for (let i = 0; i < Math.min(out.scenes.length, sceneLimit); i++) {
    const sc = out.scenes[i]!
    if (skipIfDone && sc.img_url) continue
    yield {
      type: 'progress',
      message: `art-director: generating 360° 4K panorama for scene ${sc.name}`,
    }
    try {
      const { url, prompt } = await generateOneImage(
        sc,
        {
          artStyle: req.artStyle,
          template: TPL.sceneImage,
          buildDescription: (e) => {
            const s = e as ExtractedScene
            return `${s.name}, ${s.location}, ${s.lighting}, ${s.mood}`
          },
          aspect: '16:9',
          // Scene panoramas request 4K + HD quality. The scene-image.md template
          // instructs the model to render as a 2:1 equirectangular wrap; the
          // canvas <PanoramaViewer> reads it as a draggable 360° image.
          extraParams: { quality: 'hd', resolution: '4k' },
        },
        ctx,
        ASSET_TIMEOUT_MS.scene,
      )
      sc.img_url = url
      sc.generation_prompt = prompt
      yield { type: 'progress', message: `art-director: ✓ scene ${sc.name} panorama ready` }
    } catch (e) {
      const msg = (e as Error).message
      ctx.log(`art-director: ✗ scene ${sc.name} panorama failed: ${msg}`)
      yield { type: 'progress', message: `art-director: ✗ scene ${sc.name} failed — ${msg}` }
    }
  }

  for (let i = 0; i < Math.min(out.props.length, propLimit); i++) {
    const pr = out.props[i]!
    if (skipIfDone && pr.img_url) continue
    yield { type: 'progress', message: `art-director: generating prop image ${pr.name}` }
    try {
      const { url, prompt } = await generateOneImage(
        pr,
        {
          artStyle: req.artStyle,
          template: TPL.propImage,
          buildDescription: (e) => {
            const p = e as ExtractedProp
            return `${p.name}, ${p.description}`
          },
          aspect: '1:1',
        },
        ctx,
        ASSET_TIMEOUT_MS.prop,
      )
      pr.img_url = url
      pr.generation_prompt = prompt
      yield { type: 'progress', message: `art-director: ✓ prop ${pr.name} ready` }
    } catch (e) {
      const msg = (e as Error).message
      ctx.log(`art-director: ✗ prop ${pr.name} image failed: ${msg}`)
      yield { type: 'progress', message: `art-director: ✗ prop ${pr.name} failed — ${msg}` }
    }
  }

  yield { type: 'result', payload: out }
}

// ─── Verb: generateStyleBible ───────────────────────────────────────

export async function* generateStyleBible(
  req: GenerateStyleBibleRequest,
  ctx: ProjectContext,
): AgentGenerator<StyleBible> {
  yield { type: 'progress', message: 'art-director: extracting visual anchor' }
  const anchor = await ctx.llm.complete(
    [{
      role: 'user',
      content: fillTemplate(TPL.visualAnchor, {
        scriptAnalysis: req.scriptAnalysis,
        characterDesigns: req.characterDesigns,
        sceneDesigns: req.sceneDesigns,
        elementContext: req.elementContext,
      }),
    }],
    { system: SYSTEM, signal: ctx.abort },
  )

  yield { type: 'progress', message: 'art-director: deriving visual strategy' }
  const strategy = await ctx.llm.complete(
    [{
      role: 'user',
      content: fillTemplate(TPL.visualStrategy, {
        artStyle: req.artStyle,
        stylePreset: req.stylePreset,
        scriptAnalysis: req.scriptAnalysis.slice(0, 500),
        visualAnchor: anchor.slice(0, 500),
      }),
    }],
    { system: SYSTEM, signal: ctx.abort },
  )

  const bible = StyleBibleSchema.parse({ anchor, strategy })
  yield { type: 'result', payload: bible }
}

// ─── Verb: critiqueComposition ──────────────────────────────────────

export async function* critiqueComposition(
  req: CritiqueCompositionRequest,
  ctx: ProjectContext,
): AgentGenerator<CompositionIssue[]> {
  yield { type: 'progress', message: 'art-director: scanning storyboard composition' }
  const text = await ctx.llm.complete(
    [{
      role: 'user',
      content: fillTemplate(TPL.critiqueComposition, {
        storyboardJson: req.storyboardJson.slice(0, 3000),
      }),
    }],
    { system: SYSTEM, signal: ctx.abort },
  )
  const issues = parseArrayWith(text, CompositionIssueSchema)
  yield { type: 'result', payload: issues }
}

// ─── Module metadata ────────────────────────────────────────────────

export const artDirectorAgent = {
  meta: {
    name: 'art-director-agent',
    description: 'Visual production pack — extract, generate, style bible, critique',
    model: 'claude-sonnet-4-5',
  },
  systemPrompt: SYSTEM,
  extractElements,
  generateAssetImages,
  generateStyleBible,
  critiqueComposition,
} as const

export type {
  CompositionIssue,
  ExtractedCharacter,
  ExtractedProp,
  ExtractedScene,
  ExtractionResult,
  StyleBible,
} from './schema'
