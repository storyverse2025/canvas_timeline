import { describe, expect, it } from 'vitest'
import { collectKeyframeHistory } from '../keyframe-history'
import type { StoryboardRow } from '@/types/storyboard'
import type { CanvasItem } from '@/stores/canvas-item-store'

const row = {
  id: 'row-1',
  shot_number: 'S1',
  keyframeUrl: 'https://current.test/kf.png',
} as StoryboardRow

function imageItem(patch: Partial<CanvasItem>): CanvasItem {
  return {
    id: patch.id ?? 'item-1',
    kind: 'image',
    name: patch.name ?? 'KF-S1',
    content: patch.content ?? 'https://current.test/kf.png',
    role: patch.role ?? 'keyframe',
    versions: patch.versions,
    createdAt: patch.createdAt ?? 100,
  }
}

describe('collectKeyframeHistory', () => {
  it('includes the current keyframe item and its stored versions in the shot-editor history strip', () => {
    const items: Record<string, CanvasItem> = {
      item1: imageItem({
        id: 'item1',
        content: 'https://current.test/kf.png',
        versions: [
          { content: 'https://candidate.test/not-applied.png', timestamp: 300 },
          { content: 'https://old.test/previous.png', timestamp: 200 },
        ],
      }),
      bv: {
        id: 'bv',
        kind: 'video',
        name: 'BV-S1',
        content: 'https://video.test/bv.mp4',
        role: 'beat-video',
        createdAt: 400,
      },
    }

    const history = collectKeyframeHistory(row, items)

    expect(history.map((h) => h.content)).toEqual([
      'https://current.test/kf.png',
      'https://candidate.test/not-applied.png',
      'https://old.test/previous.png',
    ])
    expect(history.every((h) => h.content.endsWith('.mp4') === false)).toBe(true)
  })

  it('dedupes by URL when an applied candidate is both current and in versions', () => {
    const history = collectKeyframeHistory(row, {
      item1: imageItem({
        id: 'item1',
        content: 'https://candidate.test/applied.png',
        createdAt: 500,
        versions: [
          { content: 'https://candidate.test/applied.png', timestamp: 300 },
          { content: 'https://old.test/previous.png', timestamp: 200 },
        ],
      }),
    })

    expect(history.map((h) => h.content)).toEqual([
      'https://candidate.test/applied.png',
      'https://old.test/previous.png',
    ])
  })
})
