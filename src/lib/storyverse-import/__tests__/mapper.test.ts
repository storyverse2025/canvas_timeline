import { describe, it, expect } from 'vitest'
import {
  extractVisualDescription,
  mapBundleToCanvas,
  parseReferenceBlock,
  roleForCategory,
  slotKindForTag,
} from '../mapper'
import type { SvBundle, SvReference } from '../types'

/**
 * Fixture shaped exactly like what vite-storyverse-plugin returns for a real
 * project (GBTM EP32 / Cursed by Golden Eyes): a `[REFERENCES]` block naming
 * char/scene/prop slots, reference storage paths index-aligned with it, and
 * frames that carry a storyboard image while shots carry the beat video.
 */
const FRAME_PROMPT = `BEAT_NUMBER: 1

[REFERENCES]
(image1) <char1> @Maya Reyes - East Asian woman, rust-orange dress
(image2) <scene> @Contemporary luxury private study - walnut study with hidden safe
(image3) <prop1> @Flush contemporary hidden safe - gray hidden safe door

[SPATIAL REFERENCE GOAL]
single wide spatial blocking master reference locking char1 against the honor wall

[STYLE]
cinematic`

/** A reference that resolves to the asset library's CURRENT image. */
function ref(path: string, name: string, category: string, url: string): SvReference {
  return { path, url, assetId: `a-${name}`, assetName: name, assetCategory: category, isActiveVersion: true }
}

function bundle(overrides: Partial<SvBundle> = {}): SvBundle {
  return {
    project: { id: 'p1', title: '测试项目', status: 'draft', updatedAt: '2026-09-10T00:00:00Z' },
    episodes: [{ id: 'e1', number: 1, title: 'The Collar Camera', summary: '梗概', script: 'Episode 1\nLogline: …' }],
    assets: [
      { id: 'a1', category: 'character', name: 'Maya Reyes', prompt: 'a woman', storagePath: 'u/p/assets/maya.png', imageUrl: '/uploads/sv-maya.png' },
      { id: 'a2', category: 'environment', name: 'Contemporary luxury private study', prompt: 'a study', storagePath: 'u/p/assets/study.png', imageUrl: '/uploads/sv-study.png' },
      { id: 'a3', category: 'property', name: 'Flush contemporary hidden safe', prompt: 'a safe', storagePath: 'u/p/assets/safe.png', imageUrl: '/uploads/sv-safe.png' },
    ],
    rows: [
      {
        frameId: 'f1', shotId: 's1', episodeNumber: 1, episodeTitle: 'The Collar Camera',
        frameNumber: 1, shotType: '中景', description: '', framePrompt: FRAME_PROMPT,
        shotPrompt: '你是一个爆款短剧的导演…', displayPrompt: '', dialogue: 'Maya: Let us hope.',
        durationSeconds: 8, keyframeUrl: '/uploads/sv-kf1.png',
        videoUrl: 'https://x.supabase.co/storage/v1/object/sign/assets/shot1.mp4?token=t',
        references: [
          ref('u/p/assets/maya.png', 'Maya Reyes', 'character', '/uploads/sv-maya.png'),
          ref('u/p/assets/study.png', 'Contemporary luxury private study', 'environment', '/uploads/sv-study.png'),
          ref('u/p/assets/safe.png', 'Flush contemporary hidden safe', 'property', '/uploads/sv-safe.png'),
        ],
      },
      {
        frameId: 'f2', shotId: 's2', episodeNumber: 1, episodeTitle: 'The Collar Camera',
        frameNumber: 2, shotType: '', description: '手动写的画面描述', framePrompt: '',
        shotPrompt: '', displayPrompt: '', dialogue: '',
        durationSeconds: 0, keyframeUrl: '', videoUrl: '',
        references: [ref('u/p/assets/study.png', 'Contemporary luxury private study', 'environment', '/uploads/sv-study.png')],
      },
    ],
    stats: { localizedFiles: 5, videosLocalized: false, elapsedMs: 10 },
    ...overrides,
  }
}

/** Deterministic ids so assertions can reference nodes by position. */
function counterIds() {
  let n = 0
  return () => `id${++n}`
}

