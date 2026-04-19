import { describe, it, expect } from 'vitest'

describe('Batch Generation — concurrency logic', () => {
  it('processes items with concurrency limit', async () => {
    const MAX = 2
    const results: number[] = []
    let running = 0
    let maxRunning = 0

    const items = [1, 2, 3, 4, 5]
    const queue = [...items]

    const processNext = async () => {
      while (queue.length > 0) {
        const item = queue.shift()!
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 10)) // simulate async work
        results.push(item)
        running--
      }
    }

    const workers = Array.from({ length: MAX }, () => processNext())
    await Promise.all(workers)

    expect(results.sort()).toEqual([1, 2, 3, 4, 5])
    expect(maxRunning).toBeLessThanOrEqual(MAX)
  })

  it('handles errors without stopping batch', async () => {
    const items = ['ok1', 'fail', 'ok2']
    const results: string[] = []
    const errors: string[] = []

    for (const item of items) {
      try {
        if (item === 'fail') throw new Error('test error')
        results.push(item)
      } catch (e) {
        errors.push(String((e as Error).message))
      }
    }

    expect(results).toEqual(['ok1', 'ok2'])
    expect(errors).toEqual(['test error'])
  })
})

describe('Batch State tracking', () => {
  it('calculates progress correctly', () => {
    const jobs = [
      { rowId: '1', shotNumber: 'S1', status: 'done' as const },
      { rowId: '2', shotNumber: 'S2', status: 'running' as const },
      { rowId: '3', shotNumber: 'S3', status: 'pending' as const },
      { rowId: '4', shotNumber: 'S4', status: 'error' as const, error: 'fail' },
    ]
    const completedCount = jobs.filter((j) => j.status === 'done' || j.status === 'error').length
    const pct = Math.round((completedCount / jobs.length) * 100)
    expect(completedCount).toBe(2)
    expect(pct).toBe(50)
  })
})
