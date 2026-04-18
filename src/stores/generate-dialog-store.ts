import { create } from 'zustand'
import type { MediaKind } from '@/lib/providers/types'

export interface DialogState {
  open: boolean;
  nodeId: string;
  itemId: string;
  prompt: string;
  upstreamImages: string[];
  defaultKind: MediaKind;
}

interface Store {
  state: DialogState | null;
  open: (s: Omit<DialogState, 'open'>) => void;
  close: () => void;
}

export const useGenerateDialogStore = create<Store>((set) => ({
  state: null,
  open: (s) => set({ state: { ...s, open: true } }),
  close: () => set({ state: null }),
}))
