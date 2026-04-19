/**
 * ProjectDB — Unified normalized data store for the entire project.
 *
 * All entities (elements, canvas nodes, storyboard rows, generation history)
 * live here with foreign key references. Referential integrity is enforced
 * on delete operations.
 */
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist } from 'zustand/middleware'
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
  dialogueAudioElementId?: string
  storyboardPrompts: string
  motionPrompts: string
  bgm: string
  bgmAudioElementId?: string
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

export interface Script {
  text: string
  optimizedText: string
  updatedAt: number
}

// ─── State shape ─────────────────────────────────────────────────────

interface ProjectDBState {
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
}

// ─── Default values ──────────────────────────────────────────────────

const DEFAULT_ART_DIRECTION: ArtDirection = {
  stylePreset: 'cinematic',
  customStyle: '',
  defaultImageModel: 'fal-ai/flux-pro/v1.1',
  defaultVideoModel: 'doubao-seedance-2-0-fast-260128',
  defaultAspectRatio: '16:9',
  updatedAt: 0,
}

const DEFAULT_SCRIPT: Script = {
  text: '',
  optimizedText: '',
  updatedAt: 0,
}

// ─── Store ───────────────────────────────────────────────────────────

export const useProjectDB = create<ProjectDBState & ProjectDBActions>()(
  persist(
    immer((set, get) => ({
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
            'dialogueAudioElementId', 'bgmAudioElementId',
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
        set({
          elements: {},
          canvasNodes: {},
          canvasEdges: {},
          storyboardRows: {},
          generationHistory: {},
          artDirection: { ...DEFAULT_ART_DIRECTION },
          script: { ...DEFAULT_SCRIPT },
        })
      },
    })),
    { name: 'project-db', version: 1 },
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
