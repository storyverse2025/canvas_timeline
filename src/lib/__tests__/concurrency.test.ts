import { describe, expect, it, vi } from 'vitest'
import { runWithConcurrency } from '@/lib/concurrency'

describe('runWithConcurrency', () => {
  it('returns one result per input, preserving original order', async () => {
    const items = [1, 2, 3, 4, 5]
    const results = await runWithConcurrency(items, 2, async (n) => n * 10)
    expect(results.map((r) => r.value)).toEqual([10, 20, 30, 40, 50])
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('caps concurrent workers at the limit (never exceeds `limit`)', async () => {
    let inFlight = 0
    let observedPeak = 0
    const results = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async () => {
      inFlight++
      observedPeak = Math.max(observedPeak, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return 'ok'
    })
    expect(results).toHaveLength(10)
    expect(observedPeak).toBeLessThanOrEqual(3)
    // The pool should be saturated for at least one tick, so peak ≥ 3 unless
    // items < limit (10 ≥ 3 so this must hold).
    expect(observedPeak).toBeGreaterThanOrEqual(3)
  })

  it('captures per-item errors instead of aborting the pool', async () => {
    const worker = vi.fn(async (n: number) => {
      if (n % 2 === 0) throw new Error(`evens fail: ${n}`)
      return n
    })
    const results = await runWithConcurrency([1, 2, 3, 4], 2, worker)
    expect(results[0]).toMatchObject({ ok: true, value: 1 })
    expect(results[1]).toMatchObject({ ok: false })
    expect(results[1].error?.message).toBe('evens fail: 2')
    expect(results[2]).toMatchObject({ ok: true, value: 3 })
    expect(results[3]).toMatchObject({ ok: false })
    // All four items must have been attempted — pool didn't abort early.
    expect(worker).toHaveBeenCalledTimes(4)
  })

  it('handles empty input without spawning workers', async () => {
    const worker = vi.fn(async () => 'unused')
    const results = await runWithConcurrency([], 5, worker)
    expect(results).toEqual([])
    expect(worker).not.toHaveBeenCalled()
  })

  it('clamps limit ≤ 0 to 1 (no-op-safe default)', async () => {
    const results = await runWithConcurrency([1, 2], 0, async (n) => n + 100)
    expect(results.map((r) => r.value)).toEqual([101, 102])
  })

  it('clamps limit > items.length to items.length (no idle workers)', async () => {
    let inFlight = 0
    let peak = 0
    await runWithConcurrency([1, 2], 50, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('worker callback receives the original index (for indexed side-effects)', async () => {
    const indices: number[] = []
    await runWithConcurrency(['a', 'b', 'c'], 2, async (_, i) => {
      indices.push(i)
    })
    expect(indices.sort()).toEqual([0, 1, 2])
  })
})
