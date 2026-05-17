import { describe, it, expect, beforeEach } from 'vitest'
import { buildCanvasContext, summarizeMediaUrl } from '@/lib/canvas-context'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'

/**
 * Regression: a few in-browser-generated data: URLs in canvas items used to
 * blow buildCanvasContext output past 22MB, which crashed the hermes bridge
 * via spawn E2BIG (argv > ARG_MAX). The summarizer must never leak the body.
 */
describe('summarizeMediaUrl', () => {
  it('returns "(无)" for empty / null / undefined', () => {
    expect(summarizeMediaUrl(undefined)).toBe('(无)')
    expect(summarizeMediaUrl(null)).toBe('(无)')
    expect(summarizeMediaUrl('')).toBe('(无)')
  })

  it('replaces data: URL body with mime + KB summary', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(100_000)
    const out = summarizeMediaUrl(big)
    expect(out).toMatch(/^\[image\/png ~\d+KB inline\]$/)
    expect(out.length).toBeLessThan(40)
  })

  it('keeps short http URLs verbatim', () => {
    const url = 'https://cdn.example.com/img/abc123.png'
    expect(summarizeMediaUrl(url)).toBe(url)
  })

  it('truncates very long http URLs with byte count', () => {
    const url = 'https://example.com/' + 'q'.repeat(500)
    const out = summarizeMediaUrl(url)
    expect(out.length).toBeLessThan(260)
    expect(out).toMatch(/\[\+\d+c\]$/)
  })
})

describe('buildCanvasContext — no data: URL bodies in output', () => {
  beforeEach(() => {
    useCanvasStore.getState().clearAll()
    useCanvasItemStore.setState({ items: {} })
    useAssetStore.setState({ assets: [] })
  })

  it('summarizes a 1MB data: URL on an item node instead of dumping it', () => {
    const itemId = useCanvasItemStore.getState().addItem({
      kind: 'image',
      name: '少年',
      content: 'data:image/png;base64,' + 'A'.repeat(1_000_000),
      role: 'character',
    })
    useCanvasStore.getState().addItemNode(itemId, 'image', { x: 0, y: 0 })

    const out = buildCanvasContext()
    // Output stays small — no base64 body leaks in.
    expect(out.length).toBeLessThan(500)
    expect(out).not.toContain('AAAAAAA')
    expect(out).toMatch(/image\/png ~\d+KB inline/)
  })

  it('summarizes a 500KB data: URL on an asset node instead of dumping it', () => {
    useAssetStore.setState({
      assets: [{
        id: 'a1',
        type: 'character',
        name: '少女',
        description: 'hero',
        imageUrl: 'data:image/jpeg;base64,' + 'B'.repeat(500_000),
        createdAt: Date.now(),
      } as never],
    })
    useCanvasStore.getState().addNode('a1', { x: 0, y: 0 })

    const out = buildCanvasContext()
    expect(out.length).toBeLessThan(500)
    expect(out).not.toContain('BBBBBBB')
    expect(out).toMatch(/image\/jpeg ~\d+KB inline/)
  })
})
