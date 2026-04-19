import { describe, it, expect } from 'vitest'
import { collectExportItems } from '@/lib/batch-export'
import type { StoryboardRow } from '@/types/storyboard'

const EMPTY_SLOT = { image: '', description: '', nodeId: '' }

function makeRow(overrides: Partial<StoryboardRow> & { shot_number: string }): StoryboardRow {
  return {
    id: `row-${overrides.shot_number}`,
    createdAt: Date.now(),
    shot_number: overrides.shot_number,
    duration: 3,
    visual_description: '',
    visual_anchor: '',
    reference_image: '',
    shot_size: '',
    character_actions: '',
    emotion_mood: '',
    scene_tags: '',
    lighting_atmosphere: '',
    sound_effects: '',
    dialogue: '',
    dialogue_audio: '',
    storyboard_prompts: '',
    motion_prompts: '',
    bgm: '',
    bgm_audio: '',
    character1: { ...EMPTY_SLOT },
    character2: { ...EMPTY_SLOT },
    prop1: { ...EMPTY_SLOT },
    prop2: { ...EMPTY_SLOT },
    scene: { ...EMPTY_SLOT },
    ...overrides,
  }
}

describe('collectExportItems', () => {
  it('returns empty for no rows', () => {
    expect(collectExportItems([], true, true)).toHaveLength(0)
  })

  it('collects keyframes from keyframeUrl', () => {
    const rows = [
      makeRow({ shot_number: 'S1', keyframeUrl: 'https://example.com/kf1.jpg' }),
      makeRow({ shot_number: 'S2' }), // no keyframe
      makeRow({ shot_number: 'S3', reference_image: 'https://example.com/ref3.png' }),
    ]
    const items = collectExportItems(rows, true, false)
    expect(items).toHaveLength(2)
    expect(items[0].filename).toBe('S1_keyframe.jpg')
    expect(items[1].filename).toBe('S3_keyframe.jpg')
  })

  it('collects beat videos', () => {
    const rows = [
      makeRow({ shot_number: 'S1', beatVideoUrl: 'https://example.com/v1.mp4' }),
      makeRow({ shot_number: 'S2', beatVideoUrl: 'https://example.com/v2.mp4' }),
    ]
    const items = collectExportItems(rows, false, true)
    expect(items).toHaveLength(2)
    expect(items[0].type).toBe('beat-video')
    expect(items[0].filename).toBe('S1_beat_video.mp4')
  })

  it('collects both when enabled', () => {
    const rows = [
      makeRow({ shot_number: 'S1', keyframeUrl: 'url1', beatVideoUrl: 'url2' }),
    ]
    const items = collectExportItems(rows, true, true)
    expect(items).toHaveLength(2)
    expect(items[0].type).toBe('keyframe')
    expect(items[1].type).toBe('beat-video')
  })

  it('skips rows without URLs', () => {
    const rows = [
      makeRow({ shot_number: 'S1' }), // no media
    ]
    expect(collectExportItems(rows, true, true)).toHaveLength(0)
  })
})
