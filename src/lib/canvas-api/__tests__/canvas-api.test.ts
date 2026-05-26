import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { EMPTY_ELEMENT_SLOT } from '@/types/storyboard'
import {
  searchNodes,
  getSnapshot,
  getNode,
  updateNodePrompt,
  regenerateImage,
  addNode,
  setKeyframe,
  expandTerm,
  expandTerms,
  CanvasApiError,
} from '@/lib/canvas-api'

// Mock the network-bound capability layer. Every test that exercises
// regenerateImage stubs this with vi.mocked(runCapability).mockResolvedValue.
vi.mock('@/lib/capabilities/client', () => ({
  runCapability: vi.fn(),
}))

import { runCapability } from '@/lib/capabilities/client'

function resetStores() {
  useCanvasStore.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
  useStoryboardStore.setState({ rows: [] })
  vi.mocked(runCapability).mockReset()
}

/**
 * Helper: create an image item + its canvas node, return the node id.
 * Mirrors what art-director-agent does after a text-to-image call.
 */
function seedImageNode(opts: {
  name: string
  prompt: string
  content?: string
  role?: 'character' | 'scene' | 'prop' | 'keyframe'
}): string {
  const itemId = useCanvasItemStore.getState().addItem({
    kind: 'image',
    name: opts.name,
    content: opts.content ?? `https://example.test/${opts.name}.png`,
    role: opts.role,
    prompt: opts.prompt,
  })
  return useCanvasStore.getState().addItemNode(itemId, 'image', { x: 0, y: 0 })
}

describe('synonyms.expandTerm', () => {
  it('expands a Chinese weapon term to its English siblings', () => {
    const out = expandTerm('左轮手枪')
    expect(out).toContain('左轮手枪')
    expect(out).toContain('revolver')
    expect(out).toContain('pistol')
    expect(out).toContain('handgun')
  })

  it('matches case-insensitively — REVOLVER expands to the same group', () => {
    const upper = expandTerm('REVOLVER')
    const lower = expandTerm('revolver')
    expect(upper.sort()).toEqual(lower.sort())
  })

  it('passes unknown terms through unchanged (lowercased)', () => {
    expect(expandTerm('quokka')).toEqual(['quokka'])
  })

  it('expandTerms dedupes across overlapping groups', () => {
    const out = expandTerms(['手枪', 'revolver'])
    // Both terms expand to the same handgun group; result should not
    // contain duplicates.
    const dedup = new Set(out)
    expect(out.length).toBe(dedup.size)
  })
})

describe('searchNodes', () => {
  beforeEach(resetStores)

  it('finds Chinese-prompt nodes from an English query via synonym expansion', () => {
    seedImageNode({ name: 'shot-a', prompt: '一个赏金猎人手持左轮手枪，黄昏沙漠', role: 'keyframe' })
    seedImageNode({ name: 'shot-b', prompt: '一个修女在教堂祈祷', role: 'keyframe' })
    seedImageNode({ name: 'shot-c', prompt: 'cowboy holding a worn revolver, dust storm', role: 'keyframe' })

    const hits = searchNodes({ promptContains: ['revolver'], kinds: ['image'] })
    const names = hits.map((h) => h.name).sort()
    expect(names).toEqual(['shot-a', 'shot-c'])
  })

  it('returns the matched terms so the user can verify the filter', () => {
    seedImageNode({ name: 'gun-shot', prompt: 'pistol drawn from holster' })
    const [hit] = searchNodes({ promptContains: ['左轮手枪'] })
    expect(hit.matchedTerms).toContain('pistol')
  })

  it('respects expandSynonyms:false — literal-only matching', () => {
    seedImageNode({ name: 'gun-shot', prompt: 'pistol drawn from holster' })
    const literal = searchNodes({ promptContains: ['左轮手枪'], expandSynonyms: false })
    expect(literal).toHaveLength(0)
  })

  it('filters by kind: text-prompt items are excluded from image-only search', () => {
    seedImageNode({ name: 'image-with-gun', prompt: 'pistol drawn' })
    useCanvasItemStore.getState().addItem({
      kind: 'text',
      name: 'note',
      content: 'note about pistols',
      prompt: 'pistol drawn',
    })
    const hits = searchNodes({ promptContains: ['pistol'], kinds: ['image'] })
    expect(hits.map((h) => h.name)).toEqual(['image-with-gun'])
  })

  it('filters by role', () => {
    seedImageNode({ name: 'char', prompt: 'pistol', role: 'character' })
    seedImageNode({ name: 'kf', prompt: 'pistol', role: 'keyframe' })
    const hits = searchNodes({ promptContains: ['pistol'], roles: ['keyframe'] })
    expect(hits.map((h) => h.name)).toEqual(['kf'])
  })

  it('reports storyboard bindings when a matched node is the keyframe of a row', () => {
    const nodeId = seedImageNode({ name: 'kf-1', prompt: 'pistol', role: 'keyframe' })
    useStoryboardStore.getState().addRow({
      shot_number: 'S1',
      duration: 3,
      status: 'todo',
      visual_description: '',
      reference_image: '',
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
      keyframeNodeId: nodeId,
      keyframeUrl: 'https://example.test/kf.png',
    })
    const [hit] = searchNodes({ promptContains: ['pistol'] })
    expect(hit.storyboardBindings).toHaveLength(1)
    expect(hit.storyboardBindings[0]).toMatchObject({ shotNumber: 'S1', field: 'keyframe' })
  })

  it('limit caps the result set', () => {
    for (let i = 0; i < 5; i++) seedImageNode({ name: `n${i}`, prompt: 'pistol' })
    expect(searchNodes({ promptContains: ['pistol'], limit: 2 })).toHaveLength(2)
  })
})

