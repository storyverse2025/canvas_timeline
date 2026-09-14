import { describe, it, expect } from 'vitest'
import { mapBundleToCanvas } from '@/lib/storyverse-import/mapper'
import type { SvBundle } from '@/lib/storyverse-import/types'
import {
  buildPrevisManifest,
  parseDialogue,
  PrevisManifestError,
  shortIdOf,
} from '../build-manifest'

const RUN = '3f2a9c1e-7b6d-4e21-9a0b-5c4d3e2f1a0b'

const FRAME_PROMPT = `[REFERENCES]
(image1) <char1> @Zachary - man in grey suit
(image2) <char2> @Charlie - woman in red coat
(image3) <scene> @Boardroom - glass boardroom
(image4) <prop1> @Contract - signed contract

[SPATIAL REFERENCE GOAL]
Zachary at the head of the table, Charlie by the door`

const ref = (path: string, name: string, category: string, url: string) =>
  ({ path, url, assetId: `a-${name}`, assetName: name, assetCategory: category, isActiveVersion: true })

/** Canvas state exactly as the StoryVerse importer lays it out. */
function canvas() {
  const bundle: SvBundle = {
    project: { id: 'p', title: 'Crawling Back', status: 'draft', updatedAt: '' },
    episodes: [],
    assets: [
      { id: 'a1', category: 'character', name: 'Zachary', prompt: 'a man in a grey suit', storagePath: 's/z.png', imageUrl: '/uploads/sv-z.png' },
      { id: 'a2', category: 'character', name: 'Charlie', prompt: 'a woman in a red coat', storagePath: 's/c.png', imageUrl: '/uploads/sv-c.png' },
      { id: 'a3', category: 'environment', name: 'Boardroom', prompt: 'glass boardroom, long table', storagePath: 's/b.png', imageUrl: '/uploads/sv-b.png' },
      { id: 'a4', category: 'property', name: 'Contract', prompt: 'signed contract', storagePath: 's/k.png', imageUrl: '/uploads/sv-k.png' },
      { id: 'a5', category: 'character', name: 'Bailey', prompt: 'a dog', storagePath: 's/d.png', imageUrl: '/uploads/sv-d.png' },
    ],
    rows: [1, 2].map((n) => ({
      frameId: `f${n}`, shotId: `s${n}`, episodeNumber: 1, episodeTitle: '', frameNumber: n,
      shotType: '', description: '', framePrompt: FRAME_PROMPT,
      shotPrompt: `镜头${n}：Zachary 转身看向 Charlie`, displayPrompt: '',
      dialogue: n === 1 ? "Zachary: Look who came crawling back. Charlie: I've learned my lesson." : '',
      durationSeconds: n === 1 ? 12 : 8,
      keyframeUrl: `/uploads/sv-kf${n}.png`, videoUrl: `https://x.supabase.co/v${n}.mp4`,
      references: [
        ref('s/z.png', 'Zachary', 'character', '/uploads/sv-z.png'),
        ref('s/c.png', 'Charlie', 'character', '/uploads/sv-c.png'),
        ref('s/b.png', 'Boardroom', 'environment', '/uploads/sv-b.png'),
        ref('s/k.png', 'Contract', 'property', '/uploads/sv-k.png'),
      ],
    })),
    stats: { localizedFiles: 0, videosLocalized: false, elapsedMs: 0 },
  }
  let n = 0
  const m = mapBundleToCanvas(bundle, { makeId: () => `id${++n}` })
  const items = Object.fromEntries(m.items.map((i) => [i.id, i]))
  const nodeOfName = (name: string) => m.nodes.find((node) => items[String(node.data.itemId)].name === name)!.id
  return { ...m, items, nodeOfName }
}

describe('shortIdOf', () => {
  it('matches the studio shortProjectId rule', () => {
    expect(shortIdOf(RUN)).toBe('3f2a9c1e')
  })
})

