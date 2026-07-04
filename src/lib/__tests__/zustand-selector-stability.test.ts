import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression contract for the "Maximum update depth exceeded" crash
 * (2026-07-03, 导演助手 regenerate).
 *
 * Root cause: a zustand selector that mints a fresh reference when the
 * field is undefined —
 *
 *   useProjectDB((s) => s.script.castingCards ?? [])
 *
 * `castingCards` defaults to undefined in project-db, so every getSnapshot
 * returned a brand-new `[]`. React's useSyncExternalStore compares
 * snapshots with Object.is, saw a change on every check, and looped
 * forceStoreRerender until "Maximum update depth exceeded".
 *
 * The rule this test enforces: never default with `?? []` / `?? {}` (or
 * any fresh literal) INSIDE a store selector. Select the raw value and
 * default OUTSIDE the hook with a module-level constant:
 *
 *   const EMPTY_CARDS: Card[] = []
 *   const cards = useProjectDB((s) => s.script.castingCards) ?? EMPTY_CARDS
 */

const ROOTS = ['src/components', 'src/hooks']

// use<Anything>Store(...) or use<Anything>DB(...) with an arrow selector on
// one line whose body ends in `?? []` or `?? {}` — the exact landmine shape.
const INLINE_DEFAULT_SELECTOR = /use[A-Z]\w*(?:Store|DB)\(\s*\(\w+\)\s*=>[^)\n]*\?\?\s*(?:\[\]|\{\})\s*\)/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...walk(p))
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) {
      out.push(p)
    }
  }
  return out
}

describe('zustand selector stability contract', () => {
  it('no component/hook selector defaults to a fresh [] or {} inside the selector', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (INLINE_DEFAULT_SELECTOR.test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`)
          }
        })
      }
    }
    expect(
      offenders,
      `Inline \`?? []\`/\`?? {}\` inside a zustand selector mints a fresh reference per getSnapshot and infinite-loops React (Maximum update depth exceeded). Default OUTSIDE the selector with a module-level constant.\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
