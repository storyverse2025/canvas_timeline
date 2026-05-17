import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createIdbStorage } from '@/lib/storage/idb-storage';
import { v4 as uuid } from 'uuid';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { Node, Edge, NodeChange, EdgeChange } from '@xyflow/react';
import type { CanvasNodeData, CanvasNodeType } from '@/types/canvas';
import type { CanvasItemKind } from '@/stores/canvas-item-store';

// Handle ids declared by each node type. Image/Text/Video/Audio render via
// ImageCanvasNode + TextCanvasNode, which expose named handles (r/b source,
// t/l target). Other node types (asset, script, visual, …) declare unnamed
// handles. An edge whose sourceHandle / targetHandle doesn't match the
// referenced node's set will fail to render and ReactFlow logs the warning
// "Couldn't create edge for source handle id …". This map drives the
// cleanup pass below.
const NAMED_SOURCE_HANDLES: Record<string, ReadonlySet<string>> = {
  image: new Set(['r', 'b']),
  video: new Set(['r', 'b']),
  audio: new Set(['r', 'b']),
  text:  new Set(['r', 'b']),
};
const NAMED_TARGET_HANDLES: Record<string, ReadonlySet<string>> = {
  image: new Set(['t', 'l']),
  video: new Set(['t', 'l']),
  audio: new Set(['t', 'l']),
  text:  new Set(['t', 'l']),
};

/**
 * Sweep edges, removing orphans (source/target node gone) and stripping
 * handle ids that don't exist on the referenced node's type. Returns counts
 * for observability — caller decides whether to log. Pure / safe to test.
 */
export function pruneOrphanEdges(state: { nodes: Node<CanvasNodeGeometry>[]; edges: Edge[] }): {
  removed: number;
  strippedHandles: number;
} {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  let removed = 0;
  let strippedHandles = 0;
  const next: Edge[] = [];
  for (const e of state.edges) {
    const src = byId.get(e.source);
    const tgt = byId.get(e.target);
    if (!src || !tgt) { removed++; continue; }
    let edge: Edge = e;
    const srcSet = NAMED_SOURCE_HANDLES[src.type ?? ''];
    if (edge.sourceHandle && !srcSet?.has(edge.sourceHandle)) {
      const { sourceHandle: _drop, ...rest } = edge;
      edge = rest;
      strippedHandles++;
    }
    const tgtSet = NAMED_TARGET_HANDLES[tgt.type ?? ''];
    if (edge.targetHandle && !tgtSet?.has(edge.targetHandle)) {
      const { targetHandle: _drop, ...rest } = edge;
      edge = rest;
      strippedHandles++;
    }
    next.push(edge);
  }
  state.edges = next;
  return { removed, strippedHandles };
}

/** Data stored per canvas node — reference to asset or free-form item */
export interface CanvasNodeGeometry extends Record<string, unknown> {
  assetId?: string;
  itemId?: string;
}

interface CanvasState {
  nodes: Node<CanvasNodeGeometry>[];
  edges: Edge[];
  selectedNodeIds: string[];
}

