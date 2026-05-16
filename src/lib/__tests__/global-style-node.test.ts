import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectDB } from '@/stores/project-db'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { ensureGlobalStyleNode, buildGlobalStyleDefinition } from '@/lib/global-style-node'

function resetStores() {
  useProjectDB.getState().clearAll()
  useCanvasStore.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
}

describe('global style node', () => {
  beforeEach(resetStores)

  it('builds a rich global art definition from the style library preset', () => {
    useProjectDB.getState().updateArtDirection({
      stylePreset: '3d_arcane_painterly_hybrid',
      customStyle: '角色脸部保持亚洲少女比例；梦境段落可增强紫蓝边缘光',
      defaultAspectRatio: '9:16',
    })

    const definition = buildGlobalStyleDefinition()

    expect(definition).toContain('Arcane Inspired Painterly 3D Hybrid')
    expect(definition).toContain('style_id: 3d_arcane_painterly_hybrid')
    expect(definition).toContain('category: 3d')
    expect(definition).toContain('Painterly hybrid 3D')
    expect(definition).toContain('Use painterly texture overlays with consistent brush language.')
    expect(definition).toContain('Facial animation supports nuanced dramatic acting, not broad caricature.')
    expect(definition).toContain('角色脸部保持亚洲少女比例')
    expect(definition).toContain('Aspect: 9:16')
    expect(definition).toContain('Image model: openai/gpt-5.4-image-2')
  })

  it('creates the canvas style node with library-informed production pack content', () => {
    useProjectDB.getState().updateArtDirection({
      stylePreset: 'liveaction_nolan_filmic',
    })

    const nodeId = ensureGlobalStyleNode()
    const node = useCanvasStore.getState().getNodeById(nodeId)
    const itemId = node?.data.itemId
    const item = itemId ? useCanvasItemStore.getState().items[itemId] : undefined

    expect(item?.role).toBe('style')
    expect(item?.content).toContain('Christopher Nolan Inspired Hollywood Cinematic')
    expect(item?.content).toContain('Kodak Vision3 500T color')
    expect(item?.content).toContain('Vintage 16mm lenses')
    expect(item?.content).toContain('Rule of Thirds, Over-the-Shoulder, Dirty Framing, avoid symmetry')
    expect(item?.content).toContain('Use photoreal live-action imagery only; no anime')
  })

  it('falls back to the style library default when preset is legacy/simple', () => {
    useProjectDB.getState().updateArtDirection({ stylePreset: 'cinematic' })

    const definition = buildGlobalStyleDefinition()

    expect(definition).toContain('style_id: anime_psych_thriller_motion_comic')
    expect(definition).toContain('Death Note x Re:Zero x Psycho-Pass')
    expect(definition).toContain('Psychological thriller motion comic anime style')
    expect(definition).toContain('No music bed; emotion is carried by SFX and short spoken lines.')
  })
})
