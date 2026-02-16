import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Project, Episode, Character, Scene, Prop, Keyframe, VideoShot } from '@/types/backend';

interface ProjectState {
  project: Project | null;
  episodeIndex: number;
  episodes: Episode[];
  characters: Character[];
  scenes: Scene[];
  props: Prop[];
  keyframes: Keyframe[];
  shots: VideoShot[];
  isLoading: boolean;
}

interface ProjectActions {
  setProject: (project: Project | null) => void;
  setEpisodeIndex: (index: number) => void;
  setEpisodes: (episodes: Episode[]) => void;
  setCharacters: (characters: Character[]) => void;
  setScenes: (scenes: Scene[]) => void;
  setProps: (props: Prop[]) => void;
  setKeyframes: (keyframes: Keyframe[]) => void;
  setShots: (shots: VideoShot[]) => void;
  setIsLoading: (loading: boolean) => void;
  reset: () => void;
}

const initialState: ProjectState = {
  project: null,
  episodeIndex: 0,
  episodes: [],
  characters: [],
  scenes: [],
  props: [],
  keyframes: [],
  shots: [],
  isLoading: false,
};

export const useProjectStore = create<ProjectState & ProjectActions>()(
  immer((set) => ({
    ...initialState,
    setProject: (project) => set({ project }),
    setEpisodeIndex: (index) => set({ episodeIndex: index }),
    setEpisodes: (episodes) => set({ episodes }),
    setCharacters: (characters) => set({ characters }),
    setScenes: (scenes) => set({ scenes }),
    setProps: (props) => set({ props }),
    setKeyframes: (keyframes) => set({ keyframes }),
    setShots: (shots) => set({ shots }),
    setIsLoading: (loading) => set({ isLoading: loading }),
    reset: () => set(initialState),
  }))
);
