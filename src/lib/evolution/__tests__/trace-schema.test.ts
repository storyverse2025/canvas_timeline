import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { traceRecordSchema } from '../trace-schema'

describe('traceRecordSchema', () => {
  it('accepts a minimal evolve-source record (as written by the trace plugin)', () => {
    const row = {
      traceId: 'tr-selftest',
      source: 'evolve',
      capability: 'self-test',
      inputs: [],
      durationMs: 1,
      status: 'ok',
      ts: 1783486545575,
      harnessVersion: { sha: 'a2ff115b', branch: 'main', dirty: true },
    }
    expect(traceRecordSchema.safeParse(row).success).toBe(true)
  })

  it('rejects a record without capability/status', () => {
    expect(traceRecordSchema.safeParse({ traceId: 'x', ts: 1, inputs: [] }).success).toBe(false)
  })

  it('parses every line in the local trace store, when present', () => {
    const dir = join(process.cwd(), 'evolution', 'traces')
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim())
      for (const line of lines) {
        const parsed = traceRecordSchema.safeParse(JSON.parse(line))
        expect(parsed.success, `bad trace line in ${f}: ${line.slice(0, 120)}`).toBe(true)
      }
    }
  })
})
