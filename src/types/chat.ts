export type AgentActionType =
  | 'generate_script'
  | 'generate_characters'
  | 'generate_scenes'
  | 'generate_props'
  | 'generate_keyframes'
  | 'generate_storyboard'
  | 'generate_shots'
  | 'auto_map'
  | 'edit_pipeline'
  | 'analyze'
  | 'add_to_canvas'
  | 'connect_timeline'
  | 'regenerate'
  | 'full_pipeline';

export interface AgentAction {
  type: AgentActionType;
  status: 'pending' | 'running' | 'success' | 'error';
  data?: Record<string, unknown>;
  canvasNodeIds?: string[];
  timelineItemIds?: string[];
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'action';
  content: string;
  timestamp: number;
  action?: AgentAction;
  thinking?: string;
}

export interface SkillProgress {
  step: number;
  total: number;
  label: string;
}
