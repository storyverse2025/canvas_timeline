import { describe, expect, it } from 'vitest'
import { collectBeatVideoHistory, collectKeyframeHistory } from '../keyframe-history'
import type { StoryboardRow } from '@/types/storyboard'
import type { CanvasItem } from '@/stores/canvas-item-store'

const row = {
  id: 'row-1',
  shot_number: 'S1',
  keyframeUrl: 'https://current.test/kf.png',
  beatVideoUrl: 'https://current.test/bv.mp4',
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

function videoItem(patch: Partial<CanvasItem>): CanvasItem {
  return {
    id: patch.id ?? 'video-1',
    kind: 'video',
    name: patch.name ?? 'BV-S1',
    content: patch.content ?? 'https://current.test/bv.mp4',
    role: patch.role ?? 'beat-video',
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

describe('collectBeatVideoHistory', () => {
  it('includes the selected beat video plus prior video versions and alternates', () => {
    const history = collectBeatVideoHistory(row, {
      primary: videoItem({
        id: 'primary',
        content: 'https://current.test/bv.mp4',
        createdAt: 500,
        versions: [
          { content: 'https://candidate.test/bv-v2.mp4', timestamp: 300 },
          { content: 'https://old.test/bv-v1.mp4', timestamp: 200 },
        ],
      }),
      alternate: videoItem({
        id: 'alternate',
        name: 'BV-S1-fast-motion',
        role: 'beat-video-alternate',
        content: 'https://alternate.test/bv-alt.mp4',
        createdAt: 400,
      }),
      keyframe: imageItem({ id: 'keyframe', content: 'https://ignore.test/kf.png' }),
    })

    expect(history.map((h) => h.content)).toEqual([
      'https://current.test/bv.mp4',
      'https://alternate.test/bv-alt.mp4',
      'https://candidate.test/bv-v2.mp4',
      'https://old.test/bv-v1.mp4',
    ])
    expect(history.every((h) => h.content.endsWith('.png') === false)).toBe(true)
  })

  it('shows a row-only selected beat video when the canvas item is missing', () => {
    const history = collectBeatVideoHistory(row, {})

    expect(history).toHaveLength(1)
    expect(history[0]?.content).toBe('https://current.test/bv.mp4')
    expect(history[0]?.isRowOnly).toBe(true)
  })
})
