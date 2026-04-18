import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { StoryboardRow, StoryboardRowInput } from '@/types/storyboard'

const EMPTY_SLOT = { image: '', description: '', nodeId: '' }

interface State {
  rows: StoryboardRow[];
}

interface Actions {
  addRow: (row: Omit<StoryboardRow, 'id' | 'createdAt'>) => string;
  insertRowAfter: (afterId: string, row: Omit<StoryboardRow, 'id' | 'createdAt'>) => string;
  updateRow: (id: string, patch: Partial<Omit<StoryboardRow, 'id' | 'createdAt'>>) => void;
  removeRow: (id: string) => void;
  replaceAll: (rows: Array<StoryboardRowInput & { referenceNodeId?: string }>) => void;
  clear: () => void;
}

export const useStoryboardStore = create<State & Actions>()(
  persist(
    immer((set) => ({
      rows: [],
      addRow: (row) => {
        const id = uuid()
        set((s) => { s.rows.push({ ...row, id, createdAt: Date.now() }) })
        return id
      },
      insertRowAfter: (afterId, row) => {
        const id = uuid()
        set((s) => {
          const idx = s.rows.findIndex((r) => r.id === afterId)
          const newRow = { ...row, id, createdAt: Date.now() }
          if (idx >= 0) s.rows.splice(idx + 1, 0, newRow)
          else s.rows.push(newRow)
        })
        return id
      },
      updateRow: (id, patch) => set((s) => {
        const r = s.rows.find((x) => x.id === id)
        if (r) Object.assign(r, patch)
      }),
      removeRow: (id) => set((s) => { s.rows = s.rows.filter((r) => r.id !== id) }),
      replaceAll: (rows) => set({
        rows: rows.map((r) => ({
          ...r,
          id: uuid(),
          createdAt: Date.now(),
          status: 'todo' as const,
          character1: r.character1 ?? { ...EMPTY_SLOT },
          character2: r.character2 ?? { ...EMPTY_SLOT },
          prop1: r.prop1 ?? { ...EMPTY_SLOT },
          prop2: r.prop2 ?? { ...EMPTY_SLOT },
          scene: r.scene ?? { ...EMPTY_SLOT },
        })),
      }),
      clear: () => set({ rows: [] }),
    })),
    {
      name: 'storyboard-store',
      version: 3,
      migrate: (persisted: unknown, version) => {
        if (version < 3) {
          // Migrate v2 rows: rename aiImageUrl→keyframeUrl, aiVideoUrl→beatVideoUrl, add element slots
          const old = persisted as { rows?: Array<Record<string, unknown>> }
          const rows = (old.rows ?? []).map((r) => ({
            ...r,
            keyframeUrl: r.keyframeUrl ?? r.aiImageUrl ?? '',
            beatVideoUrl: r.beatVideoUrl ?? r.aiVideoUrl ?? '',
            character1: r.character1 ?? { ...EMPTY_SLOT },
            character2: r.character2 ?? { ...EMPTY_SLOT },
            prop1: r.prop1 ?? { ...EMPTY_SLOT },
            prop2: r.prop2 ?? { ...EMPTY_SLOT },
            scene: r.scene ?? { ...EMPTY_SLOT },
          }))
          // Remove old fields
          for (const r of rows) { delete (r as Record<string, unknown>).aiImageUrl; delete (r as Record<string, unknown>).aiVideoUrl }
          return { rows }
        }
        return persisted as { rows: StoryboardRow[] }
      },
    }
  )
)
