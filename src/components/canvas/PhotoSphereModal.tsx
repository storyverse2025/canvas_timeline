/**
 * PhotoSphereModal — fullscreen true-spherical (720°) panorama viewer.
 *
 * The in-node PanoramaViewer stays the lightweight horizontal drag-pan; this
 * modal is the real thing: a three.js inverted sphere with yaw + pitch orbit
 * and scroll-wheel FOV zoom, so 仰拍天花板 / 俯拍地面 machine positions are
 * reachable. 截机位 here is a WebGL render of the current camera — a TRUE
 * perspective reprojection (no equirect stretching near the poles), exported
 * as a 1920×1080 JPEG plate.
 *
 * three.js (~600KB) is loaded via dynamic import so it never lands in the
 * main bundle — only users who open the sphere pay for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, X, Compass } from 'lucide-react'
import { toast } from 'sonner'
import { clampFov, clampPitch } from './panorama-math'

interface Props {
  src: string
  name?: string
  onClose: () => void
  /** Same contract as PanoramaViewer.onCapture — receives a JPEG data URL. */
  onCapture?: (dataUrl: string) => void
}

/** Capture plate resolution (16:9). */
const CAPTURE_W = 1920
const CAPTURE_H = 1080

interface SphereRig {
  renderer: import('three').WebGLRenderer
  camera: import('three').PerspectiveCamera
  scene: import('three').Scene
  texture: import('three').Texture
  dispose: () => void
}

