import { create } from 'zustand';

type ActiveTab = 'canvas' | 'table' | 'timeline';

interface ViewState {
  activeTab: ActiveTab;
  selectedAssetIds: string[];
}

interface ViewActions {
  setActiveTab: (tab: ActiveTab) => void;
  setSelectedAssetIds: (ids: string[]) => void;
  toggleAssetSelection: (id: string) => void;
  clearSelection: () => void;
}

export const useViewStore = create<ViewState & ViewActions>()((set, get) => ({
  activeTab: 'canvas',
  selectedAssetIds: [],

  setActiveTab: (tab) => set({ activeTab: tab }),

  setSelectedAssetIds: (ids) => {
    const current = get().selectedAssetIds;
    if (current.length === ids.length && ids.every((id, i) => current[i] === id)) return;
    set({ selectedAssetIds: ids });
  },

  toggleAssetSelection: (id) => {
    set((state) => {
      const idx = state.selectedAssetIds.indexOf(id);
      return {
        selectedAssetIds: idx >= 0
          ? state.selectedAssetIds.filter((i) => i !== id)
          : [...state.selectedAssetIds, id],
      };
    });
  },

  clearSelection: () => set({ selectedAssetIds: [] }),
}));
