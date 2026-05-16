/**
 * ProjectContext is the runtime handle every agent receives.
 *
 * Agents never import zustand stores, IndexedDB, or window globals directly —
 * they go through this typed surface. That keeps agents unit-testable (swap
 * for InMemoryProject), reusable from the hermes CLI (swap for a JSON-file
 * adapter), and cleanly bounded.
 *
 * The shape stays intentionally small for Phase 1. Domain accessors
 * (characters, scenes, storyboard, etc.) get added as the agents that need
 * them come online.
 */

import type { BoundTools } from '@/lib/agents/_shared/tools/types'
import type { LLM } from '@/lib/agents/_shared/llm/types'

/** A character extracted from a script. */
export interface CharacterRecord {
  id: string
  name: string
  description: string
  imageUrl?: string
}

export interface SceneRecord {
  id: string
  name: string
  description: string
  imageUrl?: string
}

export interface PropRecord {
  id: string
  name: string
  description: string
  imageUrl?: string
}

export interface BeatRecord {
  /** Stable beat identifier, e.g. "B1". */
  id: string
  /** One-line summary. */
  summary: string
  /** Full beat body. */
  body: string
}

export interface StyleRecord {
  /** Preset id, e.g. "anime_psych_thriller_motion_comic". */
  presetId: string
  /** Pre-rendered text passed to image/video prompts as {{artStyle}}. */
  promptText: string
}

export interface ListAPI<T extends { id: string }> {
  list(): readonly T[]
  add(record: Omit<T, 'id'> & Partial<Pick<T, 'id'>>): T
  remove(id: string): void
  get(id: string): T | undefined
}

export interface ProjectAPI {
  style: { get(): StyleRecord }
  characters: ListAPI<CharacterRecord>
  scenes: ListAPI<SceneRecord>
  props: ListAPI<PropRecord>
  beats: ListAPI<BeatRecord>
}

export interface ProjectContext {
  /** The project-state API. */
  project: ProjectAPI
  /** LLM facade. Wraps callClaude/streamClaude in prod, mocks in tests. */
  llm: LLM
  /** Capabilities/peers bound from the agent's SKILL.md frontmatter. */
  tools: BoundTools
  /** Emit a progress note. Distinct from Turn 'progress' — this is for ambient logs. */
  log(message: string, data?: unknown): void
  /** AbortSignal honored by long-running tool calls. */
  abort: AbortSignal
}