export function PhotoSphereModal({ src, name, onClose, onCapture }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rigRef = useRef<SphereRig | null>(null)
  // Orbit state lives in a ref (mutated per pointer event, consumed by the
  // render loop) — routing it through React state would re-render 60×/s.
  const orbit = useRef({ yaw: 0, pitch: 0, fov: 75 })
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [capturing, setCapturing] = useState(false)
  // HUD readout — updated at pointer-up granularity, not per frame.
  const [hud, setHud] = useState({ yaw: 0, pitch: 0, fov: 75 })

  useEffect(() => {
    let cancelled = false
    let raf = 0
    const mount = mountRef.current
    if (!mount) return

    void (async () => {
      const THREE = await import('three')
      if (cancelled || !mountRef.current) return

      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      mount.appendChild(renderer.domElement)

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(
        orbit.current.fov,
        mount.clientWidth / mount.clientHeight,
        0.1,
        1100,
      )
      camera.rotation.order = 'YXZ' // yaw around Y first, then pitch — no roll.

      const texture = await (async () => {
        // Local /uploads/ and data:/blob: URLs are same-origin — no crossOrigin
        // needed for WebGL texture upload. External URLs need CORS headers, which
        // most CDNs (Apimart, BytePlus) don't set. New generations are saved to
        // /uploads/ by persistExternalImageUrl in vite-capabilities-plugin, so
        // this case only happens with canvas items saved before that fix.
        const isLocal = src.startsWith('/') || src.startsWith('data:') || src.startsWith('blob:')
        const loader = new THREE.TextureLoader()
        if (!isLocal) loader.setCrossOrigin('anonymous')
        return new Promise<import('three').Texture>((resolve, reject) => {
          loader.load(src, resolve, undefined, () => {
            reject(new Error(
              isLocal
                ? '全景纹理加载失败'
                : '全景图跨域限制 — 请重新生成该场景图，新生成的图片会存为本地路径，可正常加载',
            ))
          })
        })
      })().catch((e: Error) => {
        if (!cancelled) setStatus('error')
        toast.error('全景加载失败', { description: e.message })
        return null
      })
      if (cancelled || !texture) {
        renderer.dispose()
        renderer.domElement.remove()
        return
      }
      texture.colorSpace = THREE.SRGBColorSpace

      // Inverted sphere: camera sits at the origin, texture on the inside.
      const geometry = new THREE.SphereGeometry(500, 64, 48)
      geometry.scale(-1, 1, 1)
      const material = new THREE.MeshBasicMaterial({ map: texture })
      scene.add(new THREE.Mesh(geometry, material))

      const onResize = () => {
        if (!mountRef.current) return
        const w = mountRef.current.clientWidth
        const h = mountRef.current.clientHeight
        renderer.setSize(w, h)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      window.addEventListener('resize', onResize)

      rigRef.current = {
        renderer, camera, scene, texture,
        dispose: () => {
          window.removeEventListener('resize', onResize)
          geometry.dispose()
          material.dispose()
          texture.dispose()
          renderer.dispose()
          renderer.domElement.remove()
        },
      }
      setStatus('ready')

      const loop = () => {
        if (cancelled) return
        camera.rotation.y = orbit.current.yaw
        camera.rotation.x = orbit.current.pitch
        if (camera.fov !== orbit.current.fov) {
          camera.fov = orbit.current.fov
          camera.updateProjectionMatrix()
        }
        renderer.render(scene, camera)
        raf = requestAnimationFrame(loop)
      }
      loop()
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      rigRef.current?.dispose()
      rigRef.current = null
    }
  }, [src])

  const syncHud = useCallback(() => {
    const { yaw, pitch, fov } = orbit.current
    setHud({
      yaw: Math.round((((-yaw * 180) / Math.PI) % 360 + 360) % 360),
      pitch: Math.round((pitch * 180) / Math.PI),
      fov: Math.round(fov),
    })
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, yaw: orbit.current.yaw, pitch: orbit.current.pitch }
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    // Scale drag→angle by FOV so zoomed-in panning stays precise.
    const k = (orbit.current.fov / 75) * 0.0032
    orbit.current.yaw = d.yaw + (e.clientX - d.x) * k
    orbit.current.pitch = clampPitch(d.pitch + (e.clientY - d.y) * k)
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    dragRef.current = null
    syncHud()
  }, [syncHud])
  const onWheel = useCallback((e: React.WheelEvent) => {
    orbit.current.fov = clampFov(orbit.current.fov + (e.deltaY > 0 ? 5 : -5))
    syncHud()
  }, [syncHud])

  // 截机位 — TRUE perspective reprojection: render the current camera view
  // at 1920×1080 and export. Briefly resizes the renderer offscreen-style,
  // then restores the display size.
  const capture = useCallback(() => {
    const rig = rigRef.current
    const mount = mountRef.current
    if (!rig || !mount || !onCapture || capturing) return
    setCapturing(true)
    try {
      const { renderer, camera, scene } = rig
      renderer.setSize(CAPTURE_W, CAPTURE_H, false)
      camera.aspect = CAPTURE_W / CAPTURE_H
      camera.updateProjectionMatrix()
      renderer.render(scene, camera)
      const dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.92)
      onCapture(dataUrl)
    } catch (e) {
      toast.error('截取机位失败', { description: String((e as Error).message).slice(0, 160) })
    } finally {
      const rig2 = rigRef.current
      if (rig2 && mount) {
        rig2.renderer.setSize(mount.clientWidth, mount.clientHeight, false)
        rig2.camera.aspect = mount.clientWidth / mount.clientHeight
        rig2.camera.updateProjectionMatrix()
      }
      setCapturing(false)
    }
  }, [onCapture, capturing])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/95 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 text-zinc-200 text-sm shrink-0">
        <div className="inline-flex items-center gap-2">
          <Compass className="w-4 h-4" />
          <span className="font-medium">{name ?? '场景全景'}</span>
          <span className="text-xs text-zinc-500">720° 球面 · 拖拽环视 · 滚轮变焦 · Esc 关闭</span>
        </div>
        <div className="inline-flex items-center gap-2">
          <span className="text-[11px] text-zinc-500 tabular-nums">
            朝向 {hud.yaw}° · 俯仰 {hud.pitch}° · FOV {hud.fov}°
          </span>
          {onCapture && (
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-primary/90 hover:bg-primary text-primary-foreground text-xs disabled:opacity-50"
              onClick={capture}
              disabled={capturing || status !== 'ready'}
              title="按当前朝向（含俯仰角）做透视重投影，导出 1920×1080 机位图到画布"
            >
              <Camera className="w-3.5 h-3.5" />
              {capturing ? '截取中…' : '截取机位'}
            </button>
          )}
          <button
            className="p-1.5 rounded hover:bg-zinc-800 text-zinc-300"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div
        ref={mountRef}
        className="flex-1 cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm pointer-events-none">
            <div className="w-5 h-5 mr-2 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin" />
            加载全景…
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm pointer-events-none">
            全景加载失败 — 关闭后重试
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
