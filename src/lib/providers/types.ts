export type MediaKind = 'image' | 'video' | 'audio'
export type ProviderId = 'libtv' | 'fal' | 'doubao' | 'openai' | 'gemini'

export interface ModelSpec {
  id: string;              // provider-specific model identifier
  label: string;           // user-facing label
  kind: MediaKind;
  /** Accepts reference image URLs in addition to a text prompt */
  supportsRef?: boolean;
  supportsVideo?: boolean;
}

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  models: ModelSpec[];
  /** If the env var is missing at runtime, the provider is disabled. */
  envVar: string;
}

export interface GenerateRequest {
  provider: ProviderId;
  model: string;
  prompt: string;
  refImages?: string[];
  aspect?: string; // e.g. '16:9', '1:1'
  /** Video duration in seconds (provider-dependent). */
  duration?: number;
}

export interface GenerateResponse {
  url: string;
  kind: MediaKind;
  raw?: unknown;
}