interface CanvasActions {
  addNode: {
    (assetId: string, position: { x: number; y: number }): string;
    (type: CanvasNodeType, data: CanvasNodeData, position: { x: number; y: number }): string;
  };
  addItemNode: (itemId: string, kind: CanvasItemKind, position: { x: number; y: number }, size?: { width: number; height: number }) => string;
  removeNode: (id: string) => void;
  updateNode: (id: string, data: Partial<CanvasNodeGeometry>) => void;
  setNodes: (nodes: Node<CanvasNodeGeometry>[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange<Node<CanvasNodeGeometry>>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  addEdge: (
    sourceId: string,
    targetId: string,
    /** Source handle id. Defaults to 'r' (the right-side source handle on
     *  ImageCanvasNode + TextCanvasNode). Pass null only when connecting
     *  to nodes that don't declare named handles. */
    sourceHandle?: string | null,
    /** Target handle id. Defaults to 'l' (left-side target on image/text). */
    targetHandle?: string | null,
  ) => void;
  getNodeById: (id: string) => Node<CanvasNodeGeometry> | undefined;
  getNodeByAssetId: (assetId: string) => Node<CanvasNodeGeometry> | undefined;
  removeNodeByAssetId: (assetId: string) => void;
  clearAll: () => void;
}

export const useCanvasStore = create<CanvasState & CanvasActions>()(
  persist(
    immer((set, get) => ({
      nodes: [],
      edges: [],
      selectedNodeIds: [],

      addNode: (typeOrAssetId: string, dataOrPosition: CanvasNodeData | { x: number; y: number }, maybePosition?: { x: number; y: number }) => {
        const id = uuid();
        set((state) => {
          if (maybePosition) {
            state.nodes.push({
              id,
              type: typeOrAssetId,
              position: maybePosition,
              data: dataOrPosition as CanvasNodeGeometry,
            });
          } else {
            state.nodes.push({
              id,
              type: 'asset',
              position: dataOrPosition as { x: number; y: number },
              data: { assetId: typeOrAssetId },
            });
          }
        });
        return id;
      },

      addItemNode: (itemId, kind, position, size) => {
        const id = uuid();
        const width = size?.width ?? (kind === 'video' ? 360 : kind === 'image' ? 240 : 260);
        const height = size?.height ?? (kind === 'video' ? 200 : kind === 'image' ? 180 : 140);
        set((state) => {
          state.nodes.push({
            id,
            type: kind,
            position,
            data: { itemId },
            width,
            height,
            style: { width, height },
          });
        });
        return id;
      },

      removeNode: (id) => {
        set((state) => {
          state.nodes = state.nodes.filter((n) => n.id !== id);
          state.edges = state.edges.filter((e) => e.source !== id && e.target !== id);
          state.selectedNodeIds = state.selectedNodeIds.filter((sid) => sid !== id);
        });
      },

      updateNode: (id, data) => {
        set((state) => {
          const node = state.nodes.find((n) => n.id === id);
          if (node) node.data = { ...node.data, ...data };
        });
      },

      setNodes: (nodes) => set({ nodes }),
      setEdges: (edges) => set({ edges }),

      onNodesChange: (changes) => {
        set((state) => {
          state.nodes = applyNodeChanges(changes, state.nodes) as Node<CanvasNodeGeometry>[];
        });
      },

      onEdgesChange: (changes) => {
        set((state) => {
          state.edges = applyEdgeChanges(changes, state.edges);
        });
      },

      setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

      addEdge: (sourceId, targetId, sourceHandle, targetHandle) => {
        // Defaults match the handle ids declared on ImageCanvasNode +
        // TextCanvasNode — the two node types most edges connect. Without
        // these, ReactFlow logs "Couldn't create edge for source handle id
        // null" and the edge fails to render.
        const sh = sourceHandle === undefined ? 'r' : sourceHandle;
        const th = targetHandle === undefined ? 'l' : targetHandle;
        set((state) => {
          const exists = state.edges.some(
            (e) =>
              e.source === sourceId &&
              e.target === targetId &&
              (e.sourceHandle ?? null) === (sh ?? null) &&
              (e.targetHandle ?? null) === (th ?? null),
          );
          if (!exists) {
            state.edges.push({
              id: `e-${uuid()}`,
              source: sourceId,
              target: targetId,
              ...(sh !== null ? { sourceHandle: sh } : {}),
              ...(th !== null ? { targetHandle: th } : {}),
            });
          }
        });
      },

      getNodeById: (id) => get().nodes.find((n) => n.id === id),
      getNodeByAssetId: (assetId) => get().nodes.find((n) => n.data.assetId === assetId),

      removeNodeByAssetId: (assetId) => {
        set((state) => {
          const node = state.nodes.find((n) => n.data.assetId === assetId);
          if (!node) return;
          state.nodes = state.nodes.filter((n) => n.id !== node.id);
          state.edges = state.edges.filter((e) => e.source !== node.id && e.target !== node.id);
        });
      },

      clearAll: () => set({ nodes: [], edges: [], selectedNodeIds: [] }),
    })),
    {
      name: 'canvas-store',
      partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),
      storage: createJSONStorage(() => createIdbStorage('canvas-store')),
      // One-shot cleanup after IDB hydration: prune edges whose source or
      // target node is gone, and strip handle ids ReactFlow can't resolve.
      // Without this, legacy edges keep logging "Couldn't create edge for
      // source handle id …" every render.
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        const { removed, strippedHandles } = pruneOrphanEdges(state);
        if (removed || strippedHandles) {
          console.log(
            `[canvas-store] edge cleanup: removed ${removed} orphan(s), stripped ${strippedHandles} invalid handle(s)`,
          );
        }
      },
    }
  )
);
