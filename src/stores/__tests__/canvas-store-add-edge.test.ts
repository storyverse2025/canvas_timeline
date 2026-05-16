import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '@/stores/canvas-store'

/**
 * Regression: keyframe (and every other programmatic edge) was rendering
 * without a sourceHandle, triggering ReactFlow warning "Couldn't create
 * edge for source handle id null" and leaving the edge invisible because
 * ImageCanvasNode + TextCanvasNode declare named handles (r/l/t/b).
 *
 * The fix defaults addEdge to sourceHandle='r' + targetHandle='l' — the
 * left-to-right flow those nodes expose.
 */
describe('canvas-store addEdge — handle defaults', () => {
  beforeEach(() => {
    useCanvasStore.setState({ edges: [], nodes: [], selectedNodeIds: [] })
  })

  it("defaults to sourceHandle 'r' / targetHandle 'l' when none supplied", () => {
    useCanvasStore.getState().addEdge('node-a', 'node-b')
    const edge = useCanvasStore.getState().edges[0]
    expect(edge.source).toBe('node-a')
    expect(edge.target).toBe('node-b')
    expect(edge.sourceHandle).toBe('r')
    expect(edge.targetHandle).toBe('l')
  })

  it('respects explicit sourceHandle / targetHandle (user-drawn connections)', () => {
    useCanvasStore.getState().addEdge('node-a', 'node-b', 'b', 't')
    const edge = useCanvasStore.getState().edges[0]
    expect(edge.sourceHandle).toBe('b')
    expect(edge.targetHandle).toBe('t')
  })

  it('omits handle fields when explicitly passed null (legacy unnamed-handle nodes)', () => {
    useCanvasStore.getState().addEdge('node-a', 'node-b', null, null)
    const edge = useCanvasStore.getState().edges[0]
    expect(edge.sourceHandle).toBeUndefined()
    expect(edge.targetHandle).toBeUndefined()
  })

  it('dedupes the same (source, target, handle, handle) tuple', () => {
    const store = useCanvasStore.getState()
    store.addEdge('a', 'b')
    store.addEdge('a', 'b')
    expect(useCanvasStore.getState().edges).toHaveLength(1)
  })

  it('allows a second edge with the same nodes but different handles', () => {
    const store = useCanvasStore.getState()
    store.addEdge('a', 'b') // r → l
    store.addEdge('a', 'b', 'b', 't') // b → t
    expect(useCanvasStore.getState().edges).toHaveLength(2)
  })
})
