/**
 * Pure geometry for the panorama viewers (kept out of the .tsx component
 * files so react-refresh stays happy and the math is unit-testable).
 */

/** Horizontal FOV of a flat-crop 机位 from the in-node viewer — 90° reads as
 *  a natural wide lens and keeps the flat-crop approximation acceptable. */
export const CAPTURE_HFOV_DEG = 90

/**
 * Compute the source crop rect for a flat 机位截图: a 16:9 window of
 * `fovDeg` horizontal field-of-view centered on `centerFrac` (0..1 around
 * the panorama), vertically centered on the horizon. `x` is normalized to
 * [0, naturalW) — when `x + w` exceeds naturalW the crop wraps across the
 * seam and must be drawn as two segments.
 *
 * Note: this is a flat crop, not a true perspective reprojection. Do NOT
 * use it for 机位截图 — flat crops bow straight world lines (the 波浪纹
 * bug); captures go through reprojectEquirectToPerspective below. Kept for
 * cheap preview-window math where distortion doesn't feed a generator.
 */
export function computePanoramaCaptureRect(
  naturalW: number,
  naturalH: number,
  centerFrac: number,
  fovDeg: number = CAPTURE_HFOV_DEG,
): { x: number; y: number; w: number; h: number } {
  const w = Math.round(naturalW * (fovDeg / 360))
  const h = Math.min(naturalH, Math.round((w * 9) / 16))
  const y = Math.round((naturalH - h) / 2)
  const frac = ((centerFrac % 1) + 1) % 1
  const x = Math.round(((frac * naturalW - w / 2) % naturalW + naturalW) % naturalW)
  return { x, y, w, h }
}

/** Output size of the perspective-corrected 机位截图 (16:9). At 90° HFOV
 *  the focal length is outW/2 = 640px/rad-ish, which slightly oversamples a
 *  4K equirect's 10.7px/° — sharp without wasting encode size. */
export const CAPTURE_OUT_W = 1280
export const CAPTURE_OUT_H = 720

/** Minimal pixel-buffer shape shared by DOM ImageData and test fixtures. */
export interface PixelBuffer {
  data: Uint8ClampedArray
  width: number
  height: number
}

/**
 * Map one output pixel of a perspective (gnomonic) camera back to
 * equirectangular texture coordinates.
 *
 * Camera: optical axis on the horizon (pitch 0) pointing at longitude
 * `centerFrac × 2π`, horizontal FOV `fovDeg`. Returns { u, v } in source
 * pixels — u wraps around the seam ([0, srcW)), v is clamped by the caller.
 *
 * This is what the flat crop got wrong: a crop maps output x linearly to
 * longitude, so vertical world lines bow outward and interiors ripple
 * (the 波浪纹). Gnomonic maps x → f·tan(Δlon), keeping straight world
 * lines straight — for every output column the sampled longitude is
 * constant across rows.
 */
export function gnomonicToEquirect(
  outX: number,
  outY: number,
  outW: number,
  outH: number,
  srcW: number,
  srcH: number,
  centerFrac: number,
  fovDeg: number = CAPTURE_HFOV_DEG,
): { u: number; v: number } {
  const f = (outW / 2) / Math.tan(((fovDeg * Math.PI) / 180) / 2)
  const dx = outX + 0.5 - outW / 2
  const dy = outY + 0.5 - outH / 2
  const lon = centerFrac * 2 * Math.PI + Math.atan2(dx, f)
  const lat = Math.atan2(-dy, Math.hypot(dx, f)) // + = up
  const uFrac = (((lon / (2 * Math.PI)) % 1) + 1) % 1
  const u = uFrac * srcW
  const v = (0.5 - lat / Math.PI) * srcH
  return { u, v }
}

/**
 * Reproject an equirectangular panorama to a perspective 机位截图,
 * bilinear-sampled (horizontal wrap, vertical clamp). Pure typed-array
 * work so it runs identically in vitest and in the browser; the caller
 * wraps the result in an ImageData / canvas.
 */
export function reprojectEquirectToPerspective(
  src: PixelBuffer,
  centerFrac: number,
  fovDeg: number = CAPTURE_HFOV_DEG,
  outW: number = CAPTURE_OUT_W,
  outH: number = CAPTURE_OUT_H,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(outW * outH * 4)
  const { data, width: sw, height: sh } = src
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const { u, v } = gnomonicToEquirect(x, y, outW, outH, sw, sh, centerFrac, fovDeg)
      // Bilinear: u wraps (panorama seam), v clamps (poles are outside a
      // 16:9 @ 90° window anyway, but guard against tall FOVs).
      const u0 = Math.floor(u - 0.5)
      const v0 = Math.floor(v - 0.5)
      const fu = u - 0.5 - u0
      const fv = v - 0.5 - v0
      const xw0 = ((u0 % sw) + sw) % sw
      const xw1 = (xw0 + 1) % sw
      const yc0 = Math.min(sh - 1, Math.max(0, v0))
      const yc1 = Math.min(sh - 1, Math.max(0, v0 + 1))
      const o = (y * outW + x) * 4
      for (let c = 0; c < 4; c++) {
        const p00 = data[(yc0 * sw + xw0) * 4 + c]!
        const p10 = data[(yc0 * sw + xw1) * 4 + c]!
        const p01 = data[(yc1 * sw + xw0) * 4 + c]!
        const p11 = data[(yc1 * sw + xw1) * 4 + c]!
        out[o + c] =
          p00 * (1 - fu) * (1 - fv) +
          p10 * fu * (1 - fv) +
          p01 * (1 - fu) * fv +
          p11 * fu * fv
      }
    }
  }
  return out
}

// ─── PhotoSphereModal orbit clamps ──────────────────────────────────

/** Pitch stops just short of ±90° so the camera never gimbal-flips. */
export const PITCH_LIMIT_RAD = (Math.PI / 2) * 0.94

export function clampPitch(pitch: number): number {
  return Math.max(-PITCH_LIMIT_RAD, Math.min(PITCH_LIMIT_RAD, pitch))
}

/** Scroll-wheel zoom bounds: 30° (tele) to 100° (wide). */
export function clampFov(fov: number): number {
  return Math.max(30, Math.min(100, fov))
}
