import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useProjectDB } from '@/stores/project-db'
import { fillPrompt } from '@/lib/prompts'

function resetDB() { useProjectDB.getState().clearAll() }

describe('Director Pipeline — Art Direction Config', () => {
  beforeEach(resetDB)

  it('has cinematic defaults', () => {
    const art = useProjectDB.getState().artDirection
    expect(art.stylePreset).toBe('cinematic')
    expect(art.defaultAspectRatio).toBe('16:9')
    expect(art.defaultImageModel).toBe('fal-ai/flux-pro/v1.1')
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
    const labels = state.stages.flatMap((stage) => stage.steps.map((step) => step.label))
    expect(labels).toEqual(expect.arrayContaining([
      '剧本框架七层校准',
      '完整剧本扩写',
      '剧本医生圆桌会诊',
      '台词专家全量诊断',
      'Casting 角色卡与表演锚点',
      '角色/场景/道具素材生成',
    ]))
    expect(state.stages[0].description).toContain('Script → Casting')
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

  it('director prompts reference the saved skills and preserve script-to-casting contract', () => {
    const prompt = fillPrompt('scriptToCastingFlow', {
      scriptText: '场景1：主角沉默。',
      artStyle: 'cinematic',
      canvasContext: '画布为空',
      existingStoryboard: '',
    })
    expect(prompt).toContain('script-framework-qa')
    expect(prompt).toContain('script-writing-expansion')
    expect(prompt).toContain('script-doctor-roundtable')
    expect(prompt).toContain('dialogue-doctor-diagnosis')
    expect(prompt).toContain('Casting 角色卡')
    expect(prompt).toContain('只输出 JSON')
  })

  it('character material prompt enforces the required three-view CG system prompt', () => {
    const prompt = fillPrompt('characterImageGen', {
      characterDescription: '女主角，黑色短发，银色战术外套',
      artStyle: 'cinematic',
    })
    expect(prompt).toContain('Sony Venice camera')
    expect(prompt).toContain('Panavision C-series lenses')
    expect(prompt).toContain('24mm focal length')
    expect(prompt).toContain('f/1.4 aperture')
    expect(prompt).toContain('Final Fantasy CG game style')
    expect(prompt).toContain('top 1/3')
    expect(prompt).toContain('lower 2/3')
    expect(prompt).toContain('three-view')
    expect(prompt).toContain('front view, side view, back view')
    expect(prompt).toContain('no head visible')
    expect(prompt).toContain('pure white background')
  })
})
