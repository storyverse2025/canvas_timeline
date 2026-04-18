import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { StoryboardRow, StoryboardRowInput } from '@/types/storyboard'

interface State {
  rows: StoryboardRow[];
}

interface Actions {
  addRow: (row: Omit<StoryboardRow, 'id' | 'createdAt'>) => string;
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
        })),
      }),
      clear: () => set({ rows: [] }),
    })),
    {
      name: 'storyboard-store',
      version: 2,
      migrate: (persisted: unknown, version) => {
        // v1 used a different schema (sceneNo/visualDesc/...). Drop legacy rows.
        if (version < 2) return { rows: [] }
        return persisted as { rows: StoryboardRow[] }
      },
    }
  )
)
