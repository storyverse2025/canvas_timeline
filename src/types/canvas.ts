export interface Tag {
  id: string;
  category: 'character' | 'scene' | 'prop' | 'beat' | 'custom';
  label: string;
  color?: string;
}

export interface ScriptNodeData {
  [key: string]: unknown;
  scriptType: 'dialogue' | 'narration' | 'action' | 'direction';
  content: string;
  characterName?: string;
  beatNumber?: number;
  tags: Tag[];
}

export interface ImageVersion {
  url: string;
  timestamp: number;
}

export interface VisualAssetNodeData {
  [key: string]: unknown;
  assetType: 'character' | 'scene' | 'prop' | 'keyframe' | 'storyboard' | 'video';
  imageUrl?: string;
  thumbnailUrl?: string;
  sourceId?: string;
  label: string;
  prompt?: string;
  versions?: ImageVersion[];
  tags: Tag[];
  videoUrl?: string;
  status?: 'pending' | 'generating' | 'completed' | 'failed';
}

export interface AudioBlockNodeData {
  [key: string]: unknown;
  audioType: 'dialogue' | 'sfx' | 'bgm' | 'voiceover';
  audioUrl?: string;
  duration: number;
  label: string;
  waveformData?: number[];
  tags: Tag[];
}

export type CanvasNodeData = ScriptNodeData | VisualAssetNodeData | AudioBlockNodeData;
export type CanvasNodeType = 'script' | 'visual' | 'audio';
