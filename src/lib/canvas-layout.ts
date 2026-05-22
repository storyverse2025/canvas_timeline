import type { Node } from '@xyflow/react'

export interface LayoutNode {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

function sizeOf(n: LayoutNode | Node) {
  const w = (n as Node).width ?? (n as Node).measured?.width ?? ((n as Node).style?.width as number | undefined) ?? (n as LayoutNode).width ?? 280
  const h = (n as Node).height ?? (n as Node).measured?.height ?? ((n as Node).style?.height as number | undefined) ?? (n as LayoutNode).height ?? 200
  return { w: Number(w) || 280, h: Number(h) || 200 }
}

export interface SpringOpts {
  /** Per-iteration fraction of the X gap closed by column pull. 0..1. */
  stiffnessX?: number;
  /** Per-iteration fraction of the Y misalignment closed by edge midline pull. 0..1. */
  stiffnessY?: number;
  /** Hard cap on per-edge displacement per iteration (px). Prevents overshoot. */
  maxStep?: number;
}

export interface RepulseOpts {
  /** Extra padding (px) between disconnected-pair node EDGES, on top of base `padding`.
   *  Total minimum gap = padding + extraPadding. Default `padding` (i.e. 2x gap). */
  extraPadding?: number;
}

/**
 * Longest-path rank assignment (dagre-style): root nodes get rank 0, each
 * downstream node gets max(predecessor ranks) + 1. Cycles fall through to
 * rank 0 for any unranked node. True isolates (no in/out edges) get rank
 * `null` so the layout leaves them alone.
 */
function computeRanks(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
): Map<string, number | null> {
  const inEdges = new Map<string, string[]>()
  const outEdges = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const id of ids) {
    inEdges.set(id, [])
    outEdges.set(id, [])
    inDegree.set(id, 0)
  }
  for (const e of edges) {
    if (!inDegree.has(e.source) || !inDegree.has(e.target)) continue
    if (e.source === e.target) continue
    inEdges.get(e.target)!.push(e.source)
    outEdges.get(e.source)!.push(e.target)
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
  }

  // Kahn's algorithm with longest-path rank propagation.
  const rank = new Map<string, number | null>()
  const queue: string[] = []
  for (const id of ids) {
    const hasEdges = (inEdges.get(id)?.length ?? 0) + (outEdges.get(id)?.length ?? 0) > 0
    if (!hasEdges) {
      rank.set(id, null)              // true isolate — layout leaves it alone
      continue
    }
    if ((inDegree.get(id) ?? 0) === 0) {
      rank.set(id, 0)
      queue.push(id)
    }
  }
  while (queue.length > 0) {
    const u = queue.shift()!
    const uRank = rank.get(u) ?? 0
    for (const v of outEdges.get(u) ?? []) {
      const newRank = Math.max(rank.get(v) ?? 0, uRank + 1)
      rank.set(v, newRank)
      inDegree.set(v, (inDegree.get(v) ?? 0) - 1)
      if (inDegree.get(v) === 0) queue.push(v)
    }
  }
  // Cycle survivors: any non-isolate still without a rank gets rank 0
  // (best we can do without a full SCC pass — graphs in this app are DAGs).
  for (const id of ids) {
    if (!rank.has(id)) rank.set(id, 0)
  }
  return rank
}

/**
 * Snap each rank to a shared X coordinate. Column N sits at the right edge
 * of column N-1 plus `gap`. Column width = max(node.w) within the rank, so
 * a column with a wide text node still leaves room for everything in it.
 */
function computeColumnX(
  ids: readonly string[],
  sizes: readonly { w: number; h: number }[],
  ranks: Map<string, number | null>,
  baseX: number,
  gap: number,
): Map<number, number> {
  const widthByRank = new Map<number, number>()
  for (let i = 0; i < ids.length; i++) {
    const r = ranks.get(ids[i])
    if (r == null) continue
    widthByRank.set(r, Math.max(widthByRank.get(r) ?? 0, sizes[i].w))
  }
  const sortedRanks = [...widthByRank.keys()].sort((a, b) => a - b)
  const xByRank = new Map<number, number>()
  let cursor = baseX
  for (const r of sortedRanks) {
    xByRank.set(r, cursor)
    cursor += (widthByRank.get(r) ?? 0) + gap
  }
  return xByRank
}

