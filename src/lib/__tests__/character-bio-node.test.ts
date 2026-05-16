import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeIntent } from '../chat-intent'
import { api } from '../api-client'
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useChatStore } from '@/stores/chat-store'
import { useProjectDB } from '@/stores/project-db'
import { useProjectStore } from '@/stores/project-store'
import { useTimelineStore } from '@/stores/timeline-store'

function resetStores() {
  useChatStore.setState({
    messages: [],
    isLoading: false,
    activeSkill: null,
    skillProgress: null,
  })
  useProjectStore.setState({
    episodeIndex: 0,
    episodes: [],
    characters: [],
    scenes: [],
    props: [],
    keyframes: [],
    shots: [],
  })
  useTimelineStore.setState({
    shots: [],
    tracks: [],
    playheadTime: 0,
    duration: 120,
    zoom: 1,
    isPlaying: false,
    snapEnabled: true,
    snapInterval: 1,
  })
  useCanvasStore.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
  useAssetStore.setState({ assets: [] })
  useProjectDB.getState().clearAll()
}

describe('character asset canvas bio nodes', () => {
  beforeEach(() => {
    resetStores()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a character bio text node before and linked to the character image node', async () => {
    vi.spyOn(api.characters, 'generate').mockResolvedValue({
      characters: [
        {
          asset_id: 'char_hero',
          asset_identifier: '阿澈',
          img_url: '/uploads/ache.png',
          prompt: 'Silver-haired teen investigator, navy coat, anxious eyes',
          description: '17岁，表面冷静但长期失眠；习惯用指节敲桌面来压住恐惧。',
        },
      ],
    })

    await executeIntent({ skill: 'generateCharacters', label: 'Generate Characters' }, 'test-project', '生成角色')

    const characterAsset = useAssetStore.getState().getAssetsByType('character')[0]
    expect(characterAsset?.name).toBe('阿澈')

    const canvas = useCanvasStore.getState()
    const items = useCanvasItemStore.getState().items
    const imageNode = canvas.nodes.find((node) => node.data.assetId === characterAsset.id)
    expect(imageNode).toBeDefined()

    const bioNode = canvas.nodes.find((node) => {
      const itemId = node.data.itemId
      if (!itemId) return false
      const item = items[itemId]
      return node.type === 'text'
        && item?.kind === 'text'
        && item.name === '角色设定：阿澈'
        && item.content.includes('17岁，表面冷静')
        && item.content.includes('Silver-haired teen investigator')
    })
    expect(bioNode).toBeDefined()

    expect(canvas.nodes.findIndex((node) => node.id === bioNode!.id))
      .toBeLessThan(canvas.nodes.findIndex((node) => node.id === imageNode!.id))
    expect(canvas.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: bioNode!.id, target: imageNode!.id }),
      ]),
    )
  })
})
