import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { v4 as uuid } from 'uuid';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { Node, Edge, NodeChange, EdgeChange } from '@xyflow/react';

/** Data stored per canvas node — reference to asset or free-form item */
export interface CanvasNodeGeometry {
  assetId?: string;
  itemId?: string;
}

interface CanvasState {
  nodes: Node<CanvasNodeGeometry>[];
  edges: Edge[];
  selectedNodeIds: string[];
}

interface CanvasActions {
  addNode: (assetId: string, position: { x: number; y: number }) => string;
  addItemNode: (itemId: string, kind: 'image' | 'text', position: { x: number; y: number }, size?: { width: number; height: number }) => string;
  removeNode: (id: string) => void;
  setNodes: (nodes: Node<CanvasNodeGeometry>[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange<Node<CanvasNodeGeometry>>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  addEdge: (sourceId: string, targetId: string) => void;
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

      addNode: (assetId, position) => {
        const id = uuid();
        set((state) => {
          state.nodes.push({ id, type: 'asset', position, data: { assetId } });
        });
        return id;
      },

      addItemNode: (itemId, kind, position, size) => {
        const id = uuid();
        const width = size?.width ?? (kind === 'image' ? 240 : 260);
        const height = size?.height ?? (kind === 'image' ? 180 : 140);
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

      addEdge: (sourceId, targetId) => {
        set((state) => {
          const exists = state.edges.some((e) => e.source === sourceId && e.target === targetId);
          if (!exists) {
            state.edges.push({ id: `e-${uuid()}`, source: sourceId, target: targetId });
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
    }
  )
);
