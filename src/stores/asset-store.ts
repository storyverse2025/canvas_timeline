import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { v4 as uuid } from 'uuid';
import type { Asset, AssetType } from '@/types/asset';

interface AssetState {
  assets: Asset[];
}

interface AssetActions {
  addAsset: (data: Omit<Asset, 'id' | 'createdAt'>) => string;
  updateAsset: (id: string, data: Partial<Omit<Asset, 'id' | 'createdAt'>>) => void;
  removeAsset: (id: string) => void;
  setAssets: (assets: Asset[]) => void;
  getAssetById: (id: string) => Asset | undefined;
  getAssetsByType: (type: AssetType) => Asset[];
}

export const useAssetStore = create<AssetState & AssetActions>()(
  persist(
    immer((set, get) => ({
      assets: [],

      addAsset: (data) => {
        const id = uuid();
        set((state) => {
          state.assets.push({ ...data, id, createdAt: Date.now() });
        });
        return id;
      },

      updateAsset: (id, data) => {
        set((state) => {
          const asset = state.assets.find((a) => a.id === id);
          if (asset) Object.assign(asset, data);
        });
      },

      removeAsset: (id) => {
        set((state) => {
          state.assets = state.assets.filter((a) => a.id !== id);
        });
      },

      setAssets: (assets) => set({ assets }),

      getAssetById: (id) => get().assets.find((a) => a.id === id),

      getAssetsByType: (type) => get().assets.filter((a) => a.type === type),
    })),
    { name: 'asset-store' }
  )
);
