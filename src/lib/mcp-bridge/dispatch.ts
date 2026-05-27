/**
 * Pure RPC dispatcher: tool name + args → canvas-api result.
 *
 * Kept separate from the WS layer so tests can verify routing,
 * argument normalization, and error shaping without spinning up a
 * server. The WS wrapper in browser.ts is a thin pump:
 * onmessage → dispatch → postMessage.
 *
 * Every tool name here mirrors a tool defined in
 * canvas-mcp-server.mjs's TOOLS array. Add a tool? Edit both files.
 */

import {
  getSnapshot,
  getNode,
  searchNodes,
  addNode,
  updateNodePrompt,
  regenerateImage,
  setKeyframe,
  CanvasApiError,
} from '@/lib/canvas-api';
import type {
  AddNodeSpec,
  NodeQuery,
  RegenerateImageOptions,
} from '@/lib/canvas-api';

/** Names match the MCP TOOLS catalog. Keep both lists in sync. */
export type ToolName =
  | 'canvas_get_snapshot'
  | 'canvas_search_nodes'
  | 'canvas_get_node'
  | 'canvas_add_node'
  | 'canvas_update_node_prompt'
  | 'canvas_regenerate_image'
  | 'canvas_set_keyframe';

const TOOL_NAMES: ReadonlySet<string> = new Set([
  'canvas_get_snapshot',
  'canvas_search_nodes',
  'canvas_get_node',
  'canvas_add_node',
  'canvas_update_node_prompt',
  'canvas_regenerate_image',
  'canvas_set_keyframe',
]);

export function isKnownTool(name: string): name is ToolName {
  return TOOL_NAMES.has(name);
}

/**
 * Route one tool call to the matching canvas-api method. Throws on
 * unknown tools, malformed args, or canvas-api errors. The WS wrapper
 * catches and serializes; this layer is pure and predictable.
 */
export async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isKnownTool(name)) {
    throw new CanvasApiError(`unknown tool: ${name}`);
  }
  switch (name) {
    case 'canvas_get_snapshot':
      return getSnapshot();

    case 'canvas_search_nodes': {
      const q = args as NodeQuery;
      if (!Array.isArray(q.promptContains) || q.promptContains.length === 0) {
        throw new CanvasApiError('canvas_search_nodes: promptContains[] is required and non-empty');
      }
      return searchNodes(q);
    }

    case 'canvas_get_node': {
      const nodeId = String((args as { nodeId?: unknown }).nodeId ?? '');
      if (!nodeId) throw new CanvasApiError('canvas_get_node: nodeId is required');
      const detail = getNode(nodeId);
      if (!detail) throw new CanvasApiError(`canvas_get_node: node ${nodeId} not found`);
      return detail;
    }

    case 'canvas_add_node': {
      const spec = args as AddNodeSpec;
      if (!spec.kind || !spec.name || spec.content === undefined) {
        throw new CanvasApiError('canvas_add_node: kind, name, content are required');
      }
      return addNode(spec);
    }

    case 'canvas_update_node_prompt': {
      const a = args as { nodeId?: unknown; prompt?: unknown };
      const nodeId = String(a.nodeId ?? '');
      const prompt = String(a.prompt ?? '');
      if (!nodeId || !prompt) {
        throw new CanvasApiError('canvas_update_node_prompt: nodeId and non-empty prompt are required');
      }
      return updateNodePrompt(nodeId, { type: 'replace', prompt });
    }

    case 'canvas_regenerate_image': {
      const a = args as { nodeId?: unknown } & RegenerateImageOptions;
      const nodeId = String(a.nodeId ?? '');
      if (!nodeId) throw new CanvasApiError('canvas_regenerate_image: nodeId is required');
      const { nodeId: _drop, ...opts } = a;
      return regenerateImage(nodeId, opts);
    }

    case 'canvas_set_keyframe': {
      const a = args as { rowId?: unknown; nodeId?: unknown };
      const rowId = String(a.rowId ?? '');
      const nodeId = String(a.nodeId ?? '');
      if (!rowId || !nodeId) {
        throw new CanvasApiError('canvas_set_keyframe: rowId and nodeId are required');
      }
      setKeyframe(rowId, nodeId);
      return { ok: true, rowId, nodeId };
    }
  }
}
