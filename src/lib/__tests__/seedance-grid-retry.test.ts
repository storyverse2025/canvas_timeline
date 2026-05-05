import { describe, expect, it } from 'vitest'

import {
  buildSeedanceGridRetryContentParts,
  createSeedanceGridOverlayImageUrl,
} from '../../../vite-capabilities-plugin'

describe('Seedance grid-overlay retry helpers', () => {
  it('wraps an input image in a 6x6 white grid with 12px fully opaque lines', () => {
    const dataUrl = createSeedanceGridOverlayImageUrl('https://example.com/face.png')

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)

    const svg = Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8')
    expect(svg).toContain('href="https://example.com/face.png"')
    expect(svg).toContain('stroke="white"')
    expect(svg).toContain('stroke-width="12"')
    expect(svg).toContain('stroke-opacity="1"')
    expect(svg).toContain('data-grid="6x6"')
  })

  it('only rewrites Seedance image_url parts and preserves their frame roles', () => {
    const parts = [
      { type: 'text', text: 'animate this' },
      { type: 'image_url', image_url: { url: 'https://example.com/first.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://example.com/last.png' }, role: 'last_frame' },
    ]

    const retryParts = buildSeedanceGridRetryContentParts(parts)

    expect(retryParts[0]).toBe(parts[0])
    expect(retryParts[1]).toMatchObject({ type: 'image_url', role: 'first_frame' })
    expect(retryParts[2]).toMatchObject({ type: 'image_url', role: 'last_frame' })

    const firstUrl = (retryParts[1].image_url as { url: string }).url
    const lastUrl = (retryParts[2].image_url as { url: string }).url
    expect(firstUrl).not.toBe('https://example.com/first.png')
    expect(lastUrl).not.toBe('https://example.com/last.png')

    const firstSvg = Buffer.from(firstUrl.split(',')[1], 'base64').toString('utf8')
    const lastSvg = Buffer.from(lastUrl.split(',')[1], 'base64').toString('utf8')
    expect(firstSvg).toContain('href="https://example.com/first.png"')
    expect(lastSvg).toContain('href="https://example.com/last.png"')
  })
})
