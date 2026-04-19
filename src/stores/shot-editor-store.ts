import { create } from 'zustand'

export type EditMode = 'dialog' | 'inpaint' | 'association' | 'multi-angle' | 'replace'

interface ShotEditorState {
  activeRowId: string | null
  editMode: EditMode
  isOpen: boolean
}

interface ShotEditorActions {
  openEditor: (rowId: string, mode?: EditMode) => void
  closeEditor: () => void
  setEditMode: (mode: EditMode) => void
}

export const useShotEditorStore = create<ShotEditorState & ShotEditorActions>()((set) => ({
  activeRowId: null,
  editMode: 'dialog',
  isOpen: false,

  openEditor: (rowId, mode) => set({ activeRowId: rowId, editMode: mode ?? 'dialog', isOpen: true }),
  closeEditor: () => set({ activeRowId: null, isOpen: false }),
  setEditMode: (mode) => set({ editMode: mode }),
}))
