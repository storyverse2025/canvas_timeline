export type MediaKind = 'image' | 'video' | 'audio'
export type ProviderId = 'libtv' | 'fal' | 'doubao' | 'openai' | 'gemini'

export interface ModelSpec {
  id: string;
  label: string;
  kind: MediaKind;
  supportsRef?: boolean;
  supportsVideo?: boolean;
  /** Supported resolutions for video models */
  resolutions?: string[];
  /** Supported durations for video models */
  durations?: number[];
  /** Supports audio generation */
  supportsAudio?: boolean;
  /** Supports first+last frame */
  supportsFirstLastFrame?: boolean;
}

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  models: ModelSpec[];
  envVar: string;
}

export interface GenerateRequest {
  provider: ProviderId;
  model: string;
  prompt: string;
  refImages?: string[];
  aspect?: string;
  duration?: number;
  // Advanced parameters
  negativePrompt?: string;
  seed?: number;
  guidanceScale?: number;
  resolution?: string;
  generateAudio?: boolean;
  numImages?: number;
  fps?: number;
}

export interface GenerateResponse {
  url: string;
  kind: MediaKind;
  /** Multiple outputs for batch generation */
  urls?: string[];
  raw?: unknown;
}
