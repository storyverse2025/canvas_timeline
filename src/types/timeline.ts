export type TrackType = 'keyframe' | 'bgm' | 'dialogue' | 'video';

/** @deprecated Use Track/TrackItem instead */
export interface Shot {
  id: string;
  label: string;
  duration: number; // 5-15 seconds
  linkedNodeIds: string[]; // canvas node IDs linked to this shot
  startTime: number; // auto-calculated from cumulative durations
  color?: string;
  data?: Record<string, unknown>;
}

export interface TimelineItem {
  id: string;
  trackId: string;
  type: TrackType;
  startTime: number;
  duration: number;
  label: string;
  color?: string;
  data?: Record<string, unknown>;
  assetId?: string;
  /** @deprecated use assetId instead */
  canvasNodeId?: string;
  locked?: boolean;
}

export interface TimelineTrack {
  id: string;
  type: TrackType;
  label: string;
  muted?: boolean;
  locked?: boolean;
  items: TimelineItem[];
}

export interface TimelineVersion {
  id: string;
  name: string;
  createdAt: number;
  tracks: TimelineTrack[];
  backendVersionId?: string;
}

export interface Track {
  id: string;
  type: TrackType;
  label: string;
  muted?: boolean;
  locked?: boolean;
  items: TimelineItem[];
}

export interface TimelineState {
  tracks: Track[];
  playheadTime: number;
  duration: number;
  zoom: number;
  isPlaying: boolean;
  snapEnabled: boolean;
  snapInterval: number;
}
