import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist, createJSONStorage } from 'zustand/middleware';
import { v4 as uuid } from 'uuid';
import { createIdbStorage } from '@/lib/storage/idb-storage';

export type CanvasItemKind = 'image' | 'text' | 'video' | 'audio';
/**
 * Semantic role for an item.
 *   - 'style'    : the global art-style text node
 *   - 'system'   : a system-prompt text node
 *   - 'keyframe' : a director-storyboard keyframe rendered by
 *                  director-agent.generateKeyframe. Used by ImageCanvasNode
 *                  to render an adopted-keyframe ⭐ badge when this item's
 *                  content matches some storyboard row's keyframeUrl.
 *   - 'beat-video' : a Seedance-generated beat video for a storyboard row.
 *                  Same adoption pattern as 'keyframe': ⭐ filled when this
 *                  item's content matches the row's beatVideoUrl; outline
 *                  on a sibling that the user can promote.
 *   - 'voice'    : an audio file representing a character's voice token,
 *                  spawned by voice-binding when actor-agent.castVoices
 *                  picks a 音色 for a character. Routed to AudioItemContent-
 *                  Panel in the inspector.
 *   - 'character-bio' : a text node holding a character's biography +
 *                  appearance pillars + composed image prompt, spawned by
 *                  character-design.spawnCharacterBioCanvasNodes.
 *   - 'scene'    : a 360° equirectangular panorama from art-director.
 *                  Renders via PanoramaViewer (drag to look around) instead
 *                  of a flat <img>.
 *   - 'script'   : the post-doctor revised expanded script (text node named
 *                  "最终扩写剧本"). Spawned by the director pipeline so the
 *                  baseline that all downstream agents consume is visible
 *                  on the canvas and the user can edit it inline.
 */
export type CanvasItemRole =
  | 'style'
  | 'system'
  | 'keyframe'
  | 'beat-video'
  | 'voice'
  | 'character'
  | 'character-bio'
  | 'scene'
  | 'scene-description'
  | 'prop'
  | 'prop-description'
  | 'script';

/** Snapshot of an item before a destructive update (regenerate, prompt
 *  rewrite). Pushed onto `CanvasItem.versions[]` by the canvas-api
 *  mutation layer so the user can roll back without losing the prior
 *  generation. Head = current item; versions[] = stack in reverse time
 *  order (newest first). */
export interface CanvasItemVersion {
  content: string;
  prompt?: string;
  refImages?: string[];
  refAudios?: string[];
  provider?: string;
  model?: string;
  timestamp: number;
}

export interface CanvasItem {
  id: string;
  kind: CanvasItemKind;
  name: string;
  /** image/video/audio: url, text: content */
  content: string;
  /** Semantic tag. See CanvasItemRole. */
  role?: CanvasItemRole;
  /** Optional human description (e.g., voice 音色 display name). */
  description?: string;
  /** Generation metadata (set when AI-generated, for Edit panel) */
  prompt?: string;
  refImages?: string[];
  /** Audio inputs sent to the generation provider (e.g., voice files
   *  uploaded as 音色N references when Seedance shot this beat video).
   *  The Edit panel renders these so the user sees exactly what the
   *  model received — distinct from the transitive canvas upstream. */
  refAudios?: string[];
  provider?: string;
  model?: string;
  /** Prior heads, newest first. Written by canvas-api mutations before
   *  overwriting `content` / `prompt`. Absent on items that have never
   *  been regenerated. */
  versions?: CanvasItemVersion[];
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