describe('getSnapshot', () => {
  beforeEach(resetStores)

  it('counts items by kind and role', () => {
    seedImageNode({ name: 'c1', prompt: '', role: 'character' })
    seedImageNode({ name: 'k1', prompt: '', role: 'keyframe' })
    const snap = getSnapshot()
    expect(snap.itemCount).toBe(2)
    expect(snap.kindHistogram.image).toBe(2)
    expect(snap.roleHistogram.character).toBe(1)
    expect(snap.roleHistogram.keyframe).toBe(1)
  })
})

describe('updateNodePrompt — versioning', () => {
  beforeEach(resetStores)

  it('stores the prior prompt in versions[] before replacing', () => {
    const nodeId = seedImageNode({ name: 'shot', prompt: 'old prompt' })
    const detail = updateNodePrompt(nodeId, { type: 'replace', prompt: 'new prompt' })
    expect(detail.item.prompt).toBe('new prompt')
    expect(detail.item.versions).toHaveLength(1)
    expect(detail.item.versions?.[0].prompt).toBe('old prompt')
  })

  it('no-ops when the new prompt is identical to the old', () => {
    const nodeId = seedImageNode({ name: 'shot', prompt: 'same' })
    const detail = updateNodePrompt(nodeId, { type: 'replace', prompt: 'same' })
    expect(detail.item.versions ?? []).toHaveLength(0)
  })

  it('rewrite form receives the old prompt and writes the result', () => {
    const nodeId = seedImageNode({ name: 'shot', prompt: 'a soldier with a pistol' })
    const detail = updateNodePrompt(nodeId, {
      type: 'rewrite',
      rewrite: (old) => old.replace('pistol', 'plasma rifle'),
    })
    expect(detail.item.prompt).toBe('a soldier with a plasma rifle')
  })

  it('throws CanvasApiError for unknown nodes', () => {
    expect(() => updateNodePrompt('does-not-exist', { type: 'replace', prompt: 'x' }))
      .toThrow(CanvasApiError)
  })
})

describe('regenerateImage', () => {
  beforeEach(resetStores)

  it('happy path: calls text-to-image, pushes prior head to versions[], updates content', async () => {
    const nodeId = seedImageNode({
      name: 'shot',
      prompt: 'soldier with pistol',
      content: 'https://old.test/img.png',
    })
    vi.mocked(runCapability).mockResolvedValue({
      outputs: [{ kind: 'image', url: 'https://new.test/img.png' }],
    })

    const detail = await regenerateImage(nodeId, { prompt: 'mecha with giant pistol' })
    expect(detail.item.content).toBe('https://new.test/img.png')
    expect(detail.item.prompt).toBe('mecha with giant pistol')
    expect(detail.item.versions?.[0].content).toBe('https://old.test/img.png')
    expect(detail.item.versions?.[0].prompt).toBe('soldier with pistol')

    const call = vi.mocked(runCapability).mock.calls[0][0]
    expect(call.capability).toBe('text-to-image')
    expect(call.params?.provider).toBe('openai')
    expect(call.params?.model).toBe('gpt-image-2')
  })

  it('failure path: when text-to-image returns no url, state is untouched', async () => {
    const nodeId = seedImageNode({
      name: 'shot',
      prompt: 'soldier with pistol',
      content: 'https://old.test/img.png',
    })
    vi.mocked(runCapability).mockResolvedValue({ outputs: [{ kind: 'image' }] })

    await expect(regenerateImage(nodeId)).rejects.toThrow(CanvasApiError)
    const detail = getNode(nodeId)
    expect(detail?.item.content).toBe('https://old.test/img.png')
    expect(detail?.item.versions ?? []).toHaveLength(0)
  })

  it('rejects non-image nodes', async () => {
    const itemId = useCanvasItemStore.getState().addItem({
      kind: 'text',
      name: 'note',
      content: 'hello',
      prompt: 'a friendly greeting',
    })
    const nodeId = useCanvasStore.getState().addItemNode(itemId, 'text', { x: 0, y: 0 })
    await expect(regenerateImage(nodeId)).rejects.toThrow(/kind=image/)
  })
})

describe('addNode + setKeyframe', () => {
  beforeEach(resetStores)

  it('addNode creates an item + canvas node and returns the detail', () => {
    const detail = addNode({
      kind: 'image',
      name: 'new keyframe',
      content: 'https://new.test/k.png',
      role: 'keyframe',
      prompt: 'a wide desert vista',
    })
    expect(detail.item.name).toBe('new keyframe')
    expect(useCanvasStore.getState().nodes).toHaveLength(1)
    expect(Object.keys(useCanvasItemStore.getState().items)).toHaveLength(1)
  })

  it('setKeyframe binds the node to a row and mirrors content into keyframeUrl', () => {
    const nodeId = seedImageNode({
      name: 'kf',
      prompt: '',
      content: 'https://new.test/k.png',
      role: 'keyframe',
    })
    const rowId = useStoryboardStore.getState().addRow({
      shot_number: 'S1',
      duration: 3,
      status: 'todo',
      visual_description: '',
      reference_image: '',
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
    setKeyframe(rowId, nodeId)
    const row = useStoryboardStore.getState().rows.find((r) => r.id === rowId)
    expect(row?.keyframeNodeId).toBe(nodeId)
    expect(row?.keyframeUrl).toBe('https://new.test/k.png')
  })
})
