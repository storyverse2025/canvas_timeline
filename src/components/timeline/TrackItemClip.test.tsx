import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TrackItemClip } from './TrackItemClip'
import type { TimelineItem } from '@/types/timeline'

const baseItem: TimelineItem = {
  id: 'clip-1',
  trackId: 'track-1',
  type: 'keyframe',
  startTime: 0,
  duration: 5,
  label: 'Storyboard clip',
}

function renderClip(item: TimelineItem) {
  return renderToStaticMarkup(
    <TrackItemClip
      item={item}
      zoom={1}
      onDelete={vi.fn()}
      onResize={vi.fn()}
      onMove={vi.fn()}
    />,
  )
}

describe('TrackItemClip image rendering', () => {
  it('does not render a storyboard image when imageUrl is empty', () => {
    const html = renderClip({
      ...baseItem,
      data: { imageUrl: '' },
    })

    expect(html).not.toContain('<img')
    expect(html).not.toContain('src=""')
  })
})
