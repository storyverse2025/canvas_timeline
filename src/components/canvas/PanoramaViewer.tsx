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
import { Camera, Compass, Maximize2 } from 'lucide-react'
import { toast } from 'sonner'
import { thumb } from '@/lib/thumb'
import { CAPTURE_OUT_H, CAPTURE_OUT_W, reprojectEquirectToPerspective } from './panorama-math'
import { PhotoSphereModal } from './PhotoSphereModal'

interface Props {
  src: string
  alt?: string
  className?: string
  /**
   * 虚拟取景 (super-i.cn/info-2753 step 4): when provided, a 截机位 button
   * captures a 16:9 camera plate from the panorama at the current pan
   * position and hands back a JPEG data URL. The caller (ImageCanvasNode)
   * turns it into a canvas node wired to this scene.
   */
  onCapture?: (dataUrl: string) => void
}

// Crop geometry lives in panorama-math.ts (pure + unit-tested).

/**
 * react-flow swallows mouse events that originate inside a node when the
 * node body has class "nodrag". This component sets that automatically so
 * a drag inside the viewer pans the image instead of moving the canvas node.
 */
export function PanoramaViewer({ src, alt, className, onCapture }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Offset (px) the image is shifted by — negative = pan right.
  const [offset, setOffset] = useState(0)
  const [imageWidth, setImageWidth] = useState(0)
  const dragState = useRef<{ startX: number; startOffset: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [capturing, setCapturing] = useState(false)
  // Fullscreen true-spherical viewer (three.js, lazy-loaded on open).
  const [sphereOpen, setSphereOpen] = useState(false)

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

  // 截机位: render a true perspective (gnomonic) 90° / 16:9 view from the
  // FULL-RES panorama at the current pan position. Loads the original (not
  // the 1024px thumb) once, just for the capture. A flat equirect crop is
  // NOT enough here — it bows straight world lines into waves, and those
  // warped plates then poison every downstream generation that uses the
  // capture as a scene reference (开场构图 波浪纹, distorted videos).
  const handleCapture = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onCapture || capturing) return
    const container = containerRef.current
    if (!container || imageWidth <= 0) return
    setCapturing(true)
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('全景原图加载失败'))
        img.src = src
      })
      // Viewport center in panorama space: the displayed tile is offset px
      // to the left (offset ≤ 0), so the pixel at the container's center is
      // (-offset + containerW/2) into the rendered tile.
      const centerFrac = (-offset + container.clientWidth / 2) / imageWidth
      // Decode the panorama into a pixel buffer for the reprojector.
      const srcCanvas = document.createElement('canvas')
      srcCanvas.width = img.naturalWidth
      srcCanvas.height = img.naturalHeight
      const sg = srcCanvas.getContext('2d')
      if (!sg) throw new Error('canvas 2d context unavailable')
      sg.drawImage(img, 0, 0)
      const srcData = sg.getImageData(0, 0, img.naturalWidth, img.naturalHeight)
      const pixels = reprojectEquirectToPerspective(srcData, centerFrac)
      const outCanvas = document.createElement('canvas')
      outCanvas.width = CAPTURE_OUT_W
      outCanvas.height = CAPTURE_OUT_H
      const og = outCanvas.getContext('2d')
      if (!og) throw new Error('canvas 2d context unavailable')
      og.putImageData(new ImageData(pixels, CAPTURE_OUT_W, CAPTURE_OUT_H), 0, 0)
      onCapture(outCanvas.toDataURL('image/jpeg', 0.92))
    } catch (err) {
      // Cross-origin panoramas without CORS headers taint the canvas —
      // surface it instead of failing silently.
      toast.error('截取机位失败', { description: String((err as Error).message).slice(0, 160) })
    } finally {
      setCapturing(false)
    }
  }, [onCapture, capturing, imageWidth, offset, src])

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

      {/* Badge doubles as the fullscreen trigger: the in-node viewer only
          pans horizontally; the modal is the true 720° sphere (yaw+pitch,
          perspective 截机位 without pole distortion). */}
      <button
        className="absolute bottom-1 right-1 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-black/60 hover:bg-black/80 text-white"
        onClick={(e) => { e.stopPropagation(); setSphereOpen(true) }}
        onPointerDown={(e) => e.stopPropagation()}
        title="打开 720° 球面查看器（可抬头/低头、变焦、透视截机位）"
      >
        <Maximize2 className="w-2.5 h-2.5" />
        <Compass className="w-2.5 h-2.5" />
        720°
      </button>
      {sphereOpen && (
        <PhotoSphereModal
          src={src}
          name={alt}
          onClose={() => setSphereOpen(false)}
          onCapture={onCapture}
        />
      )}

      {/* 虚拟取景: capture the current view direction as a 机位截图. */}
      {onCapture && (
        <button
          className="absolute bottom-1 left-1 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-black/60 hover:bg-black/80 text-white"
          onClick={handleCapture}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={capturing}
          title="截取机位：把当前朝向的 90° 视野导出为 16:9 场景底图（落到画布，与本场景连边）"
        >
          <Camera className="w-2.5 h-2.5" />
          {capturing ? '截取中…' : '截机位'}
        </button>
      )}
    </div>
  )
}
