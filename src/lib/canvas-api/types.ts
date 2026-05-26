/**
 * canvas-api types.
 *
 * The canvas-api is the single read/write surface that PM agent, Director
 * agent, and external agents (Hermes, Claude Code via MCP) all share when
 * fetching or mutating canvas content. Agents must NOT touch
 * useCanvasStore / useCanvasItemStore / useStoryboardStore directly;
 * everything goes through this module so versioning, search expansion,
 * and the future external bridge stay coherent.
 */

import type { CanvasItem, CanvasItemKind, CanvasItemRole } from '@/stores/canvas-item-store';
import type { StoryboardRow } from '@/types/storyboard';

/** Where a storyboard row references this node (keyframe, beat-video,
 *  or one of the five element slots). Empty if the node is free-floating
 *  on the canvas. */
export interface StoryboardBinding {
  rowId: string;
  shotNumber: string;
  field: 'keyframe' | 'beatVideo' | 'character1' | 'character2' | 'prop1' | 'prop2' | 'scene';
}

/** Search predicate. All present fields AND together; arrays inside a
 *  field OR together (so promptContains:['gun','revolver'] matches a
 *  node whose prompt has *either* word). */
export interface NodeQuery {
  /** Case-insensitive substring match against `item.prompt`. Each term
   *  expands through the synonym dictionary unless `expandSynonyms`
   *  is false. */
  promptContains?: string[];
  /** Skip synonym expansion — match the literal terms only. */
  expandSynonyms?: boolean;
  /** Restrict to these item kinds. */
  kinds?: CanvasItemKind[];
  /** Restrict to these semantic roles. */
  roles?: CanvasItemRole[];
  /** Restrict to nodes referenced by these storyboard row ids. */
  rowIds?: string[];
  /** Hard cap on returned matches. Default unlimited. */
  limit?: number;
}

/** One match from searchNodes. `matchedTerms` is the subset of the
 *  expanded query terms that actually appeared in the prompt — surfaces
 *  to the user so they can confirm the filter caught the right shots. */
export interface NodeMatch {
  nodeId: string;
  itemId: string;
  kind: CanvasItemKind;
  role?: CanvasItemRole;
  name: string;
  /** Truncated prompt for UI preview (~200 chars). */
  promptPreview: string;
  /** Image / video / audio URL or text content. */
  content: string;
  matchedTerms: string[];
  storyboardBindings: StoryboardBinding[];
}

/** Full detail for one node — what an agent gets back after a mutation
 *  or when it calls getNode(id). Includes the full item (with prompt +
 *  refs + versions), the underlying canvas-store node id, and any
 *  storyboard rows that reference it. */
export interface NodeDetail {
  nodeId: string;
  item: CanvasItem;
  position: { x: number; y: number };
  storyboardBindings: StoryboardBinding[];
}

/** Whole-canvas snapshot. Lightweight by default — does not inline image
 *  data URLs, just URLs/lengths. Agents call getNode(id) for full content. */
export interface CanvasSnapshot {
  nodeCount: number;
  itemCount: number;
  storyboardRowCount: number;
  /** Distribution of items by kind (image/text/video/audio counts). */
  kindHistogram: Record<CanvasItemKind, number>;
  /** Distribution of items by role. */
  roleHistogram: Record<string, number>;
  /** Storyboard rows with their shot numbers — useful for an agent
   *  building a plan ("regenerate all keyframes after shot 5"). */
  rows: Array<Pick<StoryboardRow, 'id' | 'shot_number' | 'duration' | 'status' | 'keyframeNodeId' | 'beatVideoNodeId'>>;
}

/** Spec for canvasApi.addNode. Either supply existing item content or
 *  let the API allocate a fresh item id. Position defaults to top-left
 *  of the canvas if omitted. */
export interface AddNodeSpec {
  kind: CanvasItemKind;
  name: string;
  content: string;
  role?: CanvasItemRole;
  prompt?: string;
  refImages?: string[];
  refAudios?: string[];
  provider?: string;
  model?: string;
  position?: { x: number; y: number };
}

/** updateNodePrompt input — either a literal replacement, or a string
 *  rewriter function. Function form lets the Director agent rewrite N
 *  prompts in a single call without round-tripping the old prompt to
 *  itself first. */
export type PromptPatch =
  | { type: 'replace'; prompt: string }
  | { type: 'rewrite'; rewrite: (oldPrompt: string) => string };

/** regenerateImage options. If `prompt` is omitted, the current item
 *  prompt is reused (useful for "shake the dice" regeneration). If
 *  `provider`/`model` is omitted the keyframe defaults
 *  (openai/gpt-image-2) are used. */
export interface RegenerateImageOptions {
  prompt?: string;
  refImageUrls?: string[];
  provider?: string;
  model?: string;
  aspect?: string;
}
