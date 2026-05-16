import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useProjectDB } from '@/stores/project-db'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { runCapability } from '@/lib/capabilities/client'

vi.mock('@/lib/capabilities/client', () => ({
  runCapability: vi.fn(),
}))

const mockedRunCapability = vi.mocked(runCapability)

function resetDB() {
  useProjectDB.getState().clearAll()
  useCanvasStore.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
}

describe('Director Pipeline — Art Direction Config', () => {
  beforeEach(resetDB)

  it('has cinematic defaults', () => {
    const art = useProjectDB.getState().artDirection
    expect(art.stylePreset).toBe('cinematic')
    expect(art.defaultAspectRatio).toBe('16:9')
    expect(art.defaultImageModel).toBe('openai/gpt-5.4-image-2')
    expect(art.defaultVideoModel).toBe('doubao-seedance-2-0-fast-260128')
  })

  it('updates style preset', () => {
    useProjectDB.getState().updateArtDirection({ stylePreset: 'anime' })
    expect(useProjectDB.getState().artDirection.stylePreset).toBe('anime')
  })

  it('updates custom style', () => {
    useProjectDB.getState().updateArtDirection({ customStyle: '赛博朋克 + 霓虹' })
    expect(useProjectDB.getState().artDirection.customStyle).toBe('赛博朋克 + 霓虹')
  })

  it('updates models independently', () => {
    useProjectDB.getState().updateArtDirection({ defaultImageModel: 'gpt-image-1' })
    expect(useProjectDB.getState().artDirection.defaultImageModel).toBe('gpt-image-1')
    expect(useProjectDB.getState().artDirection.defaultVideoModel).toBe('doubao-seedance-2-0-fast-260128') // unchanged
  })

  it('updates aspect ratio', () => {
    useProjectDB.getState().updateArtDirection({ defaultAspectRatio: '9:16' })
    expect(useProjectDB.getState().artDirection.defaultAspectRatio).toBe('9:16')
  })
})

describe('Director Pipeline — Script State', () => {
  beforeEach(resetDB)

  it('stores script text', () => {
    useProjectDB.getState().updateScript({ text: '第一幕：黎明' })
    expect(useProjectDB.getState().script.text).toBe('第一幕：黎明')
  })

  it('stores optimized text separately', () => {
    useProjectDB.getState().updateScript({ text: 'original', optimizedText: 'optimized' })
    const s = useProjectDB.getState().script
    expect(s.text).toBe('original')
    expect(s.optimizedText).toBe('optimized')
  })

  it('clearAll resets script', () => {
    useProjectDB.getState().updateScript({ text: 'test' })
    useProjectDB.getState().clearAll()
    expect(useProjectDB.getState().script.text).toBe('')
  })
})

