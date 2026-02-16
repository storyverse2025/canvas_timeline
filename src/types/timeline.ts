export type TrackType = 'script' | 'visual' | 'audio';

export interface Shot {
  id: string;
  label: string;
  duration: number; // 5-15 seconds
  linkedNodeIds: string[]; // canvas node IDs linked to this shot
  startTime: number; // auto-calculated from cumulative durations
  color?: string;
  data?: Record<string, unknown>;
}

// Keep for backward compat with version store
export interface TimelineItem {
  id: string;
  trackId: string;
  type: TrackType;
  startTime: number;
  duration: number;
  label: string;
  color?: string;
  data?: Record<string, unknown>;
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

export interface TimelineState {
  shots: Shot[];
  playheadTime: number;
  duration: number;
  zoom: number;
  isPlaying: boolean;
  snapEnabled: boolean;
  snapInterval: number;
}
