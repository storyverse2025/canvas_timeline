/**
 * ProjectDB — Unified normalized data store for the entire project.
 *
 * All entities (elements, canvas nodes, storyboard rows, generation history)
 * live here with foreign key references. Referential integrity is enforced
 * on delete operations.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createIdbStorage } from '@/lib/storage/idb-storage'
import { v4 as uuid } from 'uuid'

// ─── Types ───────────────────────────────────────────────────────────

export type ElementKind = 'image' | 'text' | 'video' | 'audio'
export type ElementRole = 'character' | 'prop' | 'scene' | 'keyframe' | 'beat-video' | 'script' | 'unknown'
export type ElementSource = 'manual' | 'generated' | 'imported'

export interface Element {
  id: string
  kind: ElementKind
  role: ElementRole
  name: string
  content: string
  description: string
  prompt?: string
  provider?: string
  model?: string
  refImages?: string[]
  tags?: string[]
  source: ElementSource
  createdAt: number
  updatedAt: number
}

export interface CanvasNode {
  id: string
  elementId: string
  x: number
  y: number
  width: number
  height: number
  type: 'image' | 'text'
}

export interface CanvasEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
}

export interface StoryboardRow {
  id: string
  shotNumber: string
  sortOrder: number
  duration: number
  visualDescription: string
  visualAnchor: string
  shotSize: string
  characterActions: string
  emotionMood: string
  lightingAtmosphere: string
  dialogue: string
  storyboardPrompts: string
  motionPrompts: string
  bgm: string
  soundEffects: string
  keyframeElementId?: string
  beatVideoElementId?: string
  character1ElementId?: string
  character2ElementId?: string
  prop1ElementId?: string
  prop2ElementId?: string
  sceneElementId?: string
  referenceImageElementId?: string
  createdAt: number
}

export type HistoryStatus = 'pending' | 'running' | 'done' | 'failed'

export interface GenerationHistoryEntry {
  id: string
  capability: string
  prompt: string
  inputs: { kind: string; url?: string; text?: string }[]
  params: Record<string, unknown>
  resultElementId?: string
  resultUrl?: string
  resultKind: 'image' | 'video' | 'audio' | 'text'
  status: HistoryStatus
  error?: string
  durationMs?: number
  createdAt: number
}

export interface ArtDirection {
  stylePreset: string
  customStyle: string
  defaultImageModel: string
  defaultVideoModel: string
  defaultAspectRatio: string
  updatedAt: number
}

/**
 * Distilled facts from the script-agent's expand-script dossier — used by
 * the keyframe generator to thread TYPE / TONE / GENRE into the prompt
 * header so gpt-image-2 knows what kind of project it's rendering for.
 *
 * director-assistant populates this right after script-agent runs; the
 * useStoryboardGenerate hook reads it when building each keyframe request.
 */
export interface CreativeBrief {
  /** Project type label (e.g., "短视频 (30-60秒)", "AI 漫剧"). */
  projectType?: string
  /** Story goal / TONE (e.g., "感动观众", "悬疑救赎"). */
  tone?: string
  /** Derived "GENRE" line combining type + tone (e.g., "短视频 · 感动观众"). */
  genre?: string
  /** Platform / audience label from the dossier. */
  platformAudience?: string
}

/**
 * Casting card persisted from the script-agent dossier. actor-agent reads
 * these to "play" each character — voice_print drives dialogue tone,
 * performance_anchors drive performance_guidance, personality_layers drive
 * character_psychology.
 *
 * Mirrors src/lib/agents/script-agent/schema.ts CastingCard. Stored on
 * projectDB.script.castingCards so the agent survives reloads + can be
 * read from anywhere without touching script-agent internals.
 */
export interface PersistedCastingCard {
  name: string
  dramatic_function?: string
  age_range?: string
  gender_presentation?: string
  appearance_for_image?: string
  personality_layers?: string
  voice_print?: string
  performance_anchors?: string
  casting_notes?: string
  /** Biography written by actor-agent.designCharacters — 200-400 字 narrative. */
  biography?: string
  /** 7-pillar appearance breakdown from actor-agent.designCharacters. */
  appearance_pillars?: {
    subject: string
    bone_structure: string
    features: string
    expression: string
    texture_light: string
    quality: string
    anti_ai: string
  }
  /** Composed appearance prompt the art-director hands to the image model. */
  appearance_prompt?: string
}

