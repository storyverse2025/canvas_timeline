import { describe, expect, it, beforeEach } from 'vitest'
import type { StoryboardRow } from '@/types/storyboard'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useProjectDB } from '@/stores/project-db'
import {
  buildRagGlobalArtStyleContext,
  buildRagQueries,
  buildRagQueryExtractionPrompt,
  buildRagRowRewritePrompt,
  EMPTY_RAG_SELECTION,
  parseRagExtractedQueries,
  parseRagRowPatch,
  toggleRagSelection,
  type RagReferenceGroups,
} from '../rag-row-rewrite'

const row = {
  id: 'row-1',
  shot_number: 'S1',
  visual_description: '女孩进入更衣室',
  character_actions: '拉开拉链，战斗服滑落',
  shot_size: '中景到特写',
  storyboard_prompts: 'old storyboard',
  motion_prompts: 'old motion',
  lighting_atmosphere: '冷色灯光',
  scene: { image: '', description: '更衣室', nodeId: '' },
} as StoryboardRow

const groups: RagReferenceGroups = {
  art: [
    { id: 'a1', prompt: 'metal locker room, cold blue light', similarity: 0.91, output_media_url: 'https://m/a.mp4', source_name: 'neowow_canvas_graph' },
  ],
  action: [
    { id: 'm1', prompt: 'hand pulls collar zipper, shoulder reveal motion', similarity: 0.88 },
  ],
  camera: [
    { id: 'c1', prompt: '35mm slight high angle to 200mm close-up cut', similarity: 0.84 },
  ],
}

describe('rag row rewrite helpers', () => {
  beforeEach(() => {
    useProjectDB.getState().clearAll()
    useCanvasStore.getState().clearAll()
    useCanvasItemStore.setState({ items: {} })
  })

  it('builds separate art/action/camera queries from different row fields', () => {
    const queries = buildRagQueries(row)
    expect(queries.art).toContain('冷色灯光')
    expect(queries.art).toContain('更衣室')
    expect(queries.action).toContain('拉开拉链')
    expect(queries.camera).toContain('中景到特写')
  })

  it('asks the LLM to extract global style, action+expression+emotion, and camera+emotion queries', () => {
    const prompt = buildRagQueryExtractionPrompt({ globalArtStyle: 'stylized 3D, neon noir, shallow depth of field', row })
    expect(prompt).toContain('global art style')
    expect(prompt).toContain('表情')
    expect(prompt).toContain('当前情绪')
    expect(prompt).toContain('camera_query')
  })

  it('builds rich RAG global art style context from the style library instead of the raw preset id', () => {
    useProjectDB.getState().updateArtDirection({
      stylePreset: '3d_weta_performance_capture_epic',
      customStyle: '',
    })
    useProjectDB.getState().updateScript({
      creativeBrief: { genre: 'MV', tone: 'uplifting' },
    })

    const context = buildRagGlobalArtStyleContext()

    expect(context).toContain('Weta Performance-Capture Epic 3D')
    expect(context).toContain('Epic performance-capture 3D realism')
    expect(context).toContain('physically-based simulation logic')
    expect(context).toContain('Project genre/tone: MV / uplifting')
    expect(context).not.toBe('3d_weta_performance_capture_epic，MV')
  })

  it('prefers the user-edited canvas style node when building RAG global art style context', () => {
    useProjectDB.getState().updateArtDirection({
      stylePreset: '3d_weta_performance_capture_epic',
      customStyle: 'database custom style should not beat edited node',
    })
    useProjectDB.getState().updateScript({
      creativeBrief: { genre: 'AI短片', tone: 'tragic' },
    })
    const itemId = useCanvasItemStore.getState().addItem({
      kind: 'text',
      name: '全局风格',
      content: 'USER EDITED STYLE NODE: watercolor ink fantasy with handmade paper grain',
      role: 'style',
    })
    useCanvasStore.getState().addItemNode(itemId, 'text', { x: 0, y: 0 })

    const context = buildRagGlobalArtStyleContext()

    expect(context).toContain('USER EDITED STYLE NODE')
    expect(context).toContain('watercolor ink fantasy')
    expect(context).toContain('Project genre/tone: AI短片 / tragic')
    expect(context).not.toContain('database custom style should not beat edited node')
  })

  it('parses LLM extracted queries and falls back per field', () => {
    const fallback = buildRagQueries(row)
    const queries = parseRagExtractedQueries('{"art_query":"neon anime style","action_query":"girl smiles and pulls zipper"}', fallback)
    expect(queries.art).toBe('neon anime style')
    expect(queries.action).toBe('girl smiles and pulls zipper')
    expect(queries.camera).toBe(fallback.camera)
  })

  it('limits each reference bucket to three selections', () => {
    let sel = EMPTY_RAG_SELECTION
    sel = toggleRagSelection(sel, 'art', '1')
    sel = toggleRagSelection(sel, 'art', '2')
    sel = toggleRagSelection(sel, 'art', '3')
    sel = toggleRagSelection(sel, 'art', '4')
    expect(sel.art).toEqual(['1', '2', '3'])
    expect(toggleRagSelection(sel, 'art', '2').art).toEqual(['1', '3'])
  })

  it('builds an AI rewrite prompt with three chosen reference roles', () => {
    const prompt = buildRagRowRewritePrompt(
      row,
      groups,
      { art: ['a1'], action: ['m1'], camera: ['c1'] },
      '更性感但不要低俗，镜头更电影感',
    )
    expect(prompt).toContain('美术参考')
    expect(prompt).toContain('动作参考')
    expect(prompt).toContain('镜头参考')
    expect(prompt).toContain('storyboard_prompts 应综合美术参考 + 镜头参考')
    expect(prompt).toContain('motion_prompts 应综合动作参考 + 镜头参考')
  })

  it('parses only safe row patch fields from AI JSON', () => {
    const patch = parseRagRowPatch(JSON.stringify({
      storyboard_prompts: 'new art/camera prompt',
      motion_prompts: 'new action/camera prompt',
      keyframeUrl: 'must-not-change',
      duration: 99,
    }))
    expect(patch).toEqual({
      storyboard_prompts: 'new art/camera prompt',
      motion_prompts: 'new action/camera prompt',
    })
  })
})
