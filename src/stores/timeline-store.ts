import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createIdbStorage } from '@/lib/storage/idb-storage';
import { v4 as uuid } from 'uuid';
import type { Shot, Track, TrackType, TimelineItem } from '@/types/timeline';

interface TimelineState {
  shots: Shot[];
  tracks: Track[];
  playheadTime: number;
  duration: number;
  zoom: number;
  isPlaying: boolean;
  snapEnabled: boolean;
  snapInterval: number;
}

interface TimelineActions {
  // Legacy shot API retained for older canvas/timeline pipeline code.
  setShots: (shots: Shot[]) => void;
  addShot: (label?: string, duration?: number) => string;
  removeShot: (shotId: string) => void;
  updateShot: (shotId: string, data: Partial<Omit<Shot, 'id'>>) => void;
  resizeShot: (shotId: string, newDuration: number) => void;
  linkNodeToShot: (shotId: string, nodeId: string) => void;
  unlinkNodeFromShot: (shotId: string, nodeId: string) => void;
  getShotById: (id: string) => Shot | undefined;

  // Track management
  addTrack: (type: TrackType, label?: string) => string;
  removeTrack: (trackId: string) => void;
  updateTrack: (trackId: string, data: Partial<Omit<Track, 'id' | 'items'>>) => void;
  initDefaultTracks: () => void;

  // Item management
  addItem: (trackId: string, item: Omit<TimelineItem, 'id' | 'trackId' | 'type'>) => string;
  removeItem: (itemId: string) => void;
  updateItem: (itemId: string, data: Partial<Omit<TimelineItem, 'id' | 'trackId'>>) => void;
  moveItem: (itemId: string, newTrackId: string, newStartTime: number) => void;
  resizeItem: (itemId: string, newDuration: number) => void;

  // Playback
  setPlayheadTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setZoom: (zoom: number) => void;
  setIsPlaying: (playing: boolean) => void;
  toggleSnap: () => void;
  setSnapInterval: (interval: number) => void;

  // Getters
  getTrackById: (id: string) => Track | undefined;
  getItemById: (id: string) => TimelineItem | undefined;
  getItemsForAsset: (assetId: string) => TimelineItem[];

  // Full replace (for save/load)
  setTracks: (tracks: Track[]) => void;
}

const DEFAULT_TRACKS: Omit<Track, 'id'>[] = [
  { type: 'keyframe', label: '关键帧', items: [] },
  { type: 'bgm', label: 'BGM', items: [] },
  { type: 'dialogue', label: '对话', items: [] },
];

function makeDefaultTracks(): Track[] {
  return DEFAULT_TRACKS.map((t) => ({ ...t, id: uuid() }));
}

