import { describe, expect, it, beforeEach } from 'vitest'
import type { StoryboardRow } from '@/types/storyboard'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useProjectDB } from '@/stores/project-db'
import {
  buildRagGlobalArtStyleContext,
  buildRagQueries,
  buildRagQueryExtractionPrompt,
  buildRagRowPatchDiffMessage,
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

  it('parses every editable text column while blocking media, identity, and timing fields', () => {
    const patch = parseRagRowPatch(JSON.stringify({
      visual_description: 'new visual description',
      visual_anchor: 'new visual anchor',
      shot_size: 'new shot size',
      character_actions: 'new action',
      emotion_mood: 'new mood',
      emotion_atmosphere: 'new emotion atmosphere',
      character_motivation: 'new motivation',
      character_psychology: 'new psychology',
      performance_guidance: 'new performance guidance',
      lighting_atmosphere: 'new lighting',
      dialogue: 'new dialogue',
      transition_note: 'new transition note',
      sound_effects: 'new sfx',
      mixing_brief: 'new mix',
      storyboard_prompts: 'new art/camera prompt',
      motion_prompts: 'new action/camera prompt',
      bgm: 'new bgm',
      keyframeUrl: 'must-not-change',
      beatVideoUrl: 'must-not-change',
      shot_number: 'S999',
      duration: 99,
    }))
    expect(patch).toEqual({
      visual_description: 'new visual description',
      visual_anchor: 'new visual anchor',
      shot_size: 'new shot size',
      character_actions: 'new action',
      emotion_mood: 'new mood',
      emotion_atmosphere: 'new emotion atmosphere',
      character_motivation: 'new motivation',
      character_psychology: 'new psychology',
      performance_guidance: 'new performance guidance',
      lighting_atmosphere: 'new lighting',
      dialogue: 'new dialogue',
      transition_note: 'new transition note',
      sound_effects: 'new sfx',
      mixing_brief: 'new mix',
      storyboard_prompts: 'new art/camera prompt',
      motion_prompts: 'new action/camera prompt',
      bgm: 'new bgm',
    })
  })

  it('accepts Chinese table column labels for RAG patch fields', () => {
    const patch = parseRagRowPatch(JSON.stringify({
      '画面描述': '中文画面',
      '视觉锚点': '中文锚点',
      '角色动作': '中文动作',
      '表演指导': '中文表演',
      '光影氛围': '中文光影',
      '分镜提示词': '中文分镜 prompt',
      '视频运动提示词': '中文视频运动 prompt',
      '参考/KF': 'must-not-change',
      'Beat Video': 'must-not-change',
    }))
    expect(patch).toEqual({
      visual_description: '中文画面',
      visual_anchor: '中文锚点',
      character_actions: '中文动作',
      performance_guidance: '中文表演',
      lighting_atmosphere: '中文光影',
      storyboard_prompts: '中文分镜 prompt',
      motion_prompts: '中文视频运动 prompt',
    })
  })

  it('builds a chat-panel diff message for the fields changed by RAG rewrite', () => {
    const message = buildRagRowPatchDiffMessage(row, {
      visual_description: '女孩在冷蓝金属更衣室前停住',
      storyboard_prompts: 'new art/camera prompt',
      motion_prompts: 'old motion',
    })

    expect(message).toContain('RAG 已改写镜头 S1')
    expect(message).toContain('visual_description')
    expect(message).toContain('- 女孩进入更衣室')
    expect(message).toContain('+ 女孩在冷蓝金属更衣室前停住')
    expect(message).toContain('storyboard_prompts')
    expect(message).toContain('- old storyboard')
    expect(message).toContain('+ new art/camera prompt')
    expect(message).not.toContain('motion_prompts')
  })
})
