import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { v4 as uuid } from 'uuid';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { Node, Edge, NodeChange, EdgeChange } from '@xyflow/react';
import type { Tag, CanvasNodeData, CanvasNodeType } from '@/types/canvas';

interface CanvasState {
  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  selectedNodeIds: string[];
}

interface CanvasActions {
  addNode: (type: CanvasNodeType, data: CanvasNodeData, position: { x: number; y: number }) => string;
  updateNode: (id: string, data: Partial<CanvasNodeData>) => void;
  removeNode: (id: string) => void;
  setNodes: (nodes: Node<CanvasNodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange<Node<CanvasNodeData>>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  addTag: (nodeId: string, tag: Omit<Tag, 'id'>) => void;
  removeTag: (nodeId: string, tagId: string) => void;
  addEdge: (sourceId: string, targetId: string) => void;
  getNodeById: (id: string) => Node<CanvasNodeData> | undefined;
  clearAll: () => void;
}

export const useCanvasStore = create<CanvasState & CanvasActions>()(
  persist(
  immer((set, get) => ({
    nodes: [],
    edges: [],
    selectedNodeIds: [],

    addNode: (type, data, position) => {
      const id = uuid();
      set((state) => {
        state.nodes.push({ id, type, position, data } as Node<CanvasNodeData>);
      });
      return id;
    },

    updateNode: (id, data) => {
      set((state) => {
        const node = state.nodes.find((n) => n.id === id);
        if (node) Object.assign(node.data, data);
      });
    },

    removeNode: (id) => {
      set((state) => {
        state.nodes = state.nodes.filter((n) => n.id !== id);
        state.edges = state.edges.filter((e) => e.source !== id && e.target !== id);
      });
    },

    setNodes: (nodes) => set({ nodes }),
    setEdges: (edges) => set({ edges }),

    onNodesChange: (changes) => {
      set((state) => {
        state.nodes = applyNodeChanges(changes, state.nodes) as Node<CanvasNodeData>[];
      });
    },

    onEdgesChange: (changes) => {
      set((state) => {
        state.edges = applyEdgeChanges(changes, state.edges);
      });
    },

    setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

    addTag: (nodeId, tag) => {
      set((state) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node && 'tags' in node.data) {
          (node.data as { tags: Tag[] }).tags.push({ ...tag, id: uuid() });
        }
      });
    },

    removeTag: (nodeId, tagId) => {
      set((state) => {
        const node = state.nodes.find((n) => n.id === nodeId);
        if (node && 'tags' in node.data) {
          const d = node.data as { tags: Tag[] };
          d.tags = d.tags.filter((t) => t.id !== tagId);
        }
      });
    },

    addEdge: (sourceId, targetId) => {
      set((state) => {
        const exists = state.edges.some((e) => e.source === sourceId && e.target === targetId);
        if (!exists) {
          state.edges.push({ id: `e-${uuid()}`, source: sourceId, target: targetId });
        }
      });
    },

    getNodeById: (id) => get().nodes.find((n) => n.id === id),

    clearAll: () => set({ nodes: [], edges: [], selectedNodeIds: [] }),
  })),
  {
    name: 'canvas-store',
    partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),
  }
  )
);
