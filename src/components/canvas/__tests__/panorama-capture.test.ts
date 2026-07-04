import { describe, expect, it } from 'vitest'
import {
  clampFov,
  clampPitch,
  computePanoramaCaptureRect,
  gnomonicToEquirect,
  PITCH_LIMIT_RAD,
  reprojectEquirectToPerspective,
} from '@/components/canvas/panorama-math'

/**
 * 虚拟取景 geometry (super-i.cn/info-2753 step 4): the 截机位 button crops a
 * 90°-hFOV 16:9 window out of the equirectangular panorama at the current
 * pan position. These tests pin the crop math — especially the seam wrap.
 */
describe('computePanoramaCaptureRect', () => {
  const W = 3840
  const H = 1920 // true 2:1 equirectangular

  it('crops a 90° window as 1/4 of the panorama width at 16:9, centered on the horizon', () => {
    const r = computePanoramaCaptureRect(W, H, 0.5)
    expect(r.w).toBe(960)          // 3840 × (90/360)
    expect(r.h).toBe(540)          // 960 × 9/16
    expect(r.y).toBe(690)          // (1920 − 540) / 2 — horizon centered
    expect(r.x).toBe(1440)         // 0.5×3840 − 960/2
    expect(r.x + r.w).toBeLessThanOrEqual(W) // no wrap needed at center
  })

  it('wraps across the seam when the view straddles the panorama edge', () => {
    const r = computePanoramaCaptureRect(W, H, 0) // looking at the seam
    expect(r.x).toBe(W - 480)      // starts 480px before the right edge
    expect(r.x + r.w).toBeGreaterThan(W) // caller must draw two segments
  })

  it('normalizes out-of-range center fractions (drag past 360° keeps working)', () => {
    const a = computePanoramaCaptureRect(W, H, 1.25)
    const b = computePanoramaCaptureRect(W, H, 0.25)
    const c = computePanoramaCaptureRect(W, H, -0.75)
    expect(a).toEqual(b)
    expect(c).toEqual(b)
  })

  it('clamps crop height on legacy non-2:1 panoramas (3840×2160) and stays 16:9-bounded', () => {
    const r = computePanoramaCaptureRect(3840, 2160, 0.5)
    expect(r.w).toBe(960)
    expect(r.h).toBe(540)
    expect(r.y).toBe(810)
  })
})

/**
 * 截机位 now ships a true gnomonic (perspective) reprojection instead of a
 * flat crop — flat crops bow straight world lines, and those warped plates
 * fed every downstream generation (开场构图 波浪纹, distorted beat videos).
 */
describe('gnomonicToEquirect', () => {
  const SW = 3840
  const SH = 1920
  const OW = 1280
  const OH = 720

  it('the optical axis lands exactly on the pan-center column, on the horizon', () => {
    const { u, v } = gnomonicToEquirect(OW / 2 - 0.5, OH / 2 - 0.5, OW, OH, SW, SH, 0.5)
    expect(u).toBeCloseTo(0.5 * SW, 6)
    expect(v).toBeCloseTo(0.5 * SH, 6)
  })

  it('keeps vertical world lines vertical: one output column samples ONE panorama longitude at every row', () => {
    // This is precisely what the flat crop violated (the 波浪纹 source).
    const x = 200
    const us = [0, 180, 360, 540, 719].map(
      (y) => gnomonicToEquirect(x, y, OW, OH, SW, SH, 0.5).u,
    )
    for (const u of us) expect(u).toBeCloseTo(us[0]!, 6)
  })

  it('maps output x by f·tan(Δlon), not linearly in longitude', () => {
    // At 90° hFOV the quarter-width point sits at atan(1/2) ≈ 26.565° off
    // axis — a flat (linear) crop would put it at 22.5°. If someone
    // "simplifies" this back to a crop, this test fails.
    const { u } = gnomonicToEquirect(OW / 4 - 0.5, OH / 2 - 0.5, OW, OH, SW, SH, 0.5)
    const dLonDeg = (u / SW - 0.5) * 360
    expect(dLonDeg).toBeCloseTo(-Math.atan(0.5) * (180 / Math.PI), 3)
    expect(Math.abs(dLonDeg + 22.5)).toBeGreaterThan(1)
  })

  it('wraps longitude across the panorama seam', () => {
    const { u } = gnomonicToEquirect(0, OH / 2, OW, OH, SW, SH, 0) // looking at the seam
    expect(u).toBeGreaterThan(SW * 0.8) // left half of the view comes from the right edge
    expect(u).toBeLessThan(SW)
  })
})

describe('reprojectEquirectToPerspective', () => {
  it('produces an RGBA buffer of the configured output size and samples the expected region', () => {
    // 8×4 synthetic pano: left half red, right half blue.
    const sw = 8
    const sh = 4
    const data = new Uint8ClampedArray(sw * sh * 4)
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const o = (y * sw + x) * 4
        data[o] = x < sw / 2 ? 255 : 0     // R
        data[o + 2] = x < sw / 2 ? 0 : 255 // B
        data[o + 3] = 255
      }
    }
    const out = reprojectEquirectToPerspective({ data, width: sw, height: sh }, 0.25, 90, 16, 9)
    expect(out.length).toBe(16 * 9 * 4)
    // Camera centered on the red half: the center pixel must be red.
    const c = ((4 * 16) + 8) * 4
    expect(out[c]!).toBeGreaterThan(200)
    expect(out[c + 2]!).toBeLessThan(60)
    // Alpha fully opaque everywhere.
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255)
  })
})

describe('PhotoSphereModal orbit clamps (720° 球面查看器)', () => {
  it('pitch stops just short of the poles so the camera never gimbal-flips', () => {
    expect(clampPitch(Math.PI)).toBe(PITCH_LIMIT_RAD)
    expect(clampPitch(-Math.PI)).toBe(-PITCH_LIMIT_RAD)
    expect(clampPitch(0.3)).toBe(0.3)
    expect(PITCH_LIMIT_RAD).toBeLessThan(Math.PI / 2)
  })

  it('FOV zoom is bounded to 30–100°', () => {
    expect(clampFov(10)).toBe(30)
    expect(clampFov(180)).toBe(100)
    expect(clampFov(75)).toBe(75)
  })
})