export const useTimelineStore = create<TimelineState & TimelineActions>()(
  persist(
    immer((set, get) => ({
      tracks: [],
      shots: [],
      playheadTime: 0,
      duration: 120,
      zoom: 1,
      isPlaying: false,
      snapEnabled: true,
      snapInterval: 1,

      setShots: (shots) => set({ shots }),

      addShot: (label = 'New Shot', duration = 8) => {
        const id = uuid();
        set((state) => {
          const startTime = state.shots.reduce((t, s) => Math.max(t, s.startTime + s.duration), 0);
          state.shots.push({ id, label, duration, linkedNodeIds: [], startTime });
          const end = startTime + duration;
          if (end > state.duration) state.duration = end + 10;
        });
        return id;
      },

      removeShot: (shotId) => {
        set((state) => {
          state.shots = state.shots.filter((s) => s.id !== shotId);
          let t = 0;
          for (const shot of state.shots) {
            shot.startTime = t;
            t += shot.duration;
          }
        });
      },

      updateShot: (shotId, data) => {
        set((state) => {
          const shot = state.shots.find((s) => s.id === shotId);
          if (shot) Object.assign(shot, data);
        });
      },

      resizeShot: (shotId, newDuration) => {
        set((state) => {
          const shot = state.shots.find((s) => s.id === shotId);
          if (!shot) return;
          shot.duration = Math.max(1, newDuration);
          let t = 0;
          for (const s of state.shots) {
            s.startTime = t;
            t += s.duration;
          }
        });
      },

      linkNodeToShot: (shotId, nodeId) => {
        set((state) => {
          const shot = state.shots.find((s) => s.id === shotId);
          if (shot && !shot.linkedNodeIds.includes(nodeId)) shot.linkedNodeIds.push(nodeId);
        });
      },

      unlinkNodeFromShot: (shotId, nodeId) => {
        set((state) => {
          const shot = state.shots.find((s) => s.id === shotId);
          if (shot) shot.linkedNodeIds = shot.linkedNodeIds.filter((id) => id !== nodeId);
        });
      },

      getShotById: (id) => get().shots.find((s) => s.id === id),

      addTrack: (type, label) => {
        const id = uuid();
        set((state) => {
          const defaultLabel = type === 'keyframe' ? '关键帧'
            : type === 'bgm' ? 'BGM'
            : type === 'dialogue' ? '对话'
            : '视频';
          state.tracks.push({ id, type, label: label ?? defaultLabel, items: [] });
        });
        return id;
      },

      removeTrack: (trackId) => {
        set((state) => {
          state.tracks = state.tracks.filter((t) => t.id !== trackId);
        });
      },

      updateTrack: (trackId, data) => {
        set((state) => {
          const track = state.tracks.find((t) => t.id === trackId);
          if (track) Object.assign(track, data);
        });
      },

      initDefaultTracks: () => {
        set((state) => {
          if (state.tracks.length === 0) {
            state.tracks = makeDefaultTracks() as typeof state.tracks;
          }
        });
      },

      addItem: (trackId, item) => {
        const id = uuid();
        set((state) => {
          const track = state.tracks.find((t) => t.id === trackId);
          if (track) {
            const newItem: TimelineItem = {
              ...item,
              id,
              trackId,
              type: track.type,
            };
            track.items.push(newItem);
            // update total duration
            const maxEnd = state.tracks
              .flatMap((t) => t.items)
              .reduce((m, i) => Math.max(m, i.startTime + i.duration), 0);
            if (maxEnd > state.duration) state.duration = maxEnd + 10;
          }
        });
        return id;
      },

      removeItem: (itemId) => {
        set((state) => {
          for (const track of state.tracks) {
            const idx = track.items.findIndex((i) => i.id === itemId);
            if (idx >= 0) { track.items.splice(idx, 1); break; }
          }
        });
      },

      updateItem: (itemId, data) => {
        set((state) => {
          for (const track of state.tracks) {
            const item = track.items.find((i) => i.id === itemId);
            if (item) { Object.assign(item, data); break; }
          }
        });
      },

      moveItem: (itemId, newTrackId, newStartTime) => {
        set((state) => {
          let movedItem: TimelineItem | undefined;
          for (const track of state.tracks) {
            const idx = track.items.findIndex((i) => i.id === itemId);
            if (idx >= 0) {
              [movedItem] = track.items.splice(idx, 1);
              break;
            }
          }
          if (!movedItem) return;
          const newTrack = state.tracks.find((t) => t.id === newTrackId);
          if (newTrack) {
            newTrack.items.push({ ...movedItem, trackId: newTrackId, type: newTrack.type, startTime: newStartTime });
          }
        });
      },

      resizeItem: (itemId, newDuration) => {
        set((state) => {
          for (const track of state.tracks) {
            const item = track.items.find((i) => i.id === itemId);
            if (item) { item.duration = Math.max(1, newDuration); break; }
          }
        });
      },

      setPlayheadTime: (time) => set({ playheadTime: time }),
      setDuration: (duration) => set({ duration }),
      setZoom: (zoom) => set({ zoom: Math.max(0.1, Math.min(10, zoom)) }),
      setIsPlaying: (playing) => set({ isPlaying: playing }),
      toggleSnap: () => set((state) => { state.snapEnabled = !state.snapEnabled; }),
      setSnapInterval: (interval) => set({ snapInterval: interval }),

      getTrackById: (id) => get().tracks.find((t) => t.id === id),
      getItemById: (id) => {
        for (const track of get().tracks) {
          const item = track.items.find((i) => i.id === id);
          if (item) return item;
        }
        return undefined;
      },
      getItemsForAsset: (assetId) =>
        get().tracks.flatMap((t) => t.items.filter((i) => i.assetId === assetId)),

      setTracks: (tracks) => set({ tracks }),
    })),
    {
      name: 'timeline-store-v2',
      partialize: (state) => ({ tracks: state.tracks, shots: state.shots, duration: state.duration }),
      storage: createJSONStorage(() => createIdbStorage('timeline-store-v2')),
    }
  )
);