describe('parseDialogue', () => {
  const keyOf = (name: string) => ({ zachary: 'base_character_zachary', charlie: 'base_character_charlie' } as Record<string, string>)[name.toLowerCase()] ?? null
  it('splits inline multi-speaker lines and maps names to character keys', () => {
    expect(parseDialogue("Zachary: Look who came crawling back. Charlie: I've learned my lesson.", keyOf)).toEqual([
      { speaker: 'base_character_zachary', content: 'Look who came crawling back.', timecode: null },
      { speaker: 'base_character_charlie', content: "I've learned my lesson.", timecode: null },
    ])
  })
  it('keeps unattributed text and unknown speakers', () => {
    expect(parseDialogue('（旁白）夜深了', keyOf)).toEqual([{ speaker: null, content: '（旁白）夜深了', timecode: null }])
    expect(parseDialogue('路人：让开！', keyOf)).toEqual([{ speaker: null, content: '让开！', timecode: null }])
    expect(parseDialogue('   ', keyOf)).toEqual([])
  })
})

describe('buildPrevisManifest', () => {
  it('turns a selected beat video into a beat carrying its row prompt, cast, set and props', () => {
    const c = canvas()
    const { manifest, shortId, images, warnings } = buildPrevisManifest({
      runId: RUN, videoNodeIds: [c.rows[0].beatVideoNodeId!], assetNodeIds: [],
      nodes: c.nodes, items: c.items, rows: c.rows, title: 'Crawling Back', now: new Date('2026-09-13T00:00:00Z'),
    })
    expect(shortId).toBe('3f2a9c1e')
    expect(warnings).toEqual([])
    expect(manifest.project).toMatchObject({ id: RUN, title: 'Crawling Back', aspectRatio: '16:9' })

    const beat = manifest.beats[0]
    expect(beat.beat).toBe(1)
    expect(beat.duration).toBe(12)
    // Video node's own prompt wins; the row is the source for everything else.
    expect(beat.prompt).toBe('镜头1：Zachary 转身看向 Charlie')
    expect(beat.dialogue.map((d) => d.speaker)).toEqual(['base_character_zachary', 'base_character_charlie'])

    const byCat = (cat: string) => manifest.assets.filter((a) => a.category === cat)
    expect(byCat('character').map((a) => a.key)).toEqual(['base_character_zachary', 'base_character_charlie'])
    expect(byCat('environment').map((a) => a.name)).toEqual(['Boardroom'])
    expect(byCat('property').map((a) => a.name)).toEqual(['Contract'])
    // The unselected, unreferenced character does not leak in.
    expect(manifest.assets.some((a) => a.name === 'Bailey')).toBe(false)

    const env = byCat('environment')[0]
    expect(beat.continuity.environment).toBe(env.id)
    expect(beat.continuity.props).toEqual([byCat('property')[0].id])
    // Draft staging only places characters listed in characterPositions.
    expect(beat.continuity.characterPositions.map((p) => p.characterId)).toEqual(['base_character_zachary', 'base_character_charlie'])
    expect(beat.imageReferences.map((r) => `${r.tag}:${r.index}`)).toEqual(['char1:1', 'char2:2', 'scene:3', 'prop1:4'])
    // Characters referenced by key, environments / props by id (studio convention).
    expect(beat.imageReferences[2].assetId).toBe(env.id)
    expect(manifest.assetDefinitions.characters[0].assetId).toBe('base_character_zachary')

    // Every image is same-origin for the studio and has a copy instruction.
    for (const a of manifest.assets) {
      expect(a.legacyImageUrl.startsWith('/canvas-import/3f2a9c1e/')).toBe(true)
      expect(a.storagePath).toBeNull()
      expect(images.some((img) => a.legacyImageUrl.endsWith(img.file))).toBe(true)
    }
    expect(beat.storyboardImageUrl).toBe('/canvas-import/3f2a9c1e/beat01-storyboard.png')
    expect(images.find((img) => img.file === 'beat01-storyboard.png')?.source).toBe('/uploads/sv-kf1.png')
    expect(images.find((img) => img.file.endsWith('-character.png'))?.source).toBe('/uploads/sv-z.png')
  })

  it('orders multiple beats by storyboard order, not selection order, and dedupes shared assets', () => {
    const c = canvas()
    const { manifest, images } = buildPrevisManifest({
      runId: RUN, videoNodeIds: [c.rows[1].beatVideoNodeId!, c.rows[0].beatVideoNodeId!], assetNodeIds: [],
      nodes: c.nodes, items: c.items, rows: c.rows,
    })
    expect(manifest.beats.map((b) => [b.beat, b.duration])).toEqual([[1, 12], [2, 8]])
    expect(manifest.assets).toHaveLength(4)
    expect(images.filter((i) => !i.file.includes('storyboard'))).toHaveLength(4)
  })

  it('adds explicitly selected assets to the library and uses them when the video has no row', () => {
    const c = canvas()
    const loose = { ...c.items[String(c.nodes.find((n) => n.id === c.rows[0].beatVideoNodeId)!.data.itemId)] }
    // A hand-dropped video: same kind, no storyboard row points at it.
    const looseItem = { ...loose, id: 'loose-item', content: '/uploads/manual.mp4', prompt: '手动视频的 prompt' }
    const looseNode = { id: 'loose-node', type: 'video', position: { x: 0, y: 0 }, data: { itemId: 'loose-item' } }
    const { manifest, warnings } = buildPrevisManifest({
      runId: RUN, videoNodeIds: ['loose-node'], assetNodeIds: [c.nodeOfName('Bailey'), c.nodeOfName('Boardroom')],
      nodes: [...c.nodes, looseNode], items: { ...c.items, 'loose-item': looseItem }, rows: c.rows,
    })
    expect(warnings.some((w) => w.includes('没有对应的分镜行'))).toBe(true)
    expect(manifest.beats[0].prompt).toBe('手动视频的 prompt')
    expect(manifest.beats[0].duration).toBe(5)
    expect(manifest.beats[0].continuity.characterPositions.map((p) => p.characterId)).toEqual(['base_character_bailey'])
    expect(manifest.beats[0].continuity.environment).toBe(manifest.assets.find((a) => a.name === 'Boardroom')!.id)
  })

  it('refuses a selection with no video, or no character anywhere', () => {
    const c = canvas()
    const base = { runId: RUN, nodes: c.nodes, items: c.items, rows: c.rows }
    expect(() => buildPrevisManifest({ ...base, videoNodeIds: [], assetNodeIds: [] })).toThrow(PrevisManifestError)

    const rows = c.rows.map((r) => ({ ...r, characters: [], character1: { image: '', description: '', nodeId: '' }, character2: { image: '', description: '', nodeId: '' } }))
    expect(() => buildPrevisManifest({ ...base, rows, videoNodeIds: [rows[0].beatVideoNodeId!], assetNodeIds: [] }))
      .toThrow('至少需要一个角色素材')
  })

  it('gives same-named characters distinct keys', () => {
    const c = canvas()
    const twin = { ...c.items[String(c.nodes.find((n) => n.id === c.nodeOfName('Zachary'))!.data.itemId)], id: 'twin' }
    const twinNode = { id: 'twin-node', type: 'image', position: { x: 0, y: 0 }, data: { itemId: 'twin' } }
    const { manifest } = buildPrevisManifest({
      runId: RUN, videoNodeIds: [c.rows[0].beatVideoNodeId!], assetNodeIds: ['twin-node'],
      nodes: [...c.nodes, twinNode], items: { ...c.items, twin }, rows: c.rows,
    })
    const keys = manifest.assets.filter((a) => a.category === 'character').map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('base_character_zachary_2')
  })
})
