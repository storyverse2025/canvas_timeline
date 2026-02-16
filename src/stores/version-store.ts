import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuid } from 'uuid';
import type { TimelineVersion, TimelineTrack } from '@/types/timeline';

interface VersionState {
  versions: TimelineVersion[];
  activeVersionId: string | null;
}

interface VersionActions {
  createVersion: (name: string, tracks: TimelineTrack[]) => string;
  switchVersion: (versionId: string) => TimelineTrack[];
  deleteVersion: (versionId: string) => void;
  renameVersion: (versionId: string, name: string) => void;
  updateVersionTracks: (versionId: string, tracks: TimelineTrack[]) => void;
  getActiveVersion: () => TimelineVersion | undefined;
}

export const useVersionStore = create<VersionState & VersionActions>()(
  immer((set, get) => ({
    versions: [],
    activeVersionId: null,

    createVersion: (name, tracks) => {
      const id = uuid();
      set((state) => {
        state.versions.push({
          id,
          name,
          createdAt: Date.now(),
          tracks: JSON.parse(JSON.stringify(tracks)),
        });
        state.activeVersionId = id;
      });
      return id;
    },

    switchVersion: (versionId) => {
      const version = get().versions.find((v) => v.id === versionId);
      if (!version) return [];
      set({ activeVersionId: versionId });
      return JSON.parse(JSON.stringify(version.tracks));
    },

    deleteVersion: (versionId) => {
      set((state) => {
        state.versions = state.versions.filter((v) => v.id !== versionId);
        if (state.activeVersionId === versionId) {
          state.activeVersionId = state.versions[0]?.id ?? null;
        }
      });
    },

    renameVersion: (versionId, name) => {
      set((state) => {
        const v = state.versions.find((v) => v.id === versionId);
        if (v) v.name = name;
      });
    },

    updateVersionTracks: (versionId, tracks) => {
      set((state) => {
        const v = state.versions.find((v) => v.id === versionId);
        if (v) v.tracks = JSON.parse(JSON.stringify(tracks));
      });
    },

    getActiveVersion: () => {
      const { versions, activeVersionId } = get();
      return versions.find((v) => v.id === activeVersionId);
    },
  }))
);
