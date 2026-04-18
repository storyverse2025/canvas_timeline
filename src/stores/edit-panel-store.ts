import { create } from 'zustand'

interface State {
  nodeId: string | null;
  itemId: string | null;
  open: (nodeId: string, itemId: string) => void;
  close: () => void;
}

export const useEditPanelStore = create<State>((set) => ({
  nodeId: null,
  itemId: null,
  open: (nodeId, itemId) => set({ nodeId, itemId }),
  close: () => set({ nodeId: null, itemId: null }),
}))