describe('Director Pipeline — PipelineState Structure', () => {
  it('exposes redesigned script-to-casting stages before storyboard generation', async () => {
    const { createDirectorInitialState, runDirectorPipeline } = await import('@/lib/director-assistant')
    expect(typeof runDirectorPipeline).toBe('function')

    const state = createDirectorInitialState()
    const optimizeLabels = state.stages[0].steps.map((step) => step.label)
    expect(optimizeLabels).toEqual([
      '剧本框架七层校准',
      '完整剧本扩写',
      '剧本医生圆桌会诊',
      '医生诊断后剧本修改',
      '台词专家全量诊断',
      'Casting 角色卡与表演锚点',
      '角色/场景/道具素材生成',
      '视觉锚定提取',
      '全局视觉策略',
      '镜头分配计划',
      '镜头构图设计',
      '分镜设计',
      '优化结果',
    ])
    expect(state.stages[0].description).toContain('Script → Casting')
  })

  it('uses expanded/revised script as durable visible baseline before storyboard generation', async () => {
    const { runDirectorStage } = await import('@/lib/director-assistant')
    useProjectDB.getState().updateScript({ text: '短纲：少年在雨夜决定离家。' })

    const expanded = '完整扩写剧本：少年站在雨夜门口，捏紧旧车票，和母亲沉默告别。'
    const revised = '医生修改后最终剧本：少年先看母亲的背影，再把旧车票藏进袖口，推门入雨。'
    const storyboard = '[{"shot_number":"S1","duration":4,"visual_description":"少年推门入雨"}]'
    const storyboardPrompts: string[] = []

    mockedRunCapability.mockImplementation(async (request) => {
      const prompt = request.inputs[0]?.text ?? ''
      if (prompt.includes('script-agent / expand-script')) {
        return { outputs: [{ kind: 'text', text: JSON.stringify({
          framework_calibration: { main_risk: '动机偏薄' },
          expanded_script_baseline: { format: '标准影视', script_text: expanded, beat_summary: ['离家'] },
          doctor_roundtable_summary: { must_fix: ['补行动细节'], keep: ['雨夜氛围'], open_questions: [] },
          post_doctor_revised_script: { script_text: revised, revision_notes: ['补了可演动作'] },
          dialogue_diagnosis_summary: { rewrite_notes: ['减少直白对白'] },
          casting_cards: [],
          scene_cards: [],
          prop_cards: [],
          storyboard_directives: ['以旧车票作为动机锚点'],
        }) }] }
      }
      if (prompt.includes('角色提取')) return { outputs: [{ kind: 'text', text: '[]' }] }
      if (prompt.includes('场景提取')) return { outputs: [{ kind: 'text', text: '[]' }] }
      if (prompt.includes('道具提取')) return { outputs: [{ kind: 'text', text: '[]' }] }
      if (prompt.includes('输出最终的分镜表 JSON')) {
        storyboardPrompts.push(prompt)
        return { outputs: [{ kind: 'text', text: storyboard }] }
      }
      return { outputs: [{ kind: 'text', text: 'ok' }] }
    })

    const result = await runDirectorStage('optimize')

    expect(result).toBe(storyboard)
    expect(useProjectDB.getState().script.optimizedText).toBe(revised)

    const scriptItems = Object.values(useCanvasItemStore.getState().items)
      .filter((item) => item.kind === 'text' && item.name.includes('最终扩写剧本'))
    expect(scriptItems).toHaveLength(1)
    expect(scriptItems[0].content).toBe(revised)

    const scriptNode = useCanvasStore.getState().nodes.find((node) => node.data.itemId === scriptItems[0].id)
    expect(scriptNode?.type).toBe('text')

    expect(storyboardPrompts[0]).toContain(revised)
    expect(storyboardPrompts[0]).not.toContain('短纲：少年在雨夜决定离家')
  })

  it('repairs inconsistent style/character references and unreasonable storyboard count before final generation result', async () => {
    const { runDirectorPipeline } = await import('@/lib/director-assistant')
    useProjectDB.getState().updateScript({ text: '晨雾码头：小夏把红伞交给阿澈，两人躲避追兵。' })
    useProjectDB.getState().updateArtDirection({ stylePreset: 'cinematic', customStyle: 'Final Fantasy CG, misty blue-orange cinematic lighting' })

    const badStoryboard = JSON.stringify(Array.from({ length: 18 }, (_, index) => ({
      shot_number: `S${index + 1}`,
      duration: 1,
      visual_description: index % 2 === 0 ? 'photoreal documentary still of a blonde stranger' : 'anime sketch of Xiao Xia without the red umbrella',
      storyboard_prompts: 'single still, inconsistent style',
      motion_prompts: 'tiny cut',
      character1: { image: '', description: index % 2 === 0 ? 'blonde stranger' : 'Xiao Xia' },
      character2: { image: '', description: 'A Che' },
      scene: { image: '', description: 'dock' },
    })))
    const fixedStoryboard = JSON.stringify([
      {
        shot_number: 'S1',
        duration: 12,
        visual_description: 'Final Fantasy CG multi-panel director storyboard sheet: Xiao Xia keeps the red umbrella while crossing the misty dock with A Che.',
        storyboard_prompts: 'multi-panel director storyboard sheet/grid, Final Fantasy CG, consistent Xiao Xia red umbrella and A Che, panels cover 0-12s',
        motion_prompts: 'follow the grid sequentially, not split-screen',
        character1: { image: '[node:xia12345]', description: 'Xiao Xia, red umbrella, blue coat' },
        character2: { image: '[node:ache1234]', description: 'A Che, grey rain jacket' },
        scene: { image: '[node:dock1234]', description: 'misty blue-orange cinematic dock' },
      },
      {
        shot_number: 'S2',
        duration: 11,
        visual_description: 'Final Fantasy CG multi-panel continuation as pursuers pass behind cranes; same characters, same dock axis.',
        storyboard_prompts: 'multi-panel director storyboard sheet/grid, Final Fantasy CG, same character refs and dock axis, panels cover 12-23s',
        motion_prompts: 'follow the grid sequentially, not split-screen',
        character1: { image: '[node:xia12345]', description: 'Xiao Xia, red umbrella, blue coat' },
        character2: { image: '[node:ache1234]', description: 'A Che, grey rain jacket' },
        scene: { image: '[node:dock1234]', description: 'misty blue-orange cinematic dock' },
      },
    ])
    const selfCheckPrompts: string[] = []
    const fixPrompts: string[] = []

    mockedRunCapability.mockImplementation(async (request) => {
      const prompt = request.inputs[0]?.text ?? ''
      if (prompt.includes('script-agent / expand-script')) {
        return { outputs: [{ kind: 'text', text: JSON.stringify({
          framework_calibration: { main_risk: '追逐节奏可能过碎' },
          expanded_script_baseline: { script_text: '小夏把红伞交给阿澈，两人在晨雾码头穿过吊机阴影。', beat_summary: ['交伞', '躲避'] },
          doctor_roundtable_summary: { must_fix: ['保持红伞连续性'], keep: ['晨雾码头'] },
          post_doctor_revised_script: { script_text: '小夏攥紧红伞，和阿澈沿晨雾码头同一轴线躲避追兵。' },
          dialogue_diagnosis_summary: { rewrite_notes: [] },
          casting_cards: [{ name: '小夏', appearance_for_image: 'red umbrella, blue coat' }, { name: '阿澈', appearance_for_image: 'grey rain jacket' }],
          scene_cards: [{ name: '晨雾码头', visual_requirements: 'misty blue-orange cinematic dock' }],
          prop_cards: [{ name: '红伞', description: 'red umbrella' }],
          storyboard_directives: ['小夏红伞、阿澈灰雨衣、晨雾码头必须跨镜一致'],
        }) }] }
      }
      if (prompt.includes('角色提取')) return { outputs: [{ kind: 'text', text: '[{"name":"小夏","gender":"female","appearance":"red umbrella blue coat","clothing":"blue coat","expression":"alert","image_prompt":"Xiao Xia red umbrella blue coat"},{"name":"阿澈","gender":"male","appearance":"grey rain jacket","clothing":"grey rain jacket","expression":"tense","image_prompt":"A Che grey rain jacket"}]' }] }
      if (prompt.includes('场景提取')) return { outputs: [{ kind: 'text', text: '[{"name":"晨雾码头","location":"dock","lighting":"blue-orange mist","mood":"tense","image_prompt":"misty dock"}]' }] }
      if (prompt.includes('道具提取')) return { outputs: [{ kind: 'text', text: '[{"name":"红伞","description":"red umbrella","image_prompt":"red umbrella prop"}]' }] }
      if (request.capability === 'text-to-image') return { outputs: [{ kind: 'image', url: 'https://assets.test/ref.png' }] }
      if (prompt.includes('输出最终的分镜表 JSON')) return { outputs: [{ kind: 'text', text: badStoryboard }] }
      if (prompt.includes('导演助手生成前自检')) {
        selfCheckPrompts.push(prompt)
        return { outputs: [{ kind: 'text', text: '[{"shot":"ALL","issue":"18 rows of 1s shots, style alternates photoreal/anime, character refs drift from Xiao Xia/A Che","fix":"merge into 2 multi-panel rows and enforce Final Fantasy CG + canonical character refs"}]' }] }
      }
      if (prompt.includes('根据自检发现的问题修复分镜表')) {
        fixPrompts.push(prompt)
        return { outputs: [{ kind: 'text', text: fixedStoryboard }] }
      }
      return { outputs: [{ kind: 'text', text: '[]' }] }
    })

    const result = await runDirectorPipeline(() => {})

    expect(selfCheckPrompts).toHaveLength(1)
    expect(selfCheckPrompts[0]).toContain('Final Fantasy CG, misty blue-orange cinematic lighting')
    expect(selfCheckPrompts[0]).toContain('小夏')
    expect(selfCheckPrompts[0]).toContain('阿澈')
    expect(selfCheckPrompts[0]).toContain('合理镜头/row 数')
    expect(fixPrompts).toHaveLength(1)
    expect(fixPrompts[0]).toContain('merge into 2 multi-panel rows')
    expect(result.storyboardJson).toBe(fixedStoryboard)
    expect(JSON.parse(result.storyboardJson)).toHaveLength(2)
  })

  it('runDirectorStage accepts stage ids', async () => {
    const { runDirectorStage } = await import('@/lib/director-assistant')
    expect(typeof runDirectorStage).toBe('function')
  })
})

