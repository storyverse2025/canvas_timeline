// Auth
export interface AuthRegisterRequest { email: string; name: string; password: string; }
export interface AuthLoginRequest { username: string; password: string; }
export interface AuthResponse { access_token: string; token_type: string; }

// Project
export interface Project {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

// Script / Episode
export interface ScriptGenerateRequest {
  inspiration: string;
  file_ids?: string[];
  settings?: Record<string, unknown>;
}
export interface Episode {
  episode_number: number;
  title: string;
  content: string;
  beats: Beat[];
}
export interface Beat {
  number: number;
  duration_seconds: number;
  narration?: string;
  dialogues: Dialogue[];
  action?: string;
}
export interface Dialogue {
  speaker: string;
  text: string;
  emotion?: string;
}

// Characters
export interface Character {
  asset_id: string;
  asset_identifier: string;
  img_url?: string;
  prompt?: string;
  description?: string;
}
export interface CharacterGenerateRequest { episodes: Episode[]; language?: string; }

// Assets
export interface Asset {
  id: string;
  type: string;
  url: string;
  metadata?: Record<string, unknown>;
}

// Storyboard
export interface StoryboardFrame {
  id: string;
  beat_number: number;
  panel_count: number;
  image_url?: string;
  prompt?: string;
  status?: string;
}
export interface StoryboardCreateRequest {
  beat_number: number;
  prompt?: string;
  panel_count?: number;
}

// Keyframe
export interface Keyframe {
  id: string;
  beat_number: number;
  image_url?: string;
  prompt?: string;
  status?: string;
}

// Video Shot
export interface VideoShot {
  beat_number: number;
  duration_seconds: number;
  generation_prompt: string;
  dialogue?: string;
  shot_url?: string;
  reference_keyframe_url?: string;
}

// Scene
export interface Scene {
  id: string;
  name: string;
  description?: string;
  image_url?: string;
  prompt?: string;
}

// Prop
export interface Prop {
  id: string;
  name: string;
  description?: string;
  image_url?: string;
  prompt?: string;
}

// Edit Pipeline
export interface EditResult {
  id: string;
  status: string;
  video_url?: string;
  job_id?: string;
}

// Review
export interface ReviewNote {
  id: string;
  content: string;
  timecode?: number;
  status: 'open' | 'resolved';
  created_at: string;
  replies?: ReviewReply[];
  version_id?: string;
}
export interface ReviewReply {
  id: string;
  content: string;
  created_at: string;
}

// Version
export interface Version {
  id: string;
  name: string;
  created_at: string;
  is_current: boolean;
  data?: Record<string, unknown>;
}
export interface VersionDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

// AI Agents
export interface AiChatRequest {
  agent_type: string;
  message: string;
  context?: Record<string, unknown>;
}
export interface AiChatResponse {
  response: string;
  suggestions?: AiSuggestion[];
}
export interface AiIssue {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  resolved: boolean;
  fix_suggestion?: string;
}
export interface AiSuggestion {
  id: string;
  agent_type: string;
  description: string;
  status: 'pending' | 'applied' | 'dismissed';
  data?: Record<string, unknown>;
}

// Template
export interface Template {
  id: string;
  name: string;
  category: string;
  description?: string;
  thumbnail_url?: string;
}

// Job
export interface JobStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  result_url?: string;
  error?: string;
}

// Upload
export interface UploadResponse {
  file_id: string;
  url: string;
  filename: string;
}
