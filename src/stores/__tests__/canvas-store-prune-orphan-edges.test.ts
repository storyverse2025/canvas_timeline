import { describe, it, expect } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { pruneOrphanEdges } from '@/stores/canvas-store'

/**
 * Regression: ReactFlow warns "Couldn't create edge for source handle id …"
 * when an edge's referenced node is missing OR the handle id doesn't exist
 * on the source/target node type. We sweep on store hydration.
 */
describe('pruneOrphanEdges', () => {
  const mkNode = (id: string, type: string): Node => ({
    id, type, position: { x: 0, y: 0 }, data: {},
  })

  it('removes edges whose source node is missing', () => {
    const state = {
      nodes: [mkNode('b', 'image')],
      edges: [{ id: 'e1', source: 'gone', target: 'b', sourceHandle: 'r', targetHandle: 'l' } as Edge],
    }
    const r = pruneOrphanEdges(state)
    expect(r.removed).toBe(1)
    expect(state.edges).toHaveLength(0)
  })

  it('removes edges whose target node is missing', () => {
    const state = {
      nodes: [mkNode('a', 'image')],
      edges: [{ id: 'e1', source: 'a', target: 'gone', sourceHandle: 'r', targetHandle: 'l' } as Edge],
    }
    const r = pruneOrphanEdges(state)
    expect(r.removed).toBe(1)
    expect(state.edges).toHaveLength(0)
  })

  it("strips sourceHandle 'r' when source node type uses unnamed handles (e.g. asset)", () => {
    const state = {
      nodes: [mkNode('a', 'asset'), mkNode('b', 'image')],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'r', targetHandle: 'l' } as Edge],
    }
    const r = pruneOrphanEdges(state)
    expect(r.removed).toBe(0)
    expect(r.strippedHandles).toBe(1)
    expect(state.edges).toHaveLength(1)
    expect(state.edges[0].sourceHandle).toBeUndefined()
    expect(state.edges[0].targetHandle).toBe('l')
  })

  it("strips targetHandle when target node type doesn't expose it", () => {
    const state = {
      nodes: [mkNode('a', 'image'), mkNode('b', 'script')],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'r', targetHandle: 'l' } as Edge],
    }
    const r = pruneOrphanEdges(state)
    expect(r.strippedHandles).toBe(1)
    expect(state.edges[0].sourceHandle).toBe('r')
    expect(state.edges[0].targetHandle).toBeUndefined()
  })

  it('keeps valid named-handle edges intact (image → image, r → l)', () => {
    const state = {
      nodes: [mkNode('a', 'image'), mkNode('b', 'image')],
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'r', targetHandle: 'l' } as Edge],
    }
    const r = pruneOrphanEdges(state)
    expect(r.removed).toBe(0)
    expect(r.strippedHandles).toBe(0)
    expect(state.edges[0].sourceHandle).toBe('r')
    expect(state.edges[0].targetHandle).toBe('l')
  })

  it('keeps unnamed-handle edges intact (asset → script, no handle ids)', () => {
    const state = {
      nodes: [mkNode('a', 'asset'), mkNode('b', 'script')],
      edges: [{ id: 'e1', source: 'a', target: 'b' } as Edge],
    }
    const r = pruneOrphanEdges(state)
    expect(r.removed).toBe(0)
    expect(r.strippedHandles).toBe(0)
    expect(state.edges).toHaveLength(1)
  })
})
