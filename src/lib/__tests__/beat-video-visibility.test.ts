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
      storyboardGenerateSource.indexOf('return { generateKeyframe, generateBeatVideo }'),
    )

    expect(beatVideoSection).toContain("kind: 'video'")
    expect(beatVideoSection).toContain("vidItemId, 'video'")
    expect(assetCanvasSource).toContain('video: VideoCanvasNode')
  })

  it('does not let batch Beat Video jobs report done unless the row received a beatVideoUrl', () => {
    expect(batchGenerateSource).toContain("type === 'beat-video'")
    expect(batchGenerateSource).toContain('beatVideoUrl')
    expect(batchGenerateSource).toContain('missing beat video result')
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