/**
 * Force-directed layout for the canvas:
 *
 *   1. **Rank-based column alignment** — every node is assigned a longest-path
 *      rank from the DAG (root text → asset → keyframe → video), and snapped
 *      toward a shared X coordinate per rank. Same-type/level nodes end up
 *      vertically aligned in a column, dagre-style.
 *   2. **Y spring on edges** — connected endpoints are pulled toward a shared
 *      horizontal midline so chains read as horizontal threads.
 *   3. **Soft repulse between disconnected pairs** — a personal-space buffer
 *      (base padding + `repulse.extraPadding`) prevents unrelated nodes
 *      sharing a column from crowding each other.
 *   4. **Hard overlap removal** — runs LAST in every iteration so the final
 *      snapshot is guaranteed overlap-free, no matter what the spring did.
 *
 * Pass `spring: false` to skip rank pull + Y spring (legacy behavior:
 * preserve user positions, only resolve overlaps + enforce LR). Pass
 * `repulse: false` to use base `padding` for all pairs (no extra buffer
 * between disconnected nodes).
 *
 * True isolates (no incoming AND no outgoing edges) keep their position —
 * the layout only touches them for hard overlap removal.
 *
 * Runs in O((n² + |edges|)·iterations). Fine for a few hundred nodes.
 */
