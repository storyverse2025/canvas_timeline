/**
 * PanoramaViewer
 *
 * Lightweight drag-to-pan viewer for the 360° equirectangular panorama scene
 * images that art-director-agent produces. No three.js / no WebGL — the image
 * is rendered as a wide CSS background that the user drags horizontally to
 * see different viewpoints. Wraparound is faked by duplicating the image
 * tile so the seam never shows.
 *
 * Why not real 360°? At canvas-node scale the viewer fits in ~280×180px;
 * proper equirectangular projection would need three.js (~600KB) and would
 * not look meaningfully better than a 1.5-screen horizontal pan. If users
 * later want a fullscreen 360° view, add a "expand" button that opens a
 * proper photo-sphere modal — kept out of this small node renderer.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Compass } from 'lucide-react'
import { thumb } from '@/lib/thumb'

interface Props {
  src: string
  alt?: string
  className?: string
}

/**
 * react-flow swallows mouse events that originate inside a node when the
 * node body has class "nodrag". This component sets that automatically so
 * a drag inside the viewer pans the image instead of moving the canvas node.
 */
export function PanoramaViewer({ src, alt, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Offset (px) the image is shifted by — negative = pan right.
  const [offset, setOffset] = useState(0)
  const [imageWidth, setImageWidth] = useState(0)
  const dragState = useRef<{ startX: number; startOffset: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  // Panoramas are 4K equirectangular (3840×2160) — decoded at natural
  // size they cost ~33MB each and several on canvas at once is a major
  // OOM contributor. Render at 1024px wide; that leaves the drag-pan
  // sharp at typical node sizes while cutting decoded memory ~10×.
  const displaySrc = thumb(src, 1024) ?? src

  // Measure the displayed image's rendered width at this container's
  // height so the wraparound math knows when to snap back. Uses the
  // thumb (not the 4K source) so we don't burn memory decoding the
  // original just to read its dimensions.
  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled || !containerRef.current) return
      const containerH = containerRef.current.clientHeight
      const aspect = img.naturalWidth / img.naturalHeight
      setImageWidth(Math.round(containerH * aspect))
    }
    img.src = displaySrc
    return () => { cancelled = true }
  }, [displaySrc])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    if (!containerRef.current) return
    containerRef.current.setPointerCapture(e.pointerId)
    dragState.current = { startX: e.clientX, startOffset: offset }
    setDragging(true)
  }, [offset])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return
    e.stopPropagation()
    const dx = e.clientX - dragState.current.startX
    let next = dragState.current.startOffset + dx
    // Wraparound — once the image has scrolled past its own width, snap back
    // by one tile so the user can keep dragging in the same direction.
    if (imageWidth > 0) {
      const mod = ((next % imageWidth) + imageWidth) % imageWidth
      next = next - imageWidth // anchor in negative range so we always have
                                // a duplicate tile coming in from the right.
      next = -mod
    }
    setOffset(next)
  }, [imageWidth])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragState.current) return
    e.stopPropagation()
    containerRef.current?.releasePointerCapture(e.pointerId)
    dragState.current = null
    setDragging(false)
  }, [])

  return (
    <div
      ref={containerRef}
      className={`nodrag relative w-full h-full overflow-hidden bg-black select-none ${
        dragging ? 'cursor-grabbing' : 'cursor-grab'
      } ${className ?? ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Two image tiles side-by-side give us a seamless wraparound illusion. */}
      <div
        className="absolute top-0 left-0 h-full flex"
        style={{
          transform: `translateX(${offset}px)`,
          willChange: 'transform',
        }}
      >
        <img
          src={displaySrc}
          alt={alt ?? ''}
          loading="lazy"
          decoding="async"
          className="h-full w-auto shrink-0 pointer-events-none select-none"
          draggable={false}
        />
        {/* Wraparound tile — only mount once the user starts dragging or has
            already panned, so idle scene nodes hold a single 4K texture
            instead of two. Equirectangular panoramas decoded twice each
            were a major contributor to Chrome OOM on dense boards. */}
        {imageWidth > 0 && (dragging || offset !== 0) && (
          <img
            src={displaySrc}
            alt=""
            aria-hidden
            loading="lazy"
            decoding="async"
            className="h-full w-auto shrink-0 pointer-events-none select-none"
            draggable={false}
          />
        )}
      </div>

      {/* "360°" badge so the user knows the image is interactive. */}
      <div className="absolute bottom-1 right-1 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-black/60 text-white pointer-events-none">
        <Compass className="w-2.5 h-2.5" />
        360° · 拖拽查看
      </div>
    </div>
  )
}
