/**
 * canvas-api: the single read/write surface for canvas content.
 *
 * Read   : getSnapshot, searchNodes, getNode
 * Write  : addNode, updateNodePrompt, setKeyframe
 * Action : regenerateImage
 *
 * Versioning is automatic: every write that overwrites `content` or
 * `prompt` stores the prior head in `item.versions[]` (newest first).
 *
 * PM agent, Director agent, and the (future) MCP bridge all call into
 * this module instead of touching useCanvasStore / useCanvasItemStore /
 * useStoryboardStore directly. That guarantees: (a) one search dialect
 * with synonym expansion, (b) one versioning policy, (c) one place to
 * later add permission gates / external-agent dry-run mode.
 */

export { getSnapshot, getNode } from './snapshot';
export { searchNodes } from './search';
export {
  updateNodePrompt,
  regenerateImage,
  addNode,
  setKeyframe,
  CanvasApiError,
} from './mutations';
export { expandTerm, expandTerms, SYNONYM_GROUPS } from './synonyms';
export type {
  NodeQuery,
  NodeMatch,
  NodeDetail,
  CanvasSnapshot,
  StoryboardBinding,
  AddNodeSpec,
  PromptPatch,
  RegenerateImageOptions,
} from './types';
