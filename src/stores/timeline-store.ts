import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { v4 as uuid } from 'uuid';
import type { Shot } from '@/types/timeline';

interface TimelineState {
  shots: Shot[];
  playheadTime: number;
  duration: number;
  zoom: number;
  isPlaying: boolean;
  snapEnabled: boolean;
  snapInterval: number;
}

interface TimelineActions {
  addShot: (label?: string, duration?: number) => string;
  removeShot: (shotId: string) => void;
  updateShot: (shotId: string, data: Partial<Shot>) => void;
  reorderShots: (fromIndex: number, toIndex: number) => void;
  resizeShot: (shotId: string, newDuration: number) => void;
  linkNodeToShot: (shotId: string, nodeId: string) => void;
  unlinkNodeFromShot: (shotId: string, nodeId: string) => void;
  getShotById: (id: string) => Shot | undefined;
  recalculateStartTimes: () => void;
  setPlayheadTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setZoom: (zoom: number) => void;
  setIsPlaying: (playing: boolean) => void;
  toggleSnap: () => void;
  setSnapInterval: (interval: number) => void;
  setShots: (shots: Shot[]) => void;
}

function recalcStartTimes(shots: Shot[]) {
  let t = 0;
  for (const shot of shots) {
    shot.startTime = t;
    t += shot.duration;
  }
}

export const useTimelineStore = create<TimelineState & TimelineActions>()(
  persist(
  immer((set, get) => ({
    shots: [],
    playheadTime: 0,
    duration: 120,
    zoom: 1,
    isPlaying: false,
    snapEnabled: true,
    snapInterval: 1,

    addShot: (label, duration = 10) => {
      const id = uuid();
      set((state) => {
        const clamped = Math.max(5, Math.min(15, duration));
        state.shots.push({
          id,
          label: label || `Shot ${state.shots.length + 1}`,
          duration: clamped,
          linkedNodeIds: [],
          startTime: 0,
          color: undefined,
        });
        recalcStartTimes(state.shots);
        state.duration = state.shots.reduce((s, sh) => s + sh.duration, 0);
      });
      return id;
    },

    removeShot: (shotId) => {
      set((state) => {
        state.shots = state.shots.filter((s) => s.id !== shotId);
        recalcStartTimes(state.shots);
        state.duration = Math.max(10, state.shots.reduce((s, sh) => s + sh.duration, 0));
      });
    },

    updateShot: (shotId, data) => {
      set((state) => {
        const shot = state.shots.find((s) => s.id === shotId);
        if (shot) {
          Object.assign(shot, data);
          if (data.duration != null) {
            shot.duration = Math.max(5, Math.min(15, data.duration));
          }
          recalcStartTimes(state.shots);
          state.duration = state.shots.reduce((s, sh) => s + sh.duration, 0);
        }
      });
    },

    reorderShots: (fromIndex, toIndex) => {
      set((state) => {
        const [shot] = state.shots.splice(fromIndex, 1);
        state.shots.splice(toIndex, 0, shot);
        recalcStartTimes(state.shots);
      });
    },

    resizeShot: (shotId, newDuration) => {
      set((state) => {
        const shot = state.shots.find((s) => s.id === shotId);
        if (shot) {
          shot.duration = Math.max(5, Math.min(15, newDuration));
          recalcStartTimes(state.shots);
          state.duration = state.shots.reduce((s, sh) => s + sh.duration, 0);
        }
      });
    },

    linkNodeToShot: (shotId, nodeId) => {
      set((state) => {
        const shot = state.shots.find((s) => s.id === shotId);
        if (shot && !shot.linkedNodeIds.includes(nodeId)) {
          shot.linkedNodeIds.push(nodeId);
        }
      });
    },

    unlinkNodeFromShot: (shotId, nodeId) => {
      set((state) => {
        const shot = state.shots.find((s) => s.id === shotId);
        if (shot) {
          shot.linkedNodeIds = shot.linkedNodeIds.filter((id) => id !== nodeId);
        }
      });
    },

    getShotById: (id) => get().shots.find((s) => s.id === id),

    recalculateStartTimes: () => {
      set((state) => {
        recalcStartTimes(state.shots);
        state.duration = Math.max(10, state.shots.reduce((s, sh) => s + sh.duration, 0));
      });
    },

    setPlayheadTime: (time) => set({ playheadTime: time }),
    setDuration: (duration) => set({ duration }),
    setZoom: (zoom) => set({ zoom: Math.max(0.1, Math.min(10, zoom)) }),
    setIsPlaying: (playing) => set({ isPlaying: playing }),
    toggleSnap: () => set((state) => { state.snapEnabled = !state.snapEnabled; }),
    setSnapInterval: (interval) => set({ snapInterval: interval }),

    setShots: (shots) => {
      set((state) => {
        state.shots = shots;
        recalcStartTimes(state.shots);
        state.duration = Math.max(10, state.shots.reduce((s, sh) => s + sh.duration, 0));
      });
    },
  })),
  {
    name: 'timeline-store',
    partialize: (state) => ({ shots: state.shots, duration: state.duration }),
  }
  )
);
