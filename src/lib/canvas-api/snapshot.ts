/**
 * Canvas snapshot + single-node lookup.
 *
 * getSnapshot() is intentionally lightweight — it does not inline
 * content URLs or full prompts. Agents use it for orientation
 * ("how many shots? how many keyframes done? what kinds of items?"),
 * then drill in with searchNodes() and getNode(id).
 */

import { useCanvasStore } from '@/stores/canvas-store';
import { useCanvasItemStore } from '@/stores/canvas-item-store';
import { useStoryboardStore } from '@/stores/storyboard-store';
import type { CanvasItem, CanvasItemKind } from '@/stores/canvas-item-store';
import type { StoryboardRow } from '@/types/storyboard';
import type { CanvasSnapshot, NodeDetail, StoryboardBinding } from './types';

function emptyKindHistogram(): Record<CanvasItemKind, number> {
  return { image: 0, text: 0, video: 0, audio: 0 };
}

export function getSnapshot(): CanvasSnapshot {
  const nodes = useCanvasStore.getState().nodes;
  const items = useCanvasItemStore.getState().items;
  const rows = useStoryboardStore.getState().rows;

  const kindHistogram = emptyKindHistogram();
  const roleHistogram: Record<string, number> = {};
  for (const item of Object.values(items)) {
    kindHistogram[item.kind]++;
    const r = item.role ?? '(unset)';
    roleHistogram[r] = (roleHistogram[r] ?? 0) + 1;
  }

  return {
    nodeCount: nodes.length,
    itemCount: Object.keys(items).length,
    storyboardRowCount: rows.length,
    kindHistogram,
    roleHistogram,
    rows: rows.map((r) => ({
      id: r.id,
      shot_number: r.shot_number,
      duration: r.duration,
      status: r.status,
      keyframeNodeId: r.keyframeNodeId,
      beatVideoNodeId: r.beatVideoNodeId,
    })),
  };
}

/**
 * Build the StoryboardBinding[] for one node by scanning all rows.
 * O(rows × 7 slots) per call — fine for typical projects (<200 rows)
 * but a hot loop should call buildNodeToBindings (in search.ts) once
 * and reuse the map.
 */
function bindingsForNode(nodeId: string, rows: StoryboardRow[]): StoryboardBinding[] {
  const out: StoryboardBinding[] = [];
  for (const row of rows) {
    if (row.keyframeNodeId === nodeId) out.push({ rowId: row.id, shotNumber: row.shot_number, field: 'keyframe' });
    if (row.beatVideoNodeId === nodeId) out.push({ rowId: row.id, shotNumber: row.shot_number, field: 'beatVideo' });
    if (row.character1?.nodeId === nodeId) out.push({ rowId: row.id, shotNumber: row.shot_number, field: 'character1' });
    if (row.character2?.nodeId === nodeId) out.push({ rowId: row.id, shotNumber: row.shot_number, field: 'character2' });
    if (row.prop1?.nodeId === nodeId) out.push({ rowId: row.id, shotNumber: row.shot_number, field: 'prop1' });
    if (row.prop2?.nodeId === nodeId) out.push({ rowId: row.id, shotNumber: row.shot_number, field: 'prop2' });
    if (row.scene?.nodeId === nodeId) out.push({ rowId: row.id, shotNumber: row.shot_number, field: 'scene' });
  }
  return out;
}

export function getNode(nodeId: string): NodeDetail | null {
  const nodes = useCanvasStore.getState().nodes;
  const items = useCanvasItemStore.getState().items;
  const rows = useStoryboardStore.getState().rows;

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const itemId = (node.data?.itemId as string | undefined) ?? undefined;
  if (!itemId) return null;
  const item: CanvasItem | undefined = items[itemId];
  if (!item) return null;

  return {
    nodeId: node.id,
    item,
    position: node.position,
    storyboardBindings: bindingsForNode(node.id, rows),
  };
}
