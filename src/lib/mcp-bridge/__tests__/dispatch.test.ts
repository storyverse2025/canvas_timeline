import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatch, isKnownTool } from '@/lib/mcp-bridge/dispatch'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { EMPTY_ELEMENT_SLOT } from '@/types/storyboard'

vi.mock('@/lib/capabilities/client', () => ({ runCapability: vi.fn() }))
import { runCapability } from '@/lib/capabilities/client'

function resetStores() {
  useCanvasStore.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
  useStoryboardStore.setState({ rows: [] })
  vi.mocked(runCapability).mockReset()
}

function seedImageNode(opts: { name: string; prompt: string; content?: string; role?: 'keyframe' | 'character' }): string {
  const itemId = useCanvasItemStore.getState().addItem({
    kind: 'image',
    name: opts.name,
    content: opts.content ?? `https://example.test/${opts.name}.png`,
    role: opts.role,
    prompt: opts.prompt,
  })
  return useCanvasStore.getState().addItemNode(itemId, 'image', { x: 0, y: 0 })
}

describe('isKnownTool', () => {
  it('accepts every documented canvas_* tool name', () => {
    const names = [
      'canvas_get_snapshot',
      'canvas_search_nodes',
      'canvas_get_node',
      'canvas_add_node',
      'canvas_update_node_prompt',
      'canvas_regenerate_image',
      'canvas_set_keyframe',
    ]
    for (const n of names) expect(isKnownTool(n)).toBe(true)
  })

  it('rejects unknown names', () => {
    expect(isKnownTool('canvas_drop_table')).toBe(false)
    expect(isKnownTool('')).toBe(false)
  })
})

describe('dispatch — routing', () => {
  beforeEach(resetStores)

  it('canvas_get_snapshot returns counts + histograms', async () => {
    seedImageNode({ name: 'a', prompt: 'pistol', role: 'character' })
    seedImageNode({ name: 'b', prompt: 'mecha', role: 'keyframe' })
    const out = (await dispatch('canvas_get_snapshot', {})) as {
      itemCount: number
      kindHistogram: { image: number }
      roleHistogram: Record<string, number>
    }
    expect(out.itemCount).toBe(2)
    expect(out.kindHistogram.image).toBe(2)
    expect(out.roleHistogram.character).toBe(1)
    expect(out.roleHistogram.keyframe).toBe(1)
  })

  it('canvas_search_nodes runs through the synonym expansion layer', async () => {
    seedImageNode({ name: 'cn', prompt: '一名赏金猎人手持左轮手枪' })
    seedImageNode({ name: 'en', prompt: 'cowboy with a revolver' })
    seedImageNode({ name: 'other', prompt: 'a quiet farm at dawn' })
    const hits = (await dispatch('canvas_search_nodes', { promptContains: ['revolver'] })) as Array<{ name: string }>
    expect(hits.map((h) => h.name).sort()).toEqual(['cn', 'en'])
  })

  it('canvas_search_nodes rejects empty promptContains', async () => {
    await expect(dispatch('canvas_search_nodes', { promptContains: [] }))
      .rejects.toThrow(/promptContains/)
    await expect(dispatch('canvas_search_nodes', {}))
      .rejects.toThrow(/promptContains/)
  })

  it('canvas_get_node returns the full item including versions[]', async () => {
    const nodeId = seedImageNode({ name: 'shot', prompt: 'old prompt' })
    const detail = (await dispatch('canvas_get_node', { nodeId })) as { item: { name: string; prompt?: string } }
    expect(detail.item.name).toBe('shot')
    expect(detail.item.prompt).toBe('old prompt')
  })

  it('canvas_get_node throws CanvasApiError for missing ids', async () => {
    await expect(dispatch('canvas_get_node', { nodeId: 'nope' }))
      .rejects.toThrow(/not found/)
  })

  it('canvas_add_node creates item + canvas node and returns NodeDetail', async () => {
    const detail = (await dispatch('canvas_add_node', {
      kind: 'image',
      name: 'newly added',
      content: 'https://new.test/x.png',
      role: 'keyframe',
      prompt: 'wide desert',
    })) as { item: { name: string } }
    expect(detail.item.name).toBe('newly added')
    expect(useCanvasStore.getState().nodes).toHaveLength(1)
  })

  it('canvas_add_node rejects missing required fields', async () => {
    await expect(dispatch('canvas_add_node', { kind: 'image', name: 'x' }))
      .rejects.toThrow(/required/)
  })

  it('canvas_update_node_prompt versions the old prompt and replaces head', async () => {
    const nodeId = seedImageNode({ name: 'shot', prompt: 'old' })
    const detail = (await dispatch('canvas_update_node_prompt', { nodeId, prompt: 'new' })) as {
      item: { prompt?: string; versions?: Array<{ prompt?: string }> }
    }
    expect(detail.item.prompt).toBe('new')
    expect(detail.item.versions?.[0]?.prompt).toBe('old')
  })

  it('canvas_update_node_prompt rejects empty prompt', async () => {
    const nodeId = seedImageNode({ name: 'shot', prompt: 'old' })
    await expect(dispatch('canvas_update_node_prompt', { nodeId, prompt: '' }))
      .rejects.toThrow(/non-empty/)
  })

  it('canvas_regenerate_image calls text-to-image and versions the prior image', async () => {
    const nodeId = seedImageNode({
      name: 'shot',
      prompt: 'soldier with pistol',
      content: 'https://old.test/img.png',
    })
    vi.mocked(runCapability).mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://new.test/img.png' }] })

    const detail = (await dispatch('canvas_regenerate_image', { nodeId, prompt: 'mecha with pistol' })) as {
      item: { content: string; versions?: Array<{ content: string }> }
    }
    expect(detail.item.content).toBe('https://new.test/img.png')
    expect(detail.item.versions?.[0]?.content).toBe('https://old.test/img.png')
  })

  it('canvas_set_keyframe binds node to row + mirrors content into keyframeUrl', async () => {
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
    const out = (await dispatch('canvas_set_keyframe', { rowId, nodeId })) as { ok: boolean }
    expect(out.ok).toBe(true)
    const row = useStoryboardStore.getState().rows.find((r) => r.id === rowId)
    expect(row?.keyframeNodeId).toBe(nodeId)
    expect(row?.keyframeUrl).toBe('https://new.test/k.png')
  })

  it('rejects unknown tool names with CanvasApiError', async () => {
    await expect(dispatch('canvas_drop_everything', {})).rejects.toThrow(/unknown tool/)
  })
})
