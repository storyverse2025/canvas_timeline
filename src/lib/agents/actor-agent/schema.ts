import { z } from 'zod'

import type { PersistedCastingCard } from '@/stores/project-db'

/**
 * Subset of storyboard row fields the actor-agent reads + rewrites. Keep
 * aligned with src/types/storyboard.ts StoryboardRow — actor-agent doesn't
 * own that shape (the table does), it only consumes character slots +
 * existing performance fields for context, and emits patches for the
 * 5 performance fields.
 */
export interface ActorRow {
  shot_number?: string
  visual_description?: string
  character_actions?: string
  emotion_mood?: string
  emotion_atmosphere?: string
  character_motivation?: string
  character_psychology?: string
  performance_guidance?: string
  dialogue?: string
  shot_size?: string
  lighting_atmosphere?: string
  /** Character slots — name lives in description's first comma-clause. */
  character1?: { description?: string }
  character2?: { description?: string }
}

/** Mirrors PersistedCastingCard — re-exported under an agent-local name. */
export type ActorCharacterCard = PersistedCastingCard

export const EnrichedPerformanceFieldsSchema = z.object({
  character_actions: z.string(),
  character_motivation: z.string(),
  character_psychology: z.string(),
  dialogue: z.string(),
  performance_guidance: z.string(),
})
export type EnrichedPerformanceFields = z.infer<typeof EnrichedPerformanceFieldsSchema>

export interface EnrichRowRequest {
  row: ActorRow
  /** Casting cards for every character that might appear in this row.
   *  Caller can pass the full project roster — the prompt picks the ones
   *  whose names match the row's character slots. */
  castingCards: ActorCharacterCard[]
  /** Scene context (name + description) for atmosphere. */
  scene?: { name?: string; description?: string }
  /** TYPE / TONE / GENRE from project-db.script.creativeBrief. */
  creativeBrief?: {
    projectType?: string
    tone?: string
    genre?: string
  }
  /** Global visual style hint (e.g., "Cold-toned filmic noir"). */
  visualStyle?: string
}

export interface EnrichTableRequest {
  /** All rows to enrich. Order preserved in the returned patches. */
  rows: Array<ActorRow & { id: string }>
  castingCards: ActorCharacterCard[]
  scene?: { name?: string; description?: string }
  creativeBrief?: {
    projectType?: string
    tone?: string
    genre?: string
  }
  visualStyle?: string
}

export type EnrichTableResult = Record<string, EnrichedPerformanceFields>

// ─── Voice casting (actor-agent picks a voice per character) ──────

/** Compact voice metadata sent to the LLM for casting picks. */
export interface VoiceCandidateSummary {
  id: string
  /** Filename basename (sans extension + attribution tail) — the most
   *  informative signal for tone (e.g. "AD学姐", "霸总", "御姐"). */
  displayName: string
  /** Optional one-line sample of the spoken content for tone reference. */
  sampleSnippet?: string
  gender?: string
  age?: string
  tags?: string[]
}

/** LLM output: characterName -> voiceId. Validated against the candidate
 *  pool so phantom ids never get persisted. */
export const VoiceBindingsSchema = z.record(z.string().min(1), z.string().min(1))
export type VoiceBindings = z.infer<typeof VoiceBindingsSchema>

export interface CastVoicesRequest {
  castingCards: ActorCharacterCard[]
  creativeBrief?: {
    projectType?: string
    tone?: string
    genre?: string
  }
}

// ─── Cinematographer prompt augmentation ──────────────────────────

export interface AttachVoiceRefsRequest {
  /** The cinematographer-built video prompt this verb appends to. */
  videoPrompt: string
  /** The storyboard row whose dialogue + character slots provide attribution. */
  row: ActorRow
  /** Project casting cards — for character-name matching. */
  castingCards: ActorCharacterCard[]
  /** characterName -> voiceId mapping persisted from a previous castVoices run. */
  voiceBindings: VoiceBindings
  /** Caller-supplied URL resolver — keeps actor-agent decoupled from the
   *  voice-library Vite asset chain. Returns the audio public URL or undefined. */
  voiceUrlFor: (voiceId: string) => string | undefined
}

// ─── designCharacters (biography + 7-pillar appearance) ──────────

/**
 * Minimal shape of an art-director-extracted character — actor-agent
 * reads it as input. Fields mirror canvas-elements.ExtractedCharacter
 * (required there) but the agent boundary keeps them optional so the
 * agent can also operate on hand-constructed inputs in tests.
 */
export interface ExtractedCharacterInput {
  name: string
  gender: string
  appearance: string
  clothing: string
  expression: string
  /** Numeric height (e.g. "172cm"). Passed through so the 7-pillar
   *  appearance_prompt can encode it in Pillar 1 — keeps body proportion
   *  consistent when the actor-agent's prompt drives image generation. */
  height?: string
  image_prompt: string
}

/** The 7-pillar appearance breakdown the actor-agent writes for each character. */
export const AppearancePillarsSchema = z.object({
  subject: z.string().min(1),
  bone_structure: z.string().min(1),
  features: z.string().min(1),
  expression: z.string().min(1),
  texture_light: z.string().min(1),
  quality: z.string().min(1),
  anti_ai: z.string().min(1),
})
export type AppearancePillars = z.infer<typeof AppearancePillarsSchema>

export const CharacterDesignSchema = z.object({
  name: z.string().min(1),
  biography: z.string().min(40),
  appearance_pillars: AppearancePillarsSchema,
  // No min length — designCharacters recomposes from pillars if the LLM
  // shipped a too-short or empty prompt, so the schema only needs the
  // string to exist.
  appearance_prompt: z.string(),
})
export type CharacterDesign = z.infer<typeof CharacterDesignSchema>

export const CharacterDesignsSchema = z.array(CharacterDesignSchema)
export type CharacterDesigns = z.infer<typeof CharacterDesignsSchema>

export interface DesignCharactersRequest {
  /** Characters as extracted by art-director.extractElements. */
  extractedCharacters: ExtractedCharacterInput[]
  /** Casting cards from script-agent dossier (already on projectDB.script.castingCards). */
  castingCards: ActorCharacterCard[]
  creativeBrief?: {
    projectType?: string
    tone?: string
    genre?: string
  }
  /** Global visual style fragment (e.g. style guide's goal line). */
  visualStyle?: string
}

export interface AttachVoiceRefsResult {
  /** videoPrompt with an appended `角色对白与音色` block (or unchanged if
   *  no character had both a line + a voice binding). The block labels each
   *  voice with a positional `音色N` tag matching `voiceAudioUrls[N-1]`. */
  videoPrompt: string
  /** Ordered voice file URLs to pass to Seedance as `kind: 'audio'` inputs.
   *  Position is the source of truth: `voiceAudioUrls[0]` is the file the
   *  prompt refers to as 音色1, `[1]` is 音色2, etc. Empty when no
   *  character has both a dialogue line + a voice binding. */
  voiceAudioUrls: string[]
  /** Per-character refs that were attached (for logging / inspection). */
  attached: Array<{
    /** 1-indexed position label used in the prompt (音色1, 音色2, ...). */
    slot: number
    character: string
    voiceId: string
    voiceUrl: string
    line: string
  }>
}