export function resolveOverlaps<T extends LayoutNode>(
  nodes: T[],
  opts: {
    padding?: number;
    iterations?: number;
    edges?: LayoutEdge[];
    spring?: false | SpringOpts;
    repulse?: false | RepulseOpts;
  } = {},
): T[] {
  const padding = opts.padding ?? 30
  const iterations = opts.iterations ?? 80
  const edges = opts.edges ?? []
  const springEnabled = opts.spring !== false && edges.length > 0
  const springCfg: Required<SpringOpts> = {
    stiffnessX: (opts.spring && opts.spring !== false ? opts.spring.stiffnessX : undefined) ?? 0.6,
    stiffnessY: (opts.spring && opts.spring !== false ? opts.spring.stiffnessY : undefined) ?? 0.4,
    maxStep:    (opts.spring && opts.spring !== false ? opts.spring.maxStep    : undefined) ?? padding * 2,
  }
  const repulseEnabled = opts.repulse !== false
  const extraPadding = (opts.repulse && opts.repulse !== false ? opts.repulse.extraPadding : undefined)
    ?? padding
  // Per-pair padding used by the hard overlap pass: connected pairs use base
  // padding (they're SUPPOSED to sit next to each other), disconnected pairs
  // use base + extra so unrelated nodes get a personal-space cushion.
  const disconnectedPadding = repulseEnabled ? padding + extraPadding : padding

  const out = nodes.map((n) => ({
    ...n,
    position: { ...n.position },
  }))
  const sizes = out.map((n) => sizeOf(n))
  const indexById = new Map(out.map((n, i) => [n.id, i]))

  // Fast disconnected-pair lookup, computed once outside the iter loop.
  const connectedPairs = new Set<string>()
  for (const e of edges) {
    const si = indexById.get(e.source); const ti = indexById.get(e.target)
    if (si == null || ti == null || si === ti) continue
    const lo = Math.min(si, ti); const hi = Math.max(si, ti)
    connectedPairs.add(`${lo}:${hi}`)
  }

  // Rank + column X — computed once. Anchored at the bbox's leftmost
  // non-isolate node so a relayout doesn't slide the entire graph.
  const ids = out.map((n) => n.id)
  const ranks = computeRanks(ids, edges)
  let baseX = 0
  if (springEnabled) {
    let minX = Infinity
    for (let i = 0; i < out.length; i++) {
      if (ranks.get(ids[i]) === 0) minX = Math.min(minX, out[i].position.x)
    }
    if (Number.isFinite(minX)) baseX = minX
  }
  // Column gap between ranks — matches the historic "source.right + padding"
  // rest distance so a relayout doesn't visibly stretch connected pairs.
  const colGap = padding
  const xByRank = springEnabled
    ? computeColumnX(ids, sizes, ranks, baseX, colGap)
    : new Map<number, number>()

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false

    // ─── Pass A: spring forces (rank-X column pull + edge-Y midline) ───
    if (springEnabled) {
      const { stiffnessX, stiffnessY, maxStep } = springCfg

      // X column pull — applies to every non-isolate node, snapping it
      // toward its rank's column. This is what makes same-level nodes
      // vertically align: they all share an X target.
      for (let i = 0; i < out.length; i++) {
        const r = ranks.get(ids[i])
        if (r == null) continue                 // isolate — leave alone
        const desiredX = xByRank.get(r)
        if (desiredX == null) continue
        const dx = out[i].position.x - desiredX
        if (Math.abs(dx) < 0.5) continue
        const step = Math.max(-maxStep, Math.min(maxStep, dx * stiffnessX))
        out[i].position.x -= step
        moved = true
      }

      // Y midline pull — each edge pulls its two endpoints toward a shared
      // midline, using centers so different-height nodes line up by middle.
      for (const e of edges) {
        const si = indexById.get(e.source); const ti = indexById.get(e.target)
        if (si == null || ti == null || si === ti) continue
        const src = out[si]; const tgt = out[ti]
        const ssz = sizes[si]; const tsz = sizes[ti]
        const srcCenterY = src.position.y + ssz.h / 2
        const tgtCenterY = tgt.position.y + tsz.h / 2
        const midY = (srcCenterY + tgtCenterY) / 2
        const dySrc = srcCenterY - midY
        const dyTgt = tgtCenterY - midY
        if (Math.abs(dySrc) > 0.5) {
          src.position.y -= Math.max(-maxStep, Math.min(maxStep, dySrc * stiffnessY))
          moved = true
        }
        if (Math.abs(dyTgt) > 0.5) {
          tgt.position.y -= Math.max(-maxStep, Math.min(maxStep, dyTgt * stiffnessY))
          moved = true
        }
      }
    }

    // ─── Pass B: hard pairwise separation (RUNS LAST per iter so the
    //     final snapshot is overlap-free no matter what the spring did).
    //     Pair-specific padding: connected pairs use `padding` (they should
    //     sit next to each other); disconnected pairs use `disconnectedPadding`
    //     so unrelated nodes get a real personal-space buffer.
    //
    //     Sub-iterated until no pair moves — a SINGLE O(n²) sweep is not
    //     enough for dense hubs (push on (c1,c2) can newly overlap c3, which
    //     was already processed). Capped at 20 sub-iters so adversarial
    //     inputs can't hang the layout. ───
    for (let subIter = 0; subIter < 20; subIter++) {
      let subMoved = false
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const a = out[i]; const b = out[j]
          const sa = sizes[i]; const sb = sizes[j]
          const isConnected = connectedPairs.has(`${i}:${j}`)
          const pairPad = isConnected ? padding : disconnectedPadding
          const minDx = (sa.w + sb.w) / 2 + pairPad
          const minDy = (sa.h + sb.h) / 2 + pairPad
          const ax = a.position.x + sa.w / 2
          const ay = a.position.y + sa.h / 2
          const bx = b.position.x + sb.w / 2
          const by = b.position.y + sb.h / 2
          const dx = bx - ax
          const dy = by - ay
          const overlapX = minDx - Math.abs(dx)
          const overlapY = minDy - Math.abs(dy)
          if (overlapX <= 0 || overlapY <= 0) continue

          // Prefer Y separation for SAME-RANK pairs — keeps the column intact.
          // Otherwise push along axis of least overlap (shortest route out).
          const sameColumn = springEnabled
            && ranks.get(ids[i]) != null
            && ranks.get(ids[i]) === ranks.get(ids[j])
          const pushY = sameColumn ? true : overlapY < overlapX
          if (!pushY) {
            const shift = (overlapX / 2) * (dx >= 0 ? 1 : -1)
            a.position.x -= shift
            b.position.x += shift
          } else {
            // dy can be 0 for perfectly stacked nodes — pick a deterministic
            // direction (by index) so they don't end up wedged on top of each
            // other across iterations.
            const dir = dy !== 0 ? (dy >= 0 ? 1 : -1) : (i < j ? -1 : 1)
            const shift = (overlapY / 2) * dir
            a.position.y -= shift
            b.position.y += shift
          }
          subMoved = true
          moved = true
        }
      }
      if (!subMoved) break
    }

    // ─── Pass C: LR direction safety net — target must sit right of source
    //     edge by at least `padding`. The rank column pull already handles
    //     this in normal cases; this is the backstop if someone passes
    //     spring:false or if rank assignment was incomplete. Only moves
    //     TARGETS rightward, never sources leftward (chains propagate
    //     forward, never drag upstream backwards). ───
    if (edges.length > 0) {
      const eps = 0.5
      for (const e of edges) {
        const si = indexById.get(e.source); const ti = indexById.get(e.target)
        if (si == null || ti == null || si === ti) continue
        const src = out[si]; const tgt = out[ti]
        const ssz = sizes[si]
        const minTargetX = src.position.x + ssz.w + padding
        if (tgt.position.x < minTargetX - eps) {
          tgt.position.x = minTargetX
          moved = true
        }
      }
    }

    if (!moved) break
  }
  return out
}
