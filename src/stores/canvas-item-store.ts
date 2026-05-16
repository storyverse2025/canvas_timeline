import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuid } from 'uuid';
import { createIdbStorage } from '@/lib/storage/idb-storage';

export type CanvasItemKind = 'image' | 'text' | 'video';
export type CanvasItemRole = 'style' | 'system';

export interface CanvasItem {
  id: string;
  kind: CanvasItemKind;
  name: string;
  /** image/video: url, text: content */
  content: string;
  /** Semantic tag for text items. 'style' = global art style, 'system' = system prompt. */
  role?: CanvasItemRole;
  /** Generation metadata (set when AI-generated, for Edit panel) */
  prompt?: string;
  refImages?: string[];
  provider?: string;
  model?: string;
  createdAt: number;
}

interface ItemState {
  items: Record<string, CanvasItem>;
}

interface ItemActions {
  addItem: (data: Omit<CanvasItem, 'id' | 'createdAt'>) => string;
  updateItem: (id: string, patch: Partial<Omit<CanvasItem, 'id' | 'createdAt'>>) => void;
  removeItem: (id: string) => void;
  getItem: (id: string) => CanvasItem | undefined;
}

export const useCanvasItemStore = create<ItemState & ItemActions>()(
  persist(
    immer((set, get) => ({
      items: {},

      addItem: (data) => {
        const id = uuid();
        set((s) => {
          s.items[id] = { ...data, id, createdAt: Date.now() };
        });
        return id;
      },

      updateItem: (id, patch) => {
        set((s) => {
          const it = s.items[id];
          if (it) Object.assign(it, patch);
        });
      },

      removeItem: (id) => {
        set((s) => {
          delete s.items[id];
        });
      },

      getItem: (id) => get().items[id],
    })),
    {
      name: 'canvas-item-store',
      // Image data URLs blow past the 5 MB localStorage cap; IDB has plenty.
      storage: createJSONStorage(() => createIdbStorage('canvas-item-store')),
    },
  )
);