export interface Script {
  text: string
  optimizedText: string
  /** Total duration (seconds) the storyboard rows must sum to. Required by
   *  the director-assistant pipeline; the LLM treats it as a hard constraint. */
  totalDurationSeconds: number
  /** LLM-generated short title (6-12 中文字符) for this session, computed
   *  from the user's script at director-assistant start. Surfaces in the
   *  session picker so cross-machine load shows meaningful labels instead
   *  of the first 60 chars of raw script text. */
  sessionTitle?: string
  /** Distilled facts from the most recent script-agent run. */
  creativeBrief?: CreativeBrief
  /** Casting cards from the most recent script-agent dossier. Consumed by
   *  actor-agent to play each character's lines + performance. */
  castingCards?: PersistedCastingCard[]
  /** characterName -> voiceLibrary id mapping produced by actor-agent.castVoices.
   *  Consumed by cinematographer prompt augmentation + by the canvas audio
   *  node spawner so every character has a paired voice asset on the canvas. */
  voiceBindings?: Record<string, string>
  updatedAt: number
}

// ─── State shape ─────────────────────────────────────────────────────

interface ProjectDBState {
  /** Stable per-project identifier. Used by the server-side session
   *  snapshot store (vite-session-snapshot-plugin) as the filename
   *  basis — sha256(projectId)[:16] — so the same IP can hold multiple
   *  distinct sessions (one per project) without overwriting each other.
   *  Generated once on store init; preserved across clearAll; regenerated
   *  only by newProject(). */
  projectId: string
  elements: Record<string, Element>
  canvasNodes: Record<string, CanvasNode>
  canvasEdges: Record<string, CanvasEdge>
  storyboardRows: Record<string, StoryboardRow>
  generationHistory: Record<string, GenerationHistoryEntry>
  artDirection: ArtDirection
  script: Script
}

// ─── Actions ─────────────────────────────────────────────────────────

interface ProjectDBActions {
  // Elements
  addElement: (data: Omit<Element, 'id' | 'createdAt' | 'updatedAt'>) => string
  updateElement: (id: string, patch: Partial<Omit<Element, 'id' | 'createdAt'>>) => void
  deleteElement: (id: string) => void
  getElement: (id: string) => Element | undefined
  getElementsByRole: (role: ElementRole) => Element[]
  getElementsBySource: (source: ElementSource) => Element[]
  getElementsByKind: (kind: ElementKind) => Element[]

  // Canvas nodes
  addCanvasNode: (data: Omit<CanvasNode, 'id'>) => string
  addCanvasNodeWithId: (data: CanvasNode) => void
  updateCanvasNode: (id: string, patch: Partial<Omit<CanvasNode, 'id'>>) => void
  deleteCanvasNode: (id: string) => void
  getCanvasNode: (id: string) => CanvasNode | undefined
  getCanvasNodeByElementId: (elementId: string) => CanvasNode | undefined
  getAllCanvasNodes: () => CanvasNode[]

  // Canvas edges
  addCanvasEdge: (sourceNodeId: string, targetNodeId: string) => string
  deleteCanvasEdge: (id: string) => void
  getEdgesForNode: (nodeId: string) => CanvasEdge[]
  getAllCanvasEdges: () => CanvasEdge[]

  // Storyboard rows
  addStoryboardRow: (data: Omit<StoryboardRow, 'id' | 'createdAt'>) => string
  insertStoryboardRowAfter: (afterId: string, data: Omit<StoryboardRow, 'id' | 'createdAt'>) => string
  updateStoryboardRow: (id: string, patch: Partial<Omit<StoryboardRow, 'id' | 'createdAt'>>) => void
  deleteStoryboardRow: (id: string) => void
  getStoryboardRow: (id: string) => StoryboardRow | undefined
  getStoryboardRowsSorted: () => StoryboardRow[]
  replaceAllStoryboardRows: (rows: Omit<StoryboardRow, 'id' | 'createdAt'>[]) => void

  // Generation history
  addHistoryEntry: (data: Omit<GenerationHistoryEntry, 'id' | 'createdAt'>) => string
  updateHistoryEntry: (id: string, patch: Partial<Omit<GenerationHistoryEntry, 'id' | 'createdAt'>>) => void
  getHistoryByCapability: (capability: string) => GenerationHistoryEntry[]
  getHistoryByElement: (elementId: string) => GenerationHistoryEntry[]
  getAllHistory: () => GenerationHistoryEntry[]

