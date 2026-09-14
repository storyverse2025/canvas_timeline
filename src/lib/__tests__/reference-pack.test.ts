import { describe, expect, it } from 'vitest'
import { buildReferencePack } from '@/lib/reference-pack'
import { StoryboardRowSchema, type StoryboardRow } from '@/types/storyboard'

/** Minimal valid row; schema defaults fill the prose columns. */
function makeRow(patch: Partial<StoryboardRow> = {}): StoryboardRow {
  const base = StoryboardRowSchema.parse({ shot_number: 'S1', duration: 5 })
  return { ...base, id: 'row-1', createdAt: 0, ...patch }
}

describe('buildReferencePack', () => {
  it('keeps /uploads/ refs — 身份版/分镜/机位 must survive into the pack (regression: pack degenerated to a lone scene image)', () => {
    // Every generated image is persisted server-side as /uploads/<uuid>;
    // the old validator dropped them all, so Seedance received only the
    // data:/https scene plate and lost casting + first-frame anchoring.
    const row = makeRow({
      character1: { image: '', description: '艾琳，短发', nodeId: '' },
      identitySheet1Url: '/uploads/id1.png',
      scene: { image: 'data:image/jpeg;base64,AAAA', description: '机甲驾驶舱', nodeId: '' },
      keyframeUrl: '/uploads/grid.png',
      keyframeCleanUrl: '/uploads/clean.png',
    })
    const pack = buildReferencePack(row)
    // Storyboard grid ALWAYS leads (most important reference — the action /
    // staging authority the video must follow); the rest keep their order.
    expect(pack.map((p) => p.kind)).toEqual(['storyboard', 'character', 'scene', 'camera'])
    expect(pack[0]!.url).toBe('/uploads/grid.png')
    const char = pack.find((p) => p.kind === 'character')!
    expect(char.url).toBe('/uploads/id1.png')
    expect(char.subject).toBe('艾琳')
    expect(pack.find((p) => p.kind === 'camera')!.url).toBe('/uploads/clean.png')
  })

  it('includes prop slot images (道具图) between characters and the scene', () => {
    const row = makeRow({
      character1: { image: 'https://cdn/char1.png', description: '艾琳', nodeId: '' },
      prop1: { image: 'https://cdn/blade.png', description: '高频震荡刃，白色陶瓷长刃', nodeId: '' },
      prop2: { image: '', description: '仅文字道具（不进 pack，走 contextRefs）', nodeId: '' },
      scene: { image: 'https://cdn/scene.png', description: '驾驶舱', nodeId: '' },
      keyframeCleanUrl: 'https://cdn/clean.png',
    })
    const pack = buildReferencePack(row)
    expect(pack.map((p) => p.kind)).toEqual(['character', 'prop', 'scene', 'camera'])
    const prop = pack.find((p) => p.kind === 'prop')!
    expect(prop.url).toBe('https://cdn/blade.png')
    expect(prop.subject).toBe('高频震荡刃')
    expect(prop.label).toContain('道具图')
  })

  it('returns [] when the 机位/开场构图 anchor did not survive validation — caller must fall back to the legacy keyframe path', () => {
    // A pack that replaces the keyframe inputs but carries no camera anchor
    // ships e.g. a lone scene plate; the legacy path (keyframeUrl passed
    // through untouched, server-side validation) is strictly better then.
    const row = makeRow({
      scene: { image: 'https://cdn/scene.png', description: '驾驶舱', nodeId: '' },
      reference_image: '[node:abc123]', // stale marker — invalid everywhere
    })
    expect(buildReferencePack(row)).toEqual([])
  })

  it('grid-fail rows (only keyframeCleanUrl left) still pack scene + camera, no storyboard entry', () => {
    const row = makeRow({
      scene: { image: 'data:image/jpeg;base64,AAAA', description: '驾驶舱', nodeId: '' },
      keyframeCleanUrl: '/uploads/clean.png',
      // keyframeUrl / reference_image cleared by the grid-fail branch.
    })
    const pack = buildReferencePack(row)
    expect(pack.map((p) => p.kind)).toEqual(['scene', 'camera'])
  })

  it('returns [] for legacy rows with nothing beyond the keyframe pair', () => {
    const row = makeRow({
      keyframeUrl: '/uploads/grid.png',
      keyframeCleanUrl: '/uploads/clean.png',
    })
    expect(buildReferencePack(row)).toEqual([])
  })

  it('de-duplicates: keyframeUrl === keyframeCleanUrl produces a single camera entry and no storyboard entry', () => {
    const row = makeRow({
      character1: { image: 'https://cdn/char1.png', description: '艾琳', nodeId: '' },
      keyframeUrl: 'https://cdn/kf.png',
      keyframeCleanUrl: 'https://cdn/kf.png',
    })
    const pack = buildReferencePack(row)
    expect(pack.filter((p) => p.kind === 'storyboard')).toHaveLength(0)
    expect(pack.filter((p) => p.url === 'https://cdn/kf.png')).toHaveLength(1)
  })
})
