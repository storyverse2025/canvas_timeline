/**
 * In-memory ProjectContext implementation.
 *
 * Two uses:
 *  - Unit tests (no zustand, no IndexedDB needed).
 *  - The `hermes chat -p` runner, where the agent operates on a JSON snapshot
 *    instead of a live React store.
 */

import type {
  BeatRecord,
  CharacterRecord,
  ListAPI,
  ProjectAPI,
  ProjectContext,
  PropRecord,
  SceneRecord,
  StyleRecord,
} from './types'
import type { BoundTools } from '@/lib/agents/_shared/tools/types'
import type { LLM } from '@/lib/agents/_shared/llm/types'

interface MemoryProjectSnapshot {
  style?: StyleRecord
  characters?: CharacterRecord[]
  scenes?: SceneRecord[]
  props?: PropRecord[]
  beats?: BeatRecord[]
}

const DEFAULT_STYLE: StyleRecord = {
  presetId: 'anime_psych_thriller_motion_comic',
  promptText: '',
}

function listAdapter<T extends { id: string }>(initial: T[], prefix: string): ListAPI<T> {
  let nextSeq = initial.length + 1
  const items: T[] = [...initial]

  function nextId(): string {
    const id = `${prefix}-${nextSeq}`
    nextSeq++
    return id
  }

  return {
    list: () => items,
    add: (record) => {
      const id = record.id ?? nextId()
      const stored = { ...record, id } as T
      items.push(stored)
      return stored
    },
    remove: (id) => {
      const idx = items.findIndex((r) => r.id === id)
      if (idx >= 0) items.splice(idx, 1)
    },
    get: (id) => items.find((r) => r.id === id),
  }
}

export interface CreateMemoryContextOptions {
  llm: LLM
  tools?: BoundTools
  snapshot?: MemoryProjectSnapshot
  abort?: AbortSignal
  log?: (message: string, data?: unknown) => void
}

export function createMemoryContext(opts: CreateMemoryContextOptions): ProjectContext {
  const snap = opts.snapshot ?? {}
  const style = snap.style ?? DEFAULT_STYLE

  const project: ProjectAPI = {
    style: { get: () => style },
    characters: listAdapter<CharacterRecord>(snap.characters ?? [], 'char'),
    scenes: listAdapter<SceneRecord>(snap.scenes ?? [], 'scene'),
    props: listAdapter<PropRecord>(snap.props ?? [], 'prop'),
    beats: listAdapter<BeatRecord>(snap.beats ?? [], 'B'),
  }

  const tools: BoundTools = opts.tools ?? {
    capabilities: {},
    peers: {},
  }

  return {
    project,
    llm: opts.llm,
    tools,
    log: opts.log ?? (() => {}),
    abort: opts.abort ?? new AbortController().signal,
  }
}
