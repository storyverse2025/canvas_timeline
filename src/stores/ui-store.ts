import { create } from 'zustand';

interface UiState {
  inspectorOpen: boolean;
  chatOpen: boolean;
  previewOpen: boolean;
  rightPanelTab: 'inspector' | 'chat' | 'assets';
  timelineHeight: number;
}

interface UiActions {
  toggleInspector: () => void;
  toggleChat: () => void;
  togglePreview: () => void;
  setRightPanelTab: (tab: 'inspector' | 'chat' | 'assets') => void;
  setTimelineHeight: (height: number) => void;
}

export const useUiStore = create<UiState & UiActions>()((set) => ({
  inspectorOpen: true,
  chatOpen: true,
  previewOpen: false,
  rightPanelTab: 'chat',
  timelineHeight: 250,

  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
  togglePreview: () => set((s) => ({ previewOpen: !s.previewOpen })),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  setTimelineHeight: (height) => set({ timelineHeight: height }),
}));
