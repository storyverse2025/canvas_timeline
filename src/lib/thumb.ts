/**
 * thumb(url, width) — return a downscaled JPEG URL for an /uploads/ image,
 * or pass through any other URL form unchanged.
 *
 * Why this exists: many user assets are 4K PNGs (3840×2160, ~33MB
 * decoded). Rendering even a dozen of them at canvas-node size
 * (typically 200-300px) reliably crashed Chrome with OOM — the
 * browser still decodes at natural resolution, then keeps a GPU
 * texture copy. Routing canvas/table thumbnails through /thumb/
 * cuts decoded memory by ~50× per image (4K → 512px JPEG).
 *
 * Server side: vite-capabilities-plugin.ts has a /thumb/<width>/<file>
 * middleware that resizes on demand with sharp and caches under
 * public/uploads/.thumbs/.
 *
 * Sizing guide:
 *   - 256  : asset library cards, storyboard table cells
 *   - 512  : canvas image nodes, panorama scene nodes (default)
 *   - 1024 : NodeEditPanel / Inspector previews
 *
 * For panorama scene images at 3840×2160 we request 1024px wide so the
 * drag-pan still feels sharp; the corresponding decoded buffer is
 * 1024 × 576 × 4 = 2.3 MB instead of 33 MB. With 10 scenes on canvas
 * that's a ~300 MB saving.
 */
export function thumb(url: string | undefined | null, width: number = 512): string | undefined {
  if (!url) return url ?? undefined
  // Only rewrite our own static-served uploads. External URLs, data
  // URLs, blob URLs, and any non-/uploads/ path stay untouched — the
  // middleware only knows how to read local files under public/uploads/.
  if (!url.startsWith('/uploads/')) return url
  // .thumbs/ and the .png extensions we care about — anything else
  // (zips, mp4s, audio) goes through as-is. The middleware refuses
  // non-image extensions anyway, but skipping the rewrite here avoids
  // a 400 round-trip.
  const rest = url.slice('/uploads/'.length)
  if (!/\.(png|jpg|jpeg|webp)$/i.test(rest)) return url
  if (rest.startsWith('.thumbs/')) return url // already a thumb
  // Clamp to the same range the middleware enforces so the request
  // doesn't get rejected.
  const w = Math.max(32, Math.min(2048, Math.round(width)))
  return `/thumb/${w}/${encodeURIComponent(rest)}`
}
