import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const source = readFileSync(resolve(__dirname, '../ShotEditorOverlay.tsx'), 'utf8')

describe('ShotEditorOverlay media layout', () => {
  it('renders the current keyframe with the same full-width responsive sizing as the current beat video', () => {
    expect(source).toContain('className="w-full h-auto max-h-[40vh] rounded bg-black object-contain"')
    expect(source).toContain('className="w-full h-auto max-h-[40vh] object-contain rounded"')
    expect(source).not.toContain('className="max-w-full max-h-full object-contain rounded"')
  })
})
