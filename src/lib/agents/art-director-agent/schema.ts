import { z } from 'zod'

/**
 * Output shapes for art-director-agent's four verbs.
 *
 * The Extracted* shapes mirror the legacy types in src/lib/canvas-elements.ts
 * (which the agent will eventually replace as the source of truth). Each
 * element carries optional `img_url` and `generation_prompt` so the
 * generateAssetImages verb can return the same shape with those fields
 * populated.
 */

const optionalUrl = z.string().optional()
const optionalText = z.string().optional()

export const ExtractedCharacterSchema = z.object({
  name: z.string(),
  gender: z.string().default(''),
  age: z.string().optional(),
  appearance: z.string().default(''),
  clothing: z.string().default(''),
  expression: z.string().default(''),
  body_type: z.string().optional(),
  distinctive_features: z.string().optional(),
  image_prompt: z.string().default(''),
  img_url: optionalUrl,
  generation_prompt: optionalText,
})

export const ExtractedSceneSchema = z.object({
  name: z.string(),
  location: z.string().default(''),
  time_of_day: z.string().optional(),
  weather: z.string().optional(),
  architecture: z.string().optional(),
  lighting: z.string().default(''),
  color_palette: z.string().optional(),
  mood: z.string().default(''),
  key_props: z.string().optional(),
  image_prompt: z.string().default(''),
  img_url: optionalUrl,
  generation_prompt: optionalText,
})

export const ExtractedPropSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  material: z.string().optional(),
  significance: z.string().optional(),
  image_prompt: z.string().default(''),
  img_url: optionalUrl,
  generation_prompt: optionalText,
})

export const ExtractionResultSchema = z.object({
  characters: z.array(ExtractedCharacterSchema).default([]),
  scenes: z.array(ExtractedSceneSchema).default([]),
  props: z.array(ExtractedPropSchema).default([]),
})

export type ExtractedCharacter = z.infer<typeof ExtractedCharacterSchema>
export type ExtractedScene = z.infer<typeof ExtractedSceneSchema>
export type ExtractedProp = z.infer<typeof ExtractedPropSchema>
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>

/**
 * Style bible — visual anchor (per-scene/character consistency) and visual
 * strategy (color, lensing, lighting, composition rules). Both are free-form
 * text the LLM produces; downstream agents (director, cinematographer) read
 * them as prose context, not as structured data.
 */
export const StyleBibleSchema = z.object({
  anchor: z.string().default(''),
  strategy: z.string().default(''),
})
export type StyleBible = z.infer<typeof StyleBibleSchema>

/**
 * Composition issue surfaced by critiqueComposition. Same shape as the legacy
 * visualBalanceCheck output so director-assistant.ts's issue-aggregation path
 * is a drop-in.
 */
export const CompositionIssueSchema = z.object({
  shot: z.string(),
  issue: z.string(),
  fix: z.string(),
})
export type CompositionIssue = z.infer<typeof CompositionIssueSchema>

// ─── Request shapes ────────────────────────────────────────────────

export interface ExtractElementsRequest {
  scriptAnalysis: string
  artStyle: string
}

export interface GenerateAssetImagesRequest {
  /** Pre-extracted elements (typically from a prior extractElements call). */
  extraction: ExtractionResult
  /** Art style passed through to image prompt construction. */
  artStyle: string
  /** Optional cap on how many elements of each kind to generate (default: all). */
  maxPerKind?: { characters?: number; scenes?: number; props?: number }
  /** When true, skip elements that already have an img_url. Default true. */
  skipIfAlreadyGenerated?: boolean
}

export interface GenerateStyleBibleRequest {
  scriptAnalysis: string
  artStyle: string
  stylePreset: string
  characterDesigns: string
  sceneDesigns: string
  elementContext: string
}

export interface CritiqueCompositionRequest {
  storyboardJson: string
}
