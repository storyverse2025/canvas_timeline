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
