import type { Tag, ImageVersion } from './canvas';

export type AssetType = 'character' | 'scene' | 'prop' | 'keyframe';

export interface Asset {
  id: string;
  type: AssetType;
  name: string;
  description?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  tags: Tag[];
  position?: { x: number; y: number };
  prompt?: string;
  sourceId?: string;
  status?: 'pending' | 'generating' | 'completed' | 'failed';
  versions?: ImageVersion[];
  createdAt: number;
}
