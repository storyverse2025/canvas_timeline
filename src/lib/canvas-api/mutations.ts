/**
 * Versioned mutation layer.
 *
 * Every write that changes `content` or `prompt` first snapshots the
 * current item head into `versions[]` (newest first), then applies the
 * patch. Agents never lose a generation — the user can roll back via
 * the version stack.
 *
 * regenerateImage and regenerateVideo wrap runCapability with the
 * standard keyframe/video defaults but accept overrides. They return
 * the fresh NodeDetail so the caller can immediately diff old vs new
 * (the old head is the top of versions[]).
 */

import { useCanvasStore } from '@/stores/canvas-store';
import { useCanvasItemStore } from '@/stores/canvas-item-store';
import { useStoryboardStore } from '@/stores/storyboard-store';
import type { CanvasItem, CanvasItemVersion } from '@/stores/canvas-item-store';
import { runCapability } from '@/lib/capabilities/client';
import { getNode } from './snapshot';
import type {
  AddNodeSpec,
  NodeDetail,
  PromptPatch,
  RegenerateImageOptions,
} from './types';

// Keyframe defaults mirror director-agent/index.ts. We pin the same
// provider/model so canvas-api regenerations are visually consistent
// with director-agent-generated keyframes (same backend, same style
// bias). Override via RegenerateImageOptions when a caller wants
// something else.
const KEYFRAME_PROVIDER = 'openai';
const KEYFRAME_MODEL = 'gpt-image-2';

class CanvasApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasApiError';
  }
}

/** Snapshot the current item head into a CanvasItemVersion. Pure — caller
 *  pushes the result onto versions[] inside an immer update. */
function snapshotHead(item: CanvasItem): CanvasItemVersion {
  return {
    content: item.content,
    prompt: item.prompt,
    refImages: item.refImages,
    refAudios: item.refAudios,
    provider: item.provider,
    model: item.model,
    timestamp: Date.now(),
  };
}

/** Resolve a NodeDetail or throw. Used by every mutation as the first
 *  step so we get a consistent error shape. */
function requireNode(nodeId: string): NodeDetail {
  const detail = getNode(nodeId);
  if (!detail) throw new CanvasApiError(`node ${nodeId} not found or has no item binding`);
  return detail;
}

/**
 * Replace an item's prompt without touching its content. Used by the
 * Director agent when it rewrites prompts in bulk before regenerating
 * (so a user can review the proposed prompts before triggering the
 * image calls).
 */
export function updateNodePrompt(nodeId: string, patch: PromptPatch): NodeDetail {
  const detail = requireNode(nodeId);
  const newPrompt = patch.type === 'replace' ? patch.prompt : patch.rewrite(detail.item.prompt ?? '');
  if (newPrompt === (detail.item.prompt ?? '')) return detail;

  const version = snapshotHead(detail.item);
  useCanvasItemStore.setState((s) => {
    const it = s.items[detail.item.id];
    if (!it) return;
    it.versions = [version, ...(it.versions ?? [])];
    it.prompt = newPrompt;
  });
  return requireNode(nodeId);
}

/**
 * Call text-to-image with the (possibly updated) prompt + refs, then
 * commit the new url to the item's content. The prior head goes to
 * versions[]. Throws CanvasApiError if the capability returns no url
 * — state is left untouched in that case (we snapshot only after the
 * call succeeds).
 */
export async function regenerateImage(
  nodeId: string,
  opts: RegenerateImageOptions = {},
): Promise<NodeDetail> {
  const detail = requireNode(nodeId);
  if (detail.item.kind !== 'image') {
    throw new CanvasApiError(`regenerateImage requires kind=image, got ${detail.item.kind}`);
  }
  const prompt = opts.prompt ?? detail.item.prompt;
  if (!prompt) throw new CanvasApiError(`node ${nodeId}: no prompt available for regeneration`);

  const refs = opts.refImageUrls ?? detail.item.refImages ?? [];
  const r = await runCapability({
    capability: 'text-to-image',
    inputs: [
      { kind: 'text', text: prompt },
      ...refs.map((url) => ({ kind: 'image' as const, url })),
    ],
    params: {
      provider: opts.provider ?? KEYFRAME_PROVIDER,
      model: opts.model ?? KEYFRAME_MODEL,
      aspect: opts.aspect ?? '16:9',
      quality: 'hd',
      resolution: '4k',
    },
  });
  const url = r.outputs[0]?.url;
  if (!url) throw new CanvasApiError(`node ${nodeId}: text-to-image returned no url`);

  // Re-read latest item: prompt may have been updated between
  // requireNode and now (rare in a single-user UI but possible if
  // another agent ran in parallel).
  const latest = useCanvasItemStore.getState().items[detail.item.id];
  if (!latest) throw new CanvasApiError(`node ${nodeId}: item disappeared mid-flight`);
  const version = snapshotHead(latest);

  useCanvasItemStore.setState((s) => {
    const it = s.items[detail.item.id];
    if (!it) return;
    it.versions = [version, ...(it.versions ?? [])];
    it.content = url;
    it.prompt = prompt;
    it.refImages = refs;
    it.provider = opts.provider ?? KEYFRAME_PROVIDER;
    it.model = opts.model ?? KEYFRAME_MODEL;
  });
  return requireNode(nodeId);
}

/**
 * Create a new item + canvas node in one call. Returns the new node id
 * via the NodeDetail. Position defaults to (40, 40) so the user can
 * find it; callers with layout context should pass an explicit position.
 */
export function addNode(spec: AddNodeSpec): NodeDetail {
  const itemId = useCanvasItemStore.getState().addItem({
    kind: spec.kind,
    name: spec.name,
    content: spec.content,
    role: spec.role,
    prompt: spec.prompt,
    refImages: spec.refImages,
    refAudios: spec.refAudios,
    provider: spec.provider,
    model: spec.model,
  });
  const position = spec.position ?? { x: 40, y: 40 };
  const nodeId = useCanvasStore.getState().addItemNode(itemId, spec.kind, position);
  const detail = getNode(nodeId);
  if (!detail) throw new CanvasApiError(`addNode: created node ${nodeId} but lookup failed`);
  return detail;
}

/**
 * Bind a canvas node as the keyframe for a storyboard row. The row's
 * keyframeUrl mirrors the item content so downstream consumers
 * (cinematographer, timeline export) that read the row directly stay
 * in sync.
 */
export function setKeyframe(rowId: string, nodeId: string): void {
  const detail = requireNode(nodeId);
  if (detail.item.kind !== 'image') {
    throw new CanvasApiError(`setKeyframe requires an image node, got ${detail.item.kind}`);
  }
  const rows = useStoryboardStore.getState().rows;
  const row = rows.find((r) => r.id === rowId);
  if (!row) throw new CanvasApiError(`storyboard row ${rowId} not found`);
  useStoryboardStore.getState().updateRow(rowId, {
    keyframeNodeId: nodeId,
    keyframeUrl: detail.item.content,
  });
}

export { CanvasApiError };
