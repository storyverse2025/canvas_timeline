/**
 * searchNodes: find canvas nodes whose item prompt matches a query.
 *
 * Walks every canvas-store node, joins to the canvas-item it references
 * (via node.data.itemId), then matches against the query predicate.
 * Synonym expansion happens here, not in the caller — agents pass the
 * user's literal phrase and the matcher figures out the variants.
 *
 * Pure read — no mutations. Safe to call from anywhere (PM agent,
 * Director agent, external MCP tool).
 */

import { useCanvasStore } from '@/stores/canvas-store';
import { useCanvasItemStore } from '@/stores/canvas-item-store';
import { useStoryboardStore } from '@/stores/storyboard-store';
import type { CanvasItem } from '@/stores/canvas-item-store';
import type { StoryboardRow } from '@/types/storyboard';
import { expandTerms } from './synonyms';
import type { NodeMatch, NodeQuery, StoryboardBinding } from './types';

const PROMPT_PREVIEW_CHARS = 200;

/**
 * Walk every storyboard row, build a map from nodeId →
 * StoryboardBinding[]. A single node can be referenced by multiple
 * rows (a character reused across shots) or by multiple slots in the
 * same row (rare but legal), so the value is an array.
 */
function buildNodeToBindings(rows: StoryboardRow[]): Map<string, StoryboardBinding[]> {
  const m = new Map<string, StoryboardBinding[]>();
  const push = (nodeId: string | undefined, b: StoryboardBinding) => {
    if (!nodeId) return;
    const arr = m.get(nodeId) ?? [];
    arr.push(b);
    m.set(nodeId, arr);
  };
  for (const row of rows) {
    push(row.keyframeNodeId, { rowId: row.id, shotNumber: row.shot_number, field: 'keyframe' });
    push(row.beatVideoNodeId, { rowId: row.id, shotNumber: row.shot_number, field: 'beatVideo' });
    push(row.character1?.nodeId, { rowId: row.id, shotNumber: row.shot_number, field: 'character1' });
    push(row.character2?.nodeId, { rowId: row.id, shotNumber: row.shot_number, field: 'character2' });
    push(row.prop1?.nodeId, { rowId: row.id, shotNumber: row.shot_number, field: 'prop1' });
    push(row.prop2?.nodeId, { rowId: row.id, shotNumber: row.shot_number, field: 'prop2' });
    push(row.scene?.nodeId, { rowId: row.id, shotNumber: row.shot_number, field: 'scene' });
  }
  return m;
}

/**
 * Find which of `terms` appear as substrings inside `haystack`. Returns
 * the matching subset. Empty result = no match. All comparison is
 * case-folded; haystack is lowercased once by the caller for efficiency.
 */
function findMatchingTerms(haystackLower: string, terms: string[]): string[] {
  if (!haystackLower) return [];
  const hits: string[] = [];
  for (const t of terms) if (haystackLower.includes(t)) hits.push(t);
  return hits;
}

export function searchNodes(query: NodeQuery): NodeMatch[] {
  const nodes = useCanvasStore.getState().nodes;
  const items = useCanvasItemStore.getState().items;
  const rows = useStoryboardStore.getState().rows;

  // Expand query terms once. Empty promptContains means "match all
  // (subject to other filters)".
  const expandedTerms = (() => {
    if (!query.promptContains || query.promptContains.length === 0) return [];
    if (query.expandSynonyms === false) return query.promptContains.map((t) => t.toLowerCase());
    return expandTerms(query.promptContains);
  })();

  const kindSet = query.kinds && query.kinds.length ? new Set(query.kinds) : null;
  const roleSet = query.roles && query.roles.length ? new Set(query.roles) : null;
  const rowSet = query.rowIds && query.rowIds.length ? new Set(query.rowIds) : null;
  const bindings = buildNodeToBindings(rows);

  const out: NodeMatch[] = [];
  for (const node of nodes) {
    const itemId = (node.data?.itemId as string | undefined) ?? undefined;
    if (!itemId) continue;
    const item: CanvasItem | undefined = items[itemId];
    if (!item) continue;

    if (kindSet && !kindSet.has(item.kind)) continue;
    if (roleSet && (!item.role || !roleSet.has(item.role))) continue;

    const nodeBindings = bindings.get(node.id) ?? [];
    if (rowSet) {
      const inAnyRow = nodeBindings.some((b) => rowSet.has(b.rowId));
      if (!inAnyRow) continue;
    }

    let matchedTerms: string[] = [];
    if (expandedTerms.length > 0) {
      const haystack = (item.prompt ?? '').toLowerCase();
      matchedTerms = findMatchingTerms(haystack, expandedTerms);
      if (matchedTerms.length === 0) continue;
    }

    const promptPreview = (item.prompt ?? '').slice(0, PROMPT_PREVIEW_CHARS);
    out.push({
      nodeId: node.id,
      itemId: item.id,
      kind: item.kind,
      role: item.role,
      name: item.name,
      promptPreview,
      content: item.content,
      matchedTerms,
      storyboardBindings: nodeBindings,
    });
    if (query.limit && out.length >= query.limit) break;
  }
  return out;
}
