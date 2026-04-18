import type { Node } from '@xyflow/react'

export interface LayoutNode {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
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
 * Runs in O(n²·iterations). Fine for a few hundred nodes.
 */
export function resolveOverlaps<T extends LayoutNode>(
  nodes: T[],
  opts: { padding?: number; iterations?: number } = {},
): T[] {
  const padding = opts.padding ?? 30
  const iterations = opts.iterations ?? 80
  const out = nodes.map((n) => ({
    ...n,
    position: { ...n.position },
  }))
  const sizes = out.map((n) => sizeOf(n))

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false
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
    if (!moved) break
  }
  return out
}
