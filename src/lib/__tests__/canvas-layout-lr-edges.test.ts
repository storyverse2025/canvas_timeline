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

  it('never pulls the source left, even when target sits to its right', () => {
    // Under spring dynamics the target will now be pulled IN toward its
    // rest position next to the source (that's the whole point of
    // `/lib/canvas-layout.ts` Pass 2). The invariant this test guards is
    // narrower: the SOURCE must stay put — chains propagate forward, never
    // dragging upstream nodes backwards.
    const nodes = [node('A', 0, 0), node('B', 500, 0)]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 50, edges })
    const A = out.find((n) => n.id === 'A')!
    expect(A.position.x).toBe(0)
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

describe('resolveOverlaps — edge springs', () => {
  it('pulls a too-far-right target back next to its source (X spring)', () => {
    // A.right = 200, padding = 40 → target rest position x = 240.
    const nodes = [node('A', 0, 0), node('B', 2000, 0)]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 120, edges })
    const A = out.find((n) => n.id === 'A')!
    const B = out.find((n) => n.id === 'B')!
    expect(A.position.x).toBe(0)                          // source never moves
    expect(B.position.x).toBeCloseTo(240, 0)              // target settles at rest
  })

  it('collapses a vertically-scattered chain onto a single horizontal row (Y spring)', () => {
    const nodes = [
      node('A', 0, 0),
      node('B', 250, 600),
      node('C', 500, -400),
      node('D', 750, 1000),
    ]
    const edges: LayoutEdge[] = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'D' },
    ]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 300, edges })
    const ys = out.map((n) => n.position.y)
    const spread = Math.max(...ys) - Math.min(...ys)
    // All four nodes have h=100, so identical y means identical midlines.
    // After enough iterations strong-Y spring should converge to ~0 spread.
    expect(spread).toBeLessThan(5)
  })

  it('leaves disconnected nodes alone (springs only act on edges)', () => {
    const nodes = [node('A', 0, 0), node('Z', 3000, 2000)]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 100, edges: [] })
    const Z = out.find((n) => n.id === 'Z')!
    expect(Z.position.x).toBe(3000)
    expect(Z.position.y).toBe(2000)
  })

  it('spring: false reverts to legacy behavior (no pull-together)', () => {
    const nodes = [node('A', 0, 0), node('B', 2000, 0)]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 120, edges, spring: false })
    const B = out.find((n) => n.id === 'B')!
    // Target already to the right of source — legacy LR pass leaves it alone.
    expect(B.position.x).toBe(2000)
  })

  it('pushes disconnected nodes apart when they end up within personal-space buffer', () => {
    // C is unrelated to the A→B chain but starts inside B's personal space.
    // Without disconnected-repulsion, the spring drags B leftward into C,
    // and overlap is only resolved when the bounding boxes actually touch.
    // With it, C should be pushed clearly outside the buffer (padding * 2 = 80).
    const nodes = [node('A', 0, 0), node('B', 800, 0), node('C', 260, 50)]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 300, edges })
    const B = out.find((n) => n.id === 'B')!
    const C = out.find((n) => n.id === 'C')!
    // Edge-to-edge gap between B and C must clear the buffer on at least one axis.
    const gapX = Math.abs((B.position.x + 100) - (C.position.x + 100)) - 200  // 200 = (200+200)/2
    const gapY = Math.abs((B.position.y + 50) - (C.position.y + 50)) - 100    // 100 = (100+100)/2
    expect(Math.max(gapX, gapY)).toBeGreaterThan(40)
  })

  it('repulse: false reverts to overlap-only behavior between disconnected pairs', () => {
    // Same setup as above; with repulse off, only Pass 1's hard overlap fires,
    // so C can sit much closer to B (only padding=40 clearance, not 80 buffer).
    const nodes = [node('A', 0, 0), node('B', 800, 0), node('C', 260, 50)]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 300, edges, repulse: false })
    const B = out.find((n) => n.id === 'B')!
    const C = out.find((n) => n.id === 'C')!
    // No assertion that they overlap — just that legacy behavior is reachable.
    // What we DO assert is that the spring still pulled B in toward A.
    expect(B.position.x).toBeLessThan(800)
    void C
  })

  it('leaves far-apart disconnected nodes untouched (buffer has finite radius)', () => {
    const nodes = [node('A', 0, 0), node('Z', 5000, 5000)]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 50 })
    const Z = out.find((n) => n.id === 'Z')!
    expect(Z.position.x).toBe(5000)
    expect(Z.position.y).toBe(5000)
  })

  it('respects LR boundary — spring never pulls target into source', () => {
    // Target overshot just slightly; spring should land it at rest, not past.
    const nodes = [node('A', 0, 0), node('B', 500, 0)]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 120, edges })
    const A = out.find((n) => n.id === 'A')!
    const B = out.find((n) => n.id === 'B')!
    // B.left must stay ≥ A.right + padding (= 240).
    expect(B.position.x).toBeGreaterThanOrEqual(A.position.x + 200 + 40 - 0.5)
  })
})

