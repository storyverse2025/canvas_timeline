import { describe, expect, it } from 'vitest'
import { resolveOverlaps, type LayoutEdge, type LayoutNode } from '@/lib/canvas-layout'

function node(id: string, x: number, y: number, w = 200, h = 100): LayoutNode {
  return { id, position: { x, y }, width: w, height: h }
}

describe('resolveOverlaps — LR edge constraint', () => {
  it('moves a target that sits to the LEFT of its source past source.right + padding', () => {
    const nodes = [node('A', 0, 0), node('B', -500, 0)]  // B drawn left of A
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 50, edges })
    const A = out.find((n) => n.id === 'A')!
    const B = out.find((n) => n.id === 'B')!
    // B must end up at >= A.right + padding (A.right = 0 + 200 = 200, +40 = 240).
    expect(B.position.x).toBeGreaterThanOrEqual(A.position.x + 200 + 40 - 0.5)
  })

  it('leaves a target that is already to the right of its source alone (no left-pull on the source)', () => {
    const nodes = [node('A', 0, 0), node('B', 500, 0)]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 50, edges })
    const A = out.find((n) => n.id === 'A')!
    const B = out.find((n) => n.id === 'B')!
    expect(A.position.x).toBe(0)        // source never pulled left
    expect(B.position.x).toBe(500)      // target not perturbed
  })

  it('propagates through a chain so every edge points right', () => {
    // Reverse-built chain: D—C—B—A laid out reading right-to-left.
    const nodes = [
      node('A', 0, 0),
      node('B', -250, 0),
      node('C', -500, 0),
      node('D', -750, 0),
    ]
    const edges: LayoutEdge[] = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'D' },
    ]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 100, edges })
    const byId = Object.fromEntries(out.map((n) => [n.id, n]))
    // Every arrow points right after layout.
    expect(byId.B.position.x).toBeGreaterThan(byId.A.position.x)
    expect(byId.C.position.x).toBeGreaterThan(byId.B.position.x)
    expect(byId.D.position.x).toBeGreaterThan(byId.C.position.x)
  })

  it('still resolves pairwise overlap when no edges are supplied (back-compat)', () => {
    // Two perfectly overlapping nodes — must end up not overlapping.
    const nodes = [node('A', 0, 0), node('B', 0, 0)]
    const out = resolveOverlaps(nodes, { padding: 20, iterations: 50 })
    const A = out.find((n) => n.id === 'A')!
    const B = out.find((n) => n.id === 'B')!
    const overlapX = 200 + 20 - Math.abs(A.position.x - B.position.x)
    const overlapY = 100 + 20 - Math.abs(A.position.y - B.position.y)
    // At least one axis must have non-overlapping separation.
    expect(Math.max(overlapX, overlapY) <= 1 || overlapX <= 1 || overlapY <= 1).toBe(true)
  })

  it('handles missing source/target ids without crashing', () => {
    const nodes = [node('A', 0, 0)]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'GHOST' }, { source: 'GHOST2', target: 'A' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 10, edges })
    expect(out).toHaveLength(1)
    expect(out[0].position.x).toBe(0)
  })
})