describe('parseReferenceBlock', () => {
  it('parses index, slot tag, name and description', () => {
    const refs = parseReferenceBlock(FRAME_PROMPT)
    expect(refs).toEqual([
      { imageIndex: 1, tag: 'char1', name: 'Maya Reyes', description: 'East Asian woman, rust-orange dress' },
      { imageIndex: 2, tag: 'scene', name: 'Contemporary luxury private study', description: 'walnut study with hidden safe' },
      { imageIndex: 3, tag: 'prop1', name: 'Flush contemporary hidden safe', description: 'gray hidden safe door' },
    ])
  })

  it('stops at the next bracketed section and tolerates a missing block', () => {
    expect(parseReferenceBlock(FRAME_PROMPT).some((r) => r.name.includes('single wide'))).toBe(false)
    expect(parseReferenceBlock('no references here')).toEqual([])
    expect(parseReferenceBlock('')).toEqual([])
  })
})

describe('role + slot mapping', () => {
  it('never maps an environment plate to the 360° panorama role', () => {
    // role 'scene' makes ImageCanvasNode render a PanoramaViewer; these are flat.
    expect(roleForCategory('environment')).toBe('scene-view')
    expect(roleForCategory('character')).toBe('character')
    expect(roleForCategory('property')).toBe('prop')
  })

  it('maps reference tags to storyboard slots', () => {
    expect(slotKindForTag('char1')).toBe('character')
    expect(slotKindForTag('CHAR2')).toBe('character')
    expect(slotKindForTag('prop2')).toBe('prop')
    expect(slotKindForTag('scene')).toBe('scene')
    expect(slotKindForTag('lighting')).toBeNull()
  })
})

describe('extractVisualDescription', () => {
  it('prefers the frame description, then the spatial goal', () => {
    const b = bundle()
    expect(extractVisualDescription(b.rows[1])).toBe('手动写的画面描述')
    expect(extractVisualDescription(b.rows[0])).toBe(
      'single wide spatial blocking master reference locking char1 against the honor wall',
    )
  })
})