describe('resolveOverlaps — rank-based column alignment', () => {
  it('aligns same-rank siblings to the same X column (vertical stack)', () => {
    // Hub A with three children B, C, D — same rank, all targets of A.
    // After layout, B/C/D should share an X column and be stacked vertically.
    const nodes = [
      node('A', 0, 0),
      node('B', 1000, -300),
      node('C', 800, 200),
      node('D', 1200, 500),
    ]
    const edges: LayoutEdge[] = [
      { source: 'A', target: 'B' },
      { source: 'A', target: 'C' },
      { source: 'A', target: 'D' },
    ]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 300, edges })
    const byId = Object.fromEntries(out.map((n) => [n.id, n]))
    // All three siblings settle at column 1 = A.right + padding = 240.
    expect(byId.B.position.x).toBeCloseTo(240, 0)
    expect(byId.C.position.x).toBeCloseTo(240, 0)
    expect(byId.D.position.x).toBeCloseTo(240, 0)
    // Vertical stack: distinct Y positions, none overlapping (minDy = 100+40 = 140).
    const ys = [byId.B.position.y, byId.C.position.y, byId.D.position.y].sort((a, b) => a - b)
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(140 - 1)
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(140 - 1)
  })

  it('aligns 4-rank pipeline (text → asset → KF → video) into clean columns', () => {
    // Mirrors the real canvas DAG: T1 (text) → A1 (asset) → K1 (keyframe) → V1 (video).
    // T2 → A2 → K2 → V2 is a parallel pipeline.
    const nodes = [
      node('T1', 0, 0),    node('T2', 0, 500),
      node('A1', 600, 0),  node('A2', 600, 700),
      node('K1', 1200, 0), node('K2', 1200, 900),
      node('V1', 1800, 0), node('V2', 1800, 1100),
    ]
    const edges: LayoutEdge[] = [
      { source: 'T1', target: 'A1' }, { source: 'A1', target: 'K1' }, { source: 'K1', target: 'V1' },
      { source: 'T2', target: 'A2' }, { source: 'A2', target: 'K2' }, { source: 'K2', target: 'V2' },
    ]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 400, edges })
    const byId = Object.fromEntries(out.map((n) => [n.id, n]))
    // Same-rank nodes share an X coordinate.
    expect(byId.T1.position.x).toBeCloseTo(byId.T2.position.x, 0)
    expect(byId.A1.position.x).toBeCloseTo(byId.A2.position.x, 0)
    expect(byId.K1.position.x).toBeCloseTo(byId.K2.position.x, 0)
    expect(byId.V1.position.x).toBeCloseTo(byId.V2.position.x, 0)
    // Columns ordered left → right.
    expect(byId.T1.position.x).toBeLessThan(byId.A1.position.x)
    expect(byId.A1.position.x).toBeLessThan(byId.K1.position.x)
    expect(byId.K1.position.x).toBeLessThan(byId.V1.position.x)
  })

  it('final iter state has zero hard overlap even for dense hub layouts', () => {
    // A hub with 6 children — Y spring will try to collapse them all onto
    // one midline; the hard-overlap pass (running LAST per iter) must
    // guarantee no bounding-box overlap in the final snapshot.
    const nodes = [
      node('Hub', 0, 0),
      node('c1', 800, 0), node('c2', 800, 50), node('c3', 800, 100),
      node('c4', 800, 150), node('c5', 800, 200), node('c6', 800, 250),
    ]
    const edges: LayoutEdge[] = [
      { source: 'Hub', target: 'c1' }, { source: 'Hub', target: 'c2' },
      { source: 'Hub', target: 'c3' }, { source: 'Hub', target: 'c4' },
      { source: 'Hub', target: 'c5' }, { source: 'Hub', target: 'c6' },
    ]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 400, edges })
    // Verify no pair overlaps (bounding-box style).
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]; const b = out[j]
        const overlapX = (200 / 2 + 200 / 2) - Math.abs((a.position.x + 100) - (b.position.x + 100))
        const overlapY = (100 / 2 + 100 / 2) - Math.abs((a.position.y + 50) - (b.position.y + 50))
        expect(overlapX <= 0 || overlapY <= 0).toBe(true)
      }
    }
  })

  it('leaves true isolates (no in/out edges) alone — rank pull only acts on connected nodes', () => {
    // Isolate Z sits far from everything; rank-X column pull shouldn't snap it.
    const nodes = [
      node('A', 0, 0), node('B', 240, 0),
      node('Z', 4000, 4000),
    ]
    const edges: LayoutEdge[] = [{ source: 'A', target: 'B' }]
    const out = resolveOverlaps(nodes, { padding: 40, iterations: 100, edges })
    const Z = out.find((n) => n.id === 'Z')!
    expect(Z.position.x).toBe(4000)
    expect(Z.position.y).toBe(4000)
  })
})
