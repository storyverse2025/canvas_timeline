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

  it('does not rewrite Seedance image_url parts to unsupported SVG data URLs', () => {
    const parts = [
      { type: 'text', text: 'animate this' },
      { type: 'image_url', image_url: { url: 'https://example.com/first.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://example.com/last.png' }, role: 'last_frame' },
    ]

    const retryParts = buildSeedanceGridRetryContentParts(parts)

    expect(retryParts[0]).toBe(parts[0])
    expect(retryParts[1]).toEqual(parts[1])
    expect(retryParts[2]).toEqual(parts[2])
    expect((retryParts[1].image_url as { url: string }).url).not.toMatch(/^data:image\/svg\+xml/)
    expect((retryParts[2].image_url as { url: string }).url).not.toMatch(/^data:image\/svg\+xml/)
  })
})
