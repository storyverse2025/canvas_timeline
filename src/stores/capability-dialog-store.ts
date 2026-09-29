import { create } from 'zustand'
import type { CapabilitySpec } from '@/lib/capabilities/types'

export interface CapDialogState {
  capability: CapabilitySpec
  nodeId: string
  itemId: string
  prompt: string
  refImages: string[]
  /** Pre-filled param values (e.g. the source video's duration / resolution). */
  params?: Record<string, string>
  /** Ship the node's own content as an input (true for 超分 / 视频转音频 …).
   *  False for a re-shoot, where the refs already describe the whole input set
   *  and the node's own output would ride along as an extra reference. */
  includeSourceContent?: boolean
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
