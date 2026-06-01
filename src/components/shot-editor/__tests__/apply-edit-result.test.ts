import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_ELEMENT_SLOT } from '@/types/storyboard'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { applyEditResult, appendKeyframeHistoryVersion } from '../apply-edit-result'

function resetStores() {
  useCanvasStore.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
  useStoryboardStore.setState({ rows: [] })
}

function addRowWithKeyframeAndBeatVideo() {
  const keyframeItemId = useCanvasItemStore.getState().addItem({
    kind: 'image',
    role: 'keyframe',
    name: 'KF-S1',
    content: 'https://old.test/keyframe.png',
    prompt: 'old keyframe prompt',
  })
  const keyframeNodeId = useCanvasStore.getState().addItemNode(
    keyframeItemId,
    'image',
    { x: 100, y: 100 },
    { width: 280, height: 180 },
  )
  const beatVideoItemId = useCanvasItemStore.getState().addItem({
    kind: 'video',
    role: 'beat-video',
    name: 'BV-S1',
    content: 'https://old.test/beat-video.mp4',
  })
  const beatVideoNodeId = useCanvasStore.getState().addItemNode(
    beatVideoItemId,
    'video',
    { x: 440, y: 100 },
    { width: 360, height: 200 },
  )
  const rowId = useStoryboardStore.getState().addRow({
    shot_number: 'S1',
    duration: 5,
    status: 'completed',
    visual_description: '',
    reference_image: 'https://old.test/keyframe.png',
    keyframeUrl: 'https://old.test/keyframe.png',
    keyframeNodeId,
    beatVideoUrl: 'https://old.test/beat-video.mp4',
    beatVideoNodeId,
    shot_size: '',
    character_actions: '',
    emotion_mood: '',
    emotion_atmosphere: '',
    character_motivation: '',
    character_psychology: '',
    performance_guidance: '',
    scene_tags: '',
    lighting_atmosphere: '',
    sound_effects: '',
    mixing_brief: '',
    dialogue: '',
    storyboard_prompts: '',
    motion_prompts: '',
    bgm: '',
    visual_anchor: '',
    character1: { ...EMPTY_ELEMENT_SLOT },
    character2: { ...EMPTY_ELEMENT_SLOT },
    prop1: { ...EMPTY_ELEMENT_SLOT },
    prop2: { ...EMPTY_ELEMENT_SLOT },
    scene: { ...EMPTY_ELEMENT_SLOT },
  })
  return { rowId, keyframeItemId, keyframeNodeId, beatVideoItemId, beatVideoNodeId }
}

describe('applyEditResult', () => {
  beforeEach(resetStores)

  it('applies association / marked-image edits as keyframe versions without creating a node in the beat-video slot', () => {
    const { rowId, keyframeItemId, keyframeNodeId, beatVideoItemId, beatVideoNodeId } = addRowWithKeyframeAndBeatVideo()

    applyEditResult(rowId, 'https://new.test/keyframe-variant.png', '联想')

    const row = useStoryboardStore.getState().rows.find((r) => r.id === rowId)!
    expect(row.keyframeUrl).toBe('https://new.test/keyframe-variant.png')
    expect(row.reference_image).toBe('https://new.test/keyframe-variant.png')
    expect(row.keyframeNodeId).toBe(keyframeNodeId)
    expect(row.beatVideoUrl).toBe('https://old.test/beat-video.mp4')
    expect(row.beatVideoNodeId).toBe(beatVideoNodeId)

    const items = useCanvasItemStore.getState().items
    expect(items[keyframeItemId].content).toBe('https://new.test/keyframe-variant.png')
    expect(items[keyframeItemId].role).toBe('keyframe')
    expect(items[keyframeItemId].versions?.[0].content).toBe('https://old.test/keyframe.png')
    expect(items[beatVideoItemId].content).toBe('https://old.test/beat-video.mp4')

    const nodes = useCanvasStore.getState().nodes
    expect(nodes).toHaveLength(2)
    expect(nodes.find((n) => n.id === keyframeNodeId)?.position).toEqual({ x: 100, y: 100 })
    expect(nodes.find((n) => n.id === beatVideoNodeId)?.position).toEqual({ x: 440, y: 100 })
  })

  it('records generated-but-not-applied candidates in keyframe versions without changing current keyframe', () => {
    const { rowId, keyframeItemId } = addRowWithKeyframeAndBeatVideo()

    appendKeyframeHistoryVersion(rowId, 'https://new.test/unapplied-candidate.png')

    const row = useStoryboardStore.getState().rows.find((r) => r.id === rowId)!
    const item = useCanvasItemStore.getState().items[keyframeItemId]
    expect(row.keyframeUrl).toBe('https://old.test/keyframe.png')
    expect(item.content).toBe('https://old.test/keyframe.png')
    expect(item.versions?.[0].content).toBe('https://new.test/unapplied-candidate.png')
  })
})
