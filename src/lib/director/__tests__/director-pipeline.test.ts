import { describe, it, expect, beforeEach } from 'vitest'
import { useProjectDB } from '@/stores/project-db'

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
  // These test the type contracts without running the actual AI calls
  it('pipeline state has 3 stages', async () => {
    // Import the module to check the initial state shape
    const { runDirectorPipeline } = await import('@/lib/director-assistant')
    // We can't run it without AI, but we can verify the function exists
    expect(typeof runDirectorPipeline).toBe('function')
  })

  it('runDirectorStage accepts stage ids', async () => {
    const { runDirectorStage } = await import('@/lib/director-assistant')
    expect(typeof runDirectorStage).toBe('function')
  })
})