  // Art direction
  updateArtDirection: (patch: Partial<Omit<ArtDirection, 'updatedAt'>>) => void

  // Script
  updateScript: (patch: Partial<Omit<Script, 'updatedAt'>>) => void

  // Bulk
  clearAll: () => void
  /** Reset every store entity AND generate a fresh projectId. This is
   *  the "new project" action: triggers the server-side snapshot to
   *  start writing to a brand-new file instead of overwriting the
   *  current session. clearAll preserves the projectId; newProject
   *  rotates it. */
  newProject: () => void
}

// ─── Default values ──────────────────────────────────────────────────

const DEFAULT_ART_DIRECTION: ArtDirection = {
  stylePreset: 'anime_psych_thriller_motion_comic',
  customStyle: '',
  defaultImageModel: 'openai/gpt-5.4-image-2',
  defaultVideoModel: 'dreamina-seedance-2-0-260128',
  defaultAspectRatio: '16:9',
  updatedAt: 0,
}

const DEFAULT_SCRIPT: Script = {
  text: '',
  optimizedText: '',
  totalDurationSeconds: 30,
  creativeBrief: undefined,
  castingCards: undefined,
  updatedAt: 0,
}

// ─── Store ───────────────────────────────────────────────────────────

export const useProjectDB = create<ProjectDBState & ProjectDBActions>()(
  persist(
    immer((set, get) => ({
      // Lazy: a fresh store gets a fresh id. On reload, persist's
      // migrate hook backfills this for legacy state that didn't have
      // it (see migrate v3→v4 below).
      projectId: uuid(),
      elements: {},
      canvasNodes: {},
      canvasEdges: {},
      storyboardRows: {},
      generationHistory: {},
      artDirection: { ...DEFAULT_ART_DIRECTION },
      script: { ...DEFAULT_SCRIPT },

      // ─── Elements ──────────────────────────────────────────────

      addElement: (data) => {
        const id = uuid()
        const now = Date.now()
        set((s) => { s.elements[id] = { ...data, id, createdAt: now, updatedAt: now } })
        return id
      },

      updateElement: (id, patch) => {
        set((s) => {
          const el = s.elements[id]
          if (el) { Object.assign(el, patch); el.updatedAt = Date.now() }
        })
      },

      deleteElement: (id) => {
        set((s) => {
          delete s.elements[id]
          // Nullify all FK references in storyboard rows
          const fkFields: (keyof StoryboardRow)[] = [
            'keyframeElementId', 'beatVideoElementId',
            'character1ElementId', 'character2ElementId',
            'prop1ElementId', 'prop2ElementId',
            'sceneElementId', 'referenceImageElementId',
          ]
          for (const row of Object.values(s.storyboardRows)) {
            for (const fk of fkFields) {
              if ((row as Record<string, unknown>)[fk] === id) {
                (row as Record<string, unknown>)[fk] = undefined
              }
            }
          }
          // Nullify in generation history
          for (const h of Object.values(s.generationHistory)) {
            if (h.resultElementId === id) h.resultElementId = undefined
          }
          // Remove canvas nodes for this element
          const nodeIds = Object.values(s.canvasNodes)
            .filter((n) => n.elementId === id)
            .map((n) => n.id)
          for (const nid of nodeIds) {
            delete s.canvasNodes[nid]
            // Remove edges referencing this node
            for (const [eid, edge] of Object.entries(s.canvasEdges)) {
              if (edge.sourceNodeId === nid || edge.targetNodeId === nid) {
                delete s.canvasEdges[eid]
              }
            }
          }
        })
      },

      getElement: (id) => get().elements[id],

      getElementsByRole: (role) =>
        Object.values(get().elements).filter((e) => e.role === role),

      getElementsBySource: (source) =>
        Object.values(get().elements).filter((e) => e.source === source),

      getElementsByKind: (kind) =>
        Object.values(get().elements).filter((e) => e.kind === kind),

      // ─── Canvas Nodes ──────────────────────────────────────────

      addCanvasNode: (data) => {
        const id = uuid()
        set((s) => { s.canvasNodes[id] = { ...data, id } })
        return id
      },

      addCanvasNodeWithId: (data) => {
        set((s) => { s.canvasNodes[data.id] = data })
      },

      updateCanvasNode: (id, patch) => {
        set((s) => {
          const n = s.canvasNodes[id]
          if (n) Object.assign(n, patch)
        })
      },

      deleteCanvasNode: (id) => {
        set((s) => {
          delete s.canvasNodes[id]
          // Remove edges referencing this node
          for (const [eid, edge] of Object.entries(s.canvasEdges)) {
            if (edge.sourceNodeId === id || edge.targetNodeId === id) {
              delete s.canvasEdges[eid]
            }
          }
        })
      },

      getCanvasNode: (id) => get().canvasNodes[id],

      getCanvasNodeByElementId: (elementId) =>
        Object.values(get().canvasNodes).find((n) => n.elementId === elementId),

      getAllCanvasNodes: () => Object.values(get().canvasNodes),

      // ─── Canvas Edges ──────────────────────────────────────────

      addCanvasEdge: (sourceNodeId, targetNodeId) => {
        // Deduplicate
        const existing = Object.values(get().canvasEdges).find(
          (e) => e.sourceNodeId === sourceNodeId && e.targetNodeId === targetNodeId
        )
        if (existing) return existing.id
        const id = uuid()
        set((s) => { s.canvasEdges[id] = { id, sourceNodeId, targetNodeId } })
        return id
      },

      deleteCanvasEdge: (id) => {
        set((s) => { delete s.canvasEdges[id] })
      },

      getEdgesForNode: (nodeId) =>
        Object.values(get().canvasEdges).filter(
          (e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId
        ),

      getAllCanvasEdges: () => Object.values(get().canvasEdges),

      // ─── Storyboard Rows ──────────────────────────────────────

      addStoryboardRow: (data) => {
        const id = uuid()
        set((s) => { s.storyboardRows[id] = { ...data, id, createdAt: Date.now() } })
        return id
      },

      insertStoryboardRowAfter: (afterId, data) => {
        const id = uuid()
        set((s) => {
          const afterRow = s.storyboardRows[afterId]
          const afterOrder = afterRow?.sortOrder ?? 0
          // Shift all rows after this one
          for (const row of Object.values(s.storyboardRows)) {
            if (row.sortOrder > afterOrder) row.sortOrder += 1
          }
          s.storyboardRows[id] = { ...data, id, sortOrder: afterOrder + 1, createdAt: Date.now() }
        })
        return id
      },

      updateStoryboardRow: (id, patch) => {
        set((s) => {
          const r = s.storyboardRows[id]
          if (r) Object.assign(r, patch)
        })
      },

      deleteStoryboardRow: (id) => {
        set((s) => { delete s.storyboardRows[id] })
      },

      getStoryboardRow: (id) => get().storyboardRows[id],

      getStoryboardRowsSorted: () =>
        Object.values(get().storyboardRows).sort((a, b) => a.sortOrder - b.sortOrder),

      replaceAllStoryboardRows: (rows) => {
        set((s) => {
          s.storyboardRows = {}
          rows.forEach((r, i) => {
            const id = uuid()
            s.storyboardRows[id] = { ...r, id, sortOrder: i, createdAt: Date.now() }
          })
        })
      },

      // ─── Generation History ────────────────────────────────────

      addHistoryEntry: (data) => {
        const id = uuid()
        set((s) => { s.generationHistory[id] = { ...data, id, createdAt: Date.now() } })
        return id
      },

      updateHistoryEntry: (id, patch) => {
        set((s) => {
          const h = s.generationHistory[id]
          if (h) Object.assign(h, patch)
        })
      },

      getHistoryByCapability: (capability) =>
        Object.values(get().generationHistory)
          .filter((h) => h.capability === capability)
          .sort((a, b) => b.createdAt - a.createdAt),

      getHistoryByElement: (elementId) =>
        Object.values(get().generationHistory)
          .filter((h) => h.resultElementId === elementId)
          .sort((a, b) => b.createdAt - a.createdAt),

      getAllHistory: () =>
        Object.values(get().generationHistory).sort((a, b) => b.createdAt - a.createdAt),

      // ─── Art Direction ─────────────────────────────────────────

      updateArtDirection: (patch) => {
        set((s) => { Object.assign(s.artDirection, patch); s.artDirection.updatedAt = Date.now() })
      },

      // ─── Script ────────────────────────────────────────────────

      updateScript: (patch) => {
        set((s) => { Object.assign(s.script, patch); s.script.updatedAt = Date.now() })
      },

      // ─── Bulk ──────────────────────────────────────────────────

      clearAll: () => {
        // Preserve projectId — clearAll wipes content but stays in the
        // same "session slot" server-side. Use newProject() to also
        // rotate the id and start a new session.
        set((s) => {
          s.elements = {}
          s.canvasNodes = {}
          s.canvasEdges = {}
          s.storyboardRows = {}
          s.generationHistory = {}
          s.artDirection = { ...DEFAULT_ART_DIRECTION }
          s.script = { ...DEFAULT_SCRIPT }
        })
      },

      newProject: () => {
        set((s) => {
          s.projectId = uuid()
          s.elements = {}
          s.canvasNodes = {}
          s.canvasEdges = {}
          s.storyboardRows = {}
          s.generationHistory = {}
          s.artDirection = { ...DEFAULT_ART_DIRECTION }
          s.script = { ...DEFAULT_SCRIPT }
        })
      },
    })),
    {
      name: 'project-db',
      version: 5,
      storage: createJSONStorage(() => createIdbStorage('project-db')),
      migrate: (state, fromVersion) => {
        if (fromVersion < 2 && state && typeof state === 'object') {
          const s = state as { artDirection?: ArtDirection }
          if (s.artDirection?.defaultImageModel === 'fal-ai/flux-pro/v1.1') {
            s.artDirection.defaultImageModel = 'openai/gpt-5.4-image-2'
          }
        }
        // v3: Doubao (cn-beijing 火山方舟) → BytePlus海外 (Dreamina). Model id
        // prefix changed from `doubao-` to `dreamina-`. Rewrite any stored
        // defaultVideoModel / defaultImageModel that still uses the old
        // prefix so existing projects don't ship a 404 model string.
        if (fromVersion < 3 && state && typeof state === 'object') {
          const s = state as { artDirection?: ArtDirection }
          const rename = (m: string | undefined): string | undefined =>
            m && /^doubao-(seedance|seedream)-/.test(m) ? m.replace(/^doubao-/, 'dreamina-') : m
          if (s.artDirection) {
            const v = rename(s.artDirection.defaultVideoModel)
            if (v) s.artDirection.defaultVideoModel = v
            const i = rename(s.artDirection.defaultImageModel)
            if (i) s.artDirection.defaultImageModel = i
          }
        }
        // v4: introduce projectId. Legacy state was keyed solely by IP
        // server-side, which meant the same machine could only ever have
        // one session — switching projects overwrote the previous one.
        // Now session files are keyed by sha256(projectId). Generate one
        // here so the next snapshot push lands in a project-scoped file.
        if (fromVersion < 4 && state && typeof state === 'object') {
          const s = state as { projectId?: string }
          if (!s.projectId) s.projectId = uuid()
        }
        // v5: bump default video model from Seedance 2.0 Fast → 2.0 (full).
        // Only migrate if the user is still on the previous default — a
        // project that explicitly picked Fast (480p / 12s cap) keeps it.
        // Note: this only updates the model id stored in state; the
        // operator still has to set the corresponding ep-* endpoint via
        // SEEDANCE_ENDPOINT_DREAMINA_SEEDANCE_2_0_260128 (or generic
        // SEEDANCE_ENDPOINT) for BytePlus to actually serve the non-fast
        // model — see vite-capabilities-plugin.ts resolveSeedanceModel.
        if (fromVersion < 5 && state && typeof state === 'object') {
          const s = state as { artDirection?: ArtDirection }
          if (s.artDirection?.defaultVideoModel === 'dreamina-seedance-2-0-fast-260128') {
            s.artDirection.defaultVideoModel = 'dreamina-seedance-2-0-260128'
          }
        }
        return state as ProjectDBState & ProjectDBActions
      },
    },
  ),
)

// ─── Selector helpers (for use outside React) ────────────────────────

/** Get element content (URL or text) for a storyboard FK */
export function resolveElementContent(elementId: string | undefined): string {
  if (!elementId) return ''
  return useProjectDB.getState().elements[elementId]?.content ?? ''
}

/** Get element by id (non-reactive) */
export function getElementById(id: string): Element | undefined {
  return useProjectDB.getState().elements[id]
}
