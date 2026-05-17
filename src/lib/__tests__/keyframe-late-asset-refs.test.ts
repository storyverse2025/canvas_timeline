import { beforeEach, describe, expect, it } from 'vitest'
import { parseAndValidateStoryboard } from '@/lib/storyboard-parser'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'

/**
 * Regression: art-director starts asset image generation in the background
 * while the storyboard table is being written. If parsing happens BEFORE an
 * asset image finishes, slot.image must NOT be permanently wedged at '' —
 * the short-id must survive so resolveSlotNode can re-resolve via the live
 * canvas-item-store at keyframe time.
 */

function resetStores() {
  useCanvasStore.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
  useAssetStore.setState({ assets: [] })
}

describe('keyframe refs when asset image arrives late', () => {
  beforeEach(() => {
    resetStores()
  })

  it('parser preserves [node:xxxx] short-id when item content is still empty', () => {
    // Mimic art-director: create item with empty content (background gen pending)
    const itemId = useCanvasItemStore.getState().addItem({
      kind: 'image',
      name: '少年',
      content: '', // <-- not yet generated
      role: 'character',
    })
    const nodeId = useCanvasStore.getState().addItemNode(
      itemId, 'image', { x: 0, y: 0 }, { width: 200, height: 200 },
    )

    const shortId = nodeId.slice(0, 8)
    const storyboard = JSON.stringify([
      {
        shot_number: 'S1',
        duration: 3,
        visual_description: '少年推门入雨。',
        character1: { image: `[node:${shortId}]`, description: '少年' },
      },
    ])

    const result = parseAndValidateStoryboard(storyboard)
    expect(result.ok).toBe(true)

    // Critical assertion: slot.image is NOT '' — short-id survives so the
    // keyframe resolver can recover when the image lands later.
    const ch1 = result.rows![0].character1
    expect(ch1.image).not.toBe('')
    expect(ch1.image).toContain(shortId)
    // nodeId was successfully resolved.
    expect(ch1.nodeId).toBe(nodeId)
  })

  it('parser uses the real URL once item content has been patched in', () => {
    const url = 'https://example.com/char1.png'
    const itemId = useCanvasItemStore.getState().addItem({
      kind: 'image',
      name: '少年',
      content: url, // <-- background gen finished
      role: 'character',
    })
    const nodeId = useCanvasStore.getState().addItemNode(
      itemId, 'image', { x: 0, y: 0 }, { width: 200, height: 200 },
    )
    const shortId = nodeId.slice(0, 8)

    const storyboard = JSON.stringify([
      {
        shot_number: 'S1',
        duration: 3,
        visual_description: '少年推门入雨。',
        character1: { image: `[node:${shortId}]`, description: '少年' },
      },
    ])

    const result = parseAndValidateStoryboard(storyboard)
    expect(result.ok).toBe(true)
    expect(result.rows![0].character1.image).toBe(url)
    expect(result.rows![0].character1.nodeId).toBe(nodeId)
  })
})
