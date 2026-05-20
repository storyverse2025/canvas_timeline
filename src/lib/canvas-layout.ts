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

/**
 * Iteratively push overlapping rectangles apart. Keeps original layout intent
 * (rough shape of user's positions) but removes overlaps.
 *
 * When `edges` is supplied, also enforces left-to-right edge direction: for
 * every edge source → target, target's left side is pushed to at least
 * `source.right + padding`. Arrows in the canvas therefore always point
 * rightward.
 *
 * Runs in O((n² + |edges|)·iterations). Fine for a few hundred nodes.
 */
export function resolveOverlaps<T extends LayoutNode>(
  nodes: T[],
  opts: { padding?: number; iterations?: number; edges?: LayoutEdge[] } = {},
): T[] {
  const padding = opts.padding ?? 30
  const iterations = opts.iterations ?? 80
  const edges = opts.edges ?? []
  const out = nodes.map((n) => ({
    ...n,
    position: { ...n.position },
  }))
  const sizes = out.map((n) => sizeOf(n))
  const indexById = new Map(out.map((n, i) => [n.id, i]))

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false

    // Pass 1: pairwise overlap removal.
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]; const b = out[j]
        const sa = sizes[i]; const sb = sizes[j]
        const minDx = (sa.w + sb.w) / 2 + padding
        const minDy = (sa.h + sb.h) / 2 + padding
        const ax = a.position.x + sa.w / 2
        const ay = a.position.y + sa.h / 2
        const bx = b.position.x + sb.w / 2
        const by = b.position.y + sb.h / 2
        const dx = bx - ax
        const dy = by - ay
        const overlapX = minDx - Math.abs(dx)
        const overlapY = minDy - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) continue
        // Push along the axis of least overlap
        if (overlapX < overlapY) {
          const shift = (overlapX / 2) * (dx >= 0 ? 1 : -1)
          a.position.x -= shift
          b.position.x += shift
        } else {
          const shift = (overlapY / 2) * (dy >= 0 ? 1 : -1)
          a.position.y -= shift
          b.position.y += shift
        }
        moved = true
      }
    }

    // Pass 2: enforce left-to-right edge direction. The target of every
    // edge must sit to the right of its source (target.x ≥ source.right
    // + padding). Always push the TARGET right — never the source left —
    // so chains propagate forward without dragging the upstream graph
    // backwards. A small epsilon avoids re-triggering on rounding error.
    if (edges.length > 0) {
      const eps = 0.5
      for (const e of edges) {
        const si = indexById.get(e.source)
        const ti = indexById.get(e.target)
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
