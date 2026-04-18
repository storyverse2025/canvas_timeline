import { create } from 'zustand'
import type { CapabilitySpec } from '@/lib/capabilities/types'

export interface CapDialogState {
  capability: CapabilitySpec
  nodeId: string
  itemId: string
  prompt: string
  refImages: string[]
}

interface Store {
  state: CapDialogState | null
  open: (s: CapDialogState) => void
  close: () => void
}

export const useCapabilityDialogStore = create<Store>((set) => ({
  state: null,
  open: (s) => set({ state: s }),
  close: () => set({ state: null }),
}))