describe('mapBundleToCanvas', () => {
  it('fills character / scene / prop slots from the reference block and wires them to the keyframe', () => {
    const m = mapBundleToCanvas(bundle(), { makeId: counterIds() })
    const row = m.rows[0]

    expect(row.characters).toHaveLength(1)
    expect(row.characters[0].image).toBe('/uploads/sv-maya.png')
    expect(row.characters[0].description).toBe('Maya Reyes')
    expect(row.props[0].image).toBe('/uploads/sv-safe.png')
    expect(row.scene.image).toBe('/uploads/sv-study.png')

    // Legacy pair fields must mirror the arrays (normalizeRowSlots contract).
    expect(row.character1).toEqual(row.characters[0])
    expect(row.prop1).toEqual(row.props[0])

    // Every slot node feeds the keyframe node; the keyframe feeds the video.
    const slotNodeIds = [row.characters[0].nodeId, row.props[0].nodeId, row.scene.nodeId]
    for (const id of slotNodeIds) {
      expect(m.edges.some((e) => e.source === id && e.target === row.keyframeNodeId)).toBe(true)
    }
    expect(m.edges.some((e) => e.source === row.keyframeNodeId && e.target === row.beatVideoNodeId)).toBe(true)
  })

  it('creates canvas items for assets, keyframes, beat videos and scripts', () => {
    const m = mapBundleToCanvas(bundle(), { makeId: counterIds() })
    expect(m.summary).toMatchObject({ assets: 3, keyframes: 1, videos: 1, rows: 2, scripts: 1 })

    const byRole = (role: string) => m.items.filter((i) => i.role === role)
    expect(byRole('character')).toHaveLength(1)
    expect(byRole('scene-view')).toHaveLength(1)
    expect(byRole('prop')).toHaveLength(1)
    expect(byRole('keyframe')).toHaveLength(1)
    expect(byRole('beat-video')).toHaveLength(1)
    expect(byRole('script')[0].content).toContain('Logline')

    // Every node points at an item that exists — a dangling itemId renders blank.
    const itemIds = new Set(m.items.map((i) => i.id))
    for (const n of m.nodes) expect(itemIds.has(String(n.data.itemId))).toBe(true)
    // ...and every edge endpoint is a real node.
    const nodeIds = new Set(m.nodes.map((n) => n.id))
    for (const e of m.edges) {
      expect(nodeIds.has(e.source)).toBe(true)
      expect(nodeIds.has(e.target)).toBe(true)
    }
  })

  it('keeps durations inside the storyboard schema range', () => {
    const m = mapBundleToCanvas(bundle(), { makeId: counterIds() })
    expect(m.rows[0].duration).toBe(8)
    // 0 / null upstream would fail StoryboardRowSchema's positive() check.
    expect(m.rows[1].duration).toBe(5)
  })

  it('prefixes shot numbers with the episode only when the project is multi-episode', () => {
    const single = mapBundleToCanvas(bundle(), { makeId: counterIds() })
    expect(single.rows.map((r) => r.shot_number)).toEqual(['1', '2'])

    const b = bundle()
    b.rows[1] = { ...b.rows[1], episodeNumber: 2, frameNumber: 1 }
    const multi = mapBundleToCanvas(b, { makeId: counterIds() })
    expect(multi.rows.map((r) => r.shot_number)).toEqual(['E1-01', 'E2-01'])
  })

  it('falls back to asset categories when the prompt has no [REFERENCES] block', () => {
    const m = mapBundleToCanvas(bundle(), { makeId: counterIds() })
    // Row 2 has an empty framePrompt but one environment reference path.
    expect(m.rows[1].scene.image).toBe('/uploads/sv-study.png')
    expect(m.rows[1].characters).toHaveLength(0)
  })

  it('keeps references that point at a superseded asset version', () => {
    // 13% of upstream reference URLs resolve to a version that is no longer
    // the asset's active one. Matching only the active version left these
    // slots empty even though the storyboard plainly used an image.
    const b = bundle()
    b.rows[0] = {
      ...b.rows[0],
      references: [
        {
          path: 'u/p/assets/maya-OLD.png', url: '/uploads/sv-maya-old.png',
          assetId: 'a-Maya Reyes', assetName: 'Maya Reyes', assetCategory: 'character',
          isActiveVersion: false,
        },
        b.rows[0].references[1],
        b.rows[0].references[2],
      ],
    }
    const m = mapBundleToCanvas(b, { makeId: counterIds() })
    const slot = m.rows[0].characters[0]

    expect(slot.image).toBe('/uploads/sv-maya-old.png')
    expect(slot.nodeId).not.toBe('')
    expect(m.summary.referenceOnlyImages).toBe(1)

    // The extra node carries the old image and is labelled as a past version.
    const node = m.nodes.find((n) => n.id === slot.nodeId)!
    const item = m.items.find((i) => i.id === node.data.itemId)!
    expect(item.content).toBe('/uploads/sv-maya-old.png')
    expect(item.name).toBe('Maya Reyes · 旧版')
    expect(item.role).toBe('character')
    // ...and still feeds the keyframe, like any other slot.
    expect(m.edges.some((e) => e.source === slot.nodeId && e.target === m.rows[0].keyframeNodeId)).toBe(true)
  })

  it('keeps a reference whose asset is gone from the library entirely', () => {
    const b = bundle()
    b.rows[0] = {
      ...b.rows[0],
      references: [
        { path: 'u/p/assets/ghost.png', url: '/uploads/sv-ghost.png', assetId: '', assetName: '', assetCategory: '', isActiveVersion: false },
        b.rows[0].references[1],
        b.rows[0].references[2],
      ],
    }
    const m = mapBundleToCanvas(b, { makeId: counterIds() })
    expect(m.rows[0].characters[0].image).toBe('/uploads/sv-ghost.png')
    // Falls back to the name the [REFERENCES] block gave it.
    const node = m.nodes.find((n) => n.id === m.rows[0].characters[0].nodeId)!
    expect(m.items.find((i) => i.id === node.data.itemId)!.name).toBe('Maya Reyes')
  })

  it('spawns one node per distinct superseded image, not one per row', () => {
    const stale: SvReference = {
      path: 'u/p/assets/maya-OLD.png', url: '/uploads/sv-maya-old.png',
      assetId: 'a-Maya Reyes', assetName: 'Maya Reyes', assetCategory: 'character', isActiveVersion: false,
    }
    const b = bundle()
    b.rows = b.rows.map((r) => ({ ...r, framePrompt: FRAME_PROMPT, references: [stale, r.references[0] ?? stale, stale] }))
    const m = mapBundleToCanvas(b, { makeId: counterIds() })
    expect(m.summary.referenceOnlyImages).toBe(1)
  })

  it('sorts rows by episode then frame number, as the server returns them', () => {
    const b = bundle()
    b.rows = [b.rows[1], b.rows[0]].map((r, i) => ({ ...r, frameNumber: 2 - i }))
    const m = mapBundleToCanvas(b, { makeId: counterIds() })
    expect(m.rows.map((r) => r.shot_number)).toEqual(['2', '1'])
  })
})
