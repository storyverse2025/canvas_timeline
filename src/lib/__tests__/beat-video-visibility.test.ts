import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'

const storyboardGenerateSource = readFileSync('src/hooks/useStoryboardGenerate.ts', 'utf8')
const batchGenerateSource = readFileSync('src/hooks/useBatchGenerate.ts', 'utf8')
const assetCanvasSource = readFileSync('src/components/canvas/AssetCanvas.tsx', 'utf8')

describe('Beat Video visibility regression contract', () => {
  it('stores Beat Video generation output as a real video canvas item/node, not a fake image', () => {
    const beatVideoSection = storyboardGenerateSource.slice(
      storyboardGenerateSource.indexOf('const generateBeatVideo'),
    )

    expect(beatVideoSection).toContain("kind: 'video'")
    expect(beatVideoSection).toContain("vidItemId, 'video'")
    // Video nodes render through ImageCanvasNode (it dispatches by item.kind
    // and mounts a real <video> element); what this contract guards is that
    // the 'video' node type is registered at all.
    expect(assetCanvasSource).toMatch(/video: (Image|Video)CanvasNode/)
  })

  it('does not let batch Beat Video jobs report done unless the row received a beatVideoUrl', () => {
    expect(batchGenerateSource).toContain("type === 'beat-video'")
    expect(batchGenerateSource).toContain('beatVideoUrl')
    expect(batchGenerateSource).toContain('missing beat video result')
  })

  it('privacy blocks get NO auto-retry — 开白资产 ship on the first shoot, and the removed fallbacks stay removed', () => {
    // By request: no 2D-redraw retry, no runtime invited_images
    // registration. The sanctioned whitelist mechanism is a pre-registered
    // Active asset attached as asset:// on EVERY attempt (matched by
    // character name via resolveShootAvatarRefs before the first shoot);
    // retrying after a block was always one shoot too late.
    expect(storyboardGenerateSource).toContain('resolveShootAvatarRefs')
    expect(storyboardGenerateSource).toContain('fetchByteplusAssets')
    expect(storyboardGenerateSource).not.toContain('stylizeFacesFor2D: true')
    expect(storyboardGenerateSource).not.toContain('registerCharacterRefs')
    expect(storyboardGenerateSource).not.toContain('invitedImageAssetIds')
    // The privacy-block branch explains and rethrows instead of retrying.
    const catchSection = storyboardGenerateSource.slice(
      storyboardGenerateSource.indexOf('catch (firstErr)'),
      storyboardGenerateSource.indexOf('Auto-revise loop'),
    )
    expect(catchSection).toContain('isPrivacyBlock(msg)')
    expect(catchSection).toMatch(/throw\s+firstErr/)
  })

  it('rethrows Beat Video generation failures so batch jobs cannot turn failed generations into success', () => {
    const beatVideoCatchSection = storyboardGenerateSource.slice(
      storyboardGenerateSource.indexOf("toast.error('Beat Video 生成失败'"),
      storyboardGenerateSource.indexOf('}, [updateRow, startTask, updateTask])'),
    )

    expect(beatVideoCatchSection).toMatch(/throw\s+e/)
  })

  it('canvas stores accept video items and create renderable video nodes with video defaults', () => {
    useCanvasItemStore.setState({ items: {} })
    useCanvasStore.getState().clearAll()

    const itemId = useCanvasItemStore.getState().addItem({
      kind: 'video',
      name: 'BV-S1',
      content: 'https://cdn.example.com/generated-video-without-mp4-suffix',
    })
    const nodeId = useCanvasStore.getState().addItemNode(itemId, 'video', { x: 10, y: 20 })

    const item = useCanvasItemStore.getState().items[itemId]
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)

    expect(item.kind).toBe('video')
    expect(node?.type).toBe('video')
    expect(node?.width).toBe(360)
    expect(node?.height).toBe(200)
  })
})