describe('Director Pipeline — Server Skill Files', () => {
  const skillRoot = join(process.cwd(), '.claude', 'skills')
  const skills = [
    ['script-framework-qa', '七步流程'],
    ['script-writing-expansion', '写作模式'],
    ['script-doctor-roundtable', '剧本医生'],
    ['dialogue-doctor-diagnosis', '七维诊断框架'],
  ] as const

  it('saves uploaded script skills under project .claude skills for server discovery', () => {
    for (const [name, marker] of skills) {
      const path = join(skillRoot, name, 'SKILL.md')
      expect(existsSync(path), `${name} should exist`).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain(marker)
    }
  })

  it('script-agent expand-script prompt preserves the script-to-casting contract', async () => {
    const expandPrompt = (await import('@/lib/agents/script-agent/prompts/expand-script.md?raw')).default
    expect(expandPrompt).toContain('script-agent / expand-script')
    expect(expandPrompt).toContain('Casting 角色卡')
    expect(expandPrompt).toContain('framework_calibration')
    expect(expandPrompt).toContain('expanded_script_baseline')
    expect(expandPrompt).toContain('casting_cards')
    expect(expandPrompt).toContain('scene_cards')
    expect(expandPrompt).toContain('prop_cards')
    expect(expandPrompt).toContain('只输出 JSON')
  })

  it('character material prompt enforces the required three-view CG system prompt', async () => {
    // characterImageGen was migrated to art-director-agent/prompts/character-image.md.
    const promptSource = (
      await import('@/lib/agents/art-director-agent/prompts/character-image.md?raw')
    ).default
    expect(promptSource).toContain('Sony Venice camera')
    expect(promptSource).toContain('Panavision C-series lenses')
    expect(promptSource).toContain('24mm focal length')
    expect(promptSource).toContain('f/1.4 aperture')
    expect(promptSource).toContain('Final Fantasy CG game style')
    expect(promptSource).toContain('top 1/3')
    expect(promptSource).toContain('lower 2/3')
    expect(promptSource).toContain('three-view')
    expect(promptSource).toContain('front view, side view, back view')
    expect(promptSource).toContain('no head visible')
    expect(promptSource).toContain('pure white background')
  })
})
