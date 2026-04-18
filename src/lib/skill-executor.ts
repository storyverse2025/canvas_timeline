import { api } from './api-client'
import { useCanvasStore } from '@/stores/canvas-store'
import { useAssetStore } from '@/stores/asset-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useProjectStore } from '@/stores/project-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useChatStore } from '@/stores/chat-store'
import type { Episode, Character, Scene, Prop, Keyframe } from '@/types/backend'

function autoLayout(index: number, category: string): { x: number; y: number } {
  const columns: Record<string, number> = {
    character: 100,
    scene: 350,
    prop: 600,
    keyframe: 850,
  }
  return { x: columns[category] ?? 100, y: index * 180 }
}

function addVisualAsset(
  type: 'character' | 'scene' | 'prop' | 'keyframe',
  name: string,
  imageUrl: string | undefined,
  prompt: string | undefined,
  sourceId: string | undefined,
  index: number
): string {
  const assetStore = useAssetStore.getState()
  const canvasStore = useCanvasStore.getState()

  const assetId = assetStore.addAsset({
    type,
    name,
    imageUrl,
    prompt,
    sourceId,
    status: imageUrl ? 'completed' : 'pending',
    tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: type, label: name }],
  })
  canvasStore.addNode(assetId, autoLayout(index, type))
  return assetId
}

export const skills = {
  async generateScript(projectId: string, settings: { inspiration: string }) {
    const timelineStore = useTimelineStore.getState()
    const projectStore = useProjectStore.getState()

    try {
      const result = await api.scripts.generate(projectId, settings)
      projectStore.setEpisodes(result.episodes)

      const assetIds: string[] = []
      const itemIds: string[] = []
      let beatIndex = 0

      // Get or create keyframe track
      const keyframeTrack = timelineStore.tracks.find((t) => t.type === 'keyframe')
        ?? { id: timelineStore.addTrack('keyframe', '关键帧') }

      for (const episode of result.episodes) {
        if (episode.beats) {
          for (const beat of episode.beats) {
            const dur = beat.duration_seconds || 12
            const startTime = keyframeTrack.items?.reduce((m: number, i: any) => Math.max(m, i.startTime + i.duration), 0) ?? beatIndex * dur
            const itemId = timelineStore.addItem(keyframeTrack.id, {
              label: `Beat ${beat.number}`,
              startTime,
              duration: dur,
            })
            itemIds.push(itemId)
            beatIndex++
          }
        }
      }

      useChatStore.getState().addMessage('action', `Created ${itemIds.length} keyframe timeline items (demo mode)`, {
        type: 'generate_script', status: 'success', timelineItemIds: itemIds,
      })
      return { assetIds, itemIds }
    } catch (err) {
      return createDemoScript(timelineStore, projectStore)
    }
  },

  async generateCharacters(projectId: string, episodes: Episode[]) {
    const projectStore = useProjectStore.getState()
    try {
      const result = await api.characters.generate(projectId, { episodes })
      projectStore.setCharacters(result.characters)
      return createCharacterAssets(result.characters)
    } catch {
      return createDemoCharacters(projectStore)
    }
  },

  async generateScenes(projectId: string) {
    const projectStore = useProjectStore.getState()
    try {
      const result = await api.scenes.list(projectId)
      projectStore.setScenes(result.scenes)
      return createSceneAssets(result.scenes)
    } catch {
      return createDemoScenes(projectStore)
    }
  },

  async generateProps(projectId: string) {
    const projectStore = useProjectStore.getState()
    try {
      const result = await api.props.list(projectId)
      projectStore.setProps(result.props)
      return createPropAssets(result.props)
    } catch {
      return createDemoProps(projectStore)
    }
  },

  async generateKeyframes(projectId: string, episodeId: string) {
    const timelineStore = useTimelineStore.getState()
    const mappingStore = useMappingStore.getState()
    const projectStore = useProjectStore.getState()

    try {
      const result = await api.keyframes.list(projectId, episodeId)
      projectStore.setKeyframes(result.keyframes)
      return createKeyframeAssets(timelineStore, mappingStore, result.keyframes)
    } catch {
      return createDemoKeyframes(timelineStore, mappingStore, projectStore)
    }
  },

  async generateVideoShots(projectId: string, episodeIndex: number) {
    const projectStore = useProjectStore.getState()
    try {
      const result = await api.shots.list(projectId, episodeIndex, 'en')
      projectStore.setShots(result.shots)
      useChatStore.getState().addMessage('action', `Loaded ${result.shots.length} video shots`, {
        type: 'generate_shots', status: 'success',
      })
      return { shots: result.shots }
    } catch {
      useChatStore.getState().addMessage('assistant', 'Video shot generation will be available when connected to the backend.')
      return { shots: [] }
    }
  },

  async runEditPipeline(projectId: string, episodeId: string) {
    try {
      const result = await api.edits.render(projectId, episodeId, 'default')
      useChatStore.getState().addMessage('action', 'Edit pipeline started', {
        type: 'edit_pipeline', status: 'success', data: result as unknown as Record<string, unknown>,
      })
      return result
    } catch {
      useChatStore.getState().addMessage('assistant', 'Edit pipeline will be available when connected to the backend.')
      return null
    }
  },

  async autoMapTimeline() {
    const assetStore = useAssetStore.getState()
    const timelineStore = useTimelineStore.getState()
    const mappingStore = useMappingStore.getState()

    mappingStore.clearLinks()
    let linkCount = 0

    for (const track of timelineStore.tracks) {
      for (const item of track.items) {
        if (item.assetId) {
          linkCount++ // already linked
          continue
        }
        // Try to match by label
        for (const asset of assetStore.assets) {
          const itemLabel = item.label.toLowerCase()
          const assetName = asset.name.toLowerCase()
          if (itemLabel.includes(assetName) || assetName.includes(itemLabel)) {
            timelineStore.updateItem(item.id, { assetId: asset.id })
            mappingStore.addLinkByAsset(asset.id, item.id, 0.8, true)
            linkCount++
            break
          }
        }
      }
    }

    useChatStore.getState().addMessage('action', `Auto-mapped ${linkCount} connections between assets and timeline`, {
      type: 'auto_map', status: 'success',
    })
    return { linkCount }
  },

  async runFullPipeline(
    projectId: string,
    settings: Record<string, unknown>,
    onProgress: (step: number, total: number, label: string) => void
  ) {
    const total = 7
    onProgress(1, total, 'Generating script...')
    await this.generateScript(projectId, { inspiration: (settings.inspiration as string) || 'Creative story' })

    onProgress(2, total, 'Generating characters...')
    const { episodes } = useProjectStore.getState()
    await this.generateCharacters(projectId, episodes)

    onProgress(3, total, 'Generating scenes...')
    await this.generateScenes(projectId)

    onProgress(4, total, 'Generating props...')
    await this.generateProps(projectId)

    onProgress(5, total, 'Generating keyframes...')
    await this.generateKeyframes(projectId, '1')

    onProgress(6, total, 'Auto-mapping timeline...')
    await this.autoMapTimeline()

    onProgress(7, total, 'Generating video shots...')
    await this.generateVideoShots(projectId, 1)
  },

  async analyzeQuality(projectId: string, itemType: string, itemId: string) {
    try {
      const result = await api.aiAgents.analyze({ page_context: 'canvas', item_type: itemType, item_id: itemId })
      useChatStore.getState().addMessage('action', `Found ${result.issues.length} issues and ${result.suggestions.length} suggestions`, {
        type: 'analyze', status: 'success', data: result as unknown as Record<string, unknown>,
      })
      return result
    } catch {
      useChatStore.getState().addMessage('assistant', 'Quality analysis will be available when connected to the backend.')
      return { issues: [], suggestions: [] }
    }
  },

  async regenerateCharacter(projectId: string, charId: string, prompt: string) {
    return api.characters.regenerate(projectId, charId, { prompt, gacha: true })
  },

  async regenerateKeyframe(projectId: string, episodeId: string, keyframeId: string, prompt: string) {
    return api.keyframes.regenerate(projectId, episodeId, keyframeId, { prompt })
  },
}

// === Asset creators (replace old node creators) ===

function createCharacterAssets(characters: Character[]) {
  const assetIds = characters.map((char, i) =>
    addVisualAsset('character', char.asset_identifier, char.img_url, char.prompt, char.asset_id, i)
  )
  useChatStore.getState().addMessage('action', `Created ${assetIds.length} character assets`, {
    type: 'generate_characters', status: 'success',
  })
  return { assetIds }
}

function createDemoCharacters(projectStore: ReturnType<typeof useProjectStore.getState>) {
  const demoChars: Character[] = [
    { asset_id: 'char_001', asset_identifier: '英雄', description: '主角' },
    { asset_id: 'char_002', asset_identifier: '导师', description: '智慧向导' },
    { asset_id: 'char_003', asset_identifier: '反派', description: '反派角色' },
    { asset_id: 'char_004', asset_identifier: '盟友', description: '忠实伙伴' },
  ]
  projectStore.setCharacters(demoChars)
  return createCharacterAssets(demoChars)
}

function createSceneAssets(scenes: Scene[]) {
  const assetIds = scenes.map((scene, i) =>
    addVisualAsset('scene', scene.name, scene.image_url, scene.prompt, scene.id, i)
  )
  useChatStore.getState().addMessage('action', `Created ${assetIds.length} scene assets`, {
    type: 'generate_scenes', status: 'success',
  })
  return { assetIds }
}

function createDemoScenes(projectStore: ReturnType<typeof useProjectStore.getState>) {
  const demoScenes: Scene[] = [
    { id: 'scene_001', name: '魔法森林', description: '神秘森林' },
    { id: 'scene_002', name: '水晶洞穴', description: '水晶洞' },
    { id: 'scene_003', name: '黑暗塔楼', description: '反派据点' },
  ]
  projectStore.setScenes(demoScenes)
  return createSceneAssets(demoScenes)
}

function createPropAssets(props: Prop[]) {
  const assetIds = props.map((prop, i) =>
    addVisualAsset('prop', prop.name, prop.image_url, prop.prompt, prop.id, i)
  )
  useChatStore.getState().addMessage('action', `Created ${assetIds.length} prop assets`, {
    type: 'generate_props', status: 'success',
  })
  return { assetIds }
}

function createDemoProps(projectStore: ReturnType<typeof useProjectStore.getState>) {
  const demoProps: Prop[] = [
    { id: 'prop_001', name: '魔法剑', description: '传说武器' },
    { id: 'prop_002', name: '古老地图', description: '指引方向' },
  ]
  projectStore.setProps(demoProps)
  return createPropAssets(demoProps)
}

function createKeyframeAssets(
  timelineStore: ReturnType<typeof useTimelineStore.getState>,
  mappingStore: ReturnType<typeof useMappingStore.getState>,
  keyframes: Keyframe[]
) {
  const assetIds: string[] = []
  const itemIds: string[] = []

  const keyframeTrack = timelineStore.tracks.find((t) => t.type === 'keyframe')
  if (!keyframeTrack) {
    useChatStore.getState().addMessage('system', 'No keyframe track found — initializing tracks...')
    timelineStore.initDefaultTracks()
  }
  const track = timelineStore.tracks.find((t) => t.type === 'keyframe')!

  keyframes.forEach((kf, i) => {
    const assetId = addVisualAsset('keyframe', `关键帧 ${kf.beat_number}`, kf.image_url, kf.prompt, kf.id, i)
    assetIds.push(assetId)

    const startTime = i * 10
    const itemId = timelineStore.addItem(track.id, {
      assetId,
      label: `关键帧 ${kf.beat_number}`,
      startTime,
      duration: 10,
    })
    itemIds.push(itemId)
    mappingStore.addLinkByAsset(assetId, itemId, 0.9, true)
  })

  useChatStore.getState().addMessage('action', `Created ${assetIds.length} keyframe assets with timeline links`, {
    type: 'generate_keyframes', status: 'success', timelineItemIds: itemIds,
  })
  return { assetIds, itemIds }
}

function createDemoKeyframes(
  timelineStore: ReturnType<typeof useTimelineStore.getState>,
  mappingStore: ReturnType<typeof useMappingStore.getState>,
  projectStore: ReturnType<typeof useProjectStore.getState>
) {
  const demoKeyframes: Keyframe[] = Array.from({ length: 5 }, (_, i) => ({
    id: `kf_${i + 1}`,
    beat_number: i + 1,
    prompt: `关键帧 ${i + 1} 的场景描述`,
  }))
  projectStore.setKeyframes(demoKeyframes)
  return createKeyframeAssets(timelineStore, mappingStore, demoKeyframes)
}

function createDemoScript(
  timelineStore: ReturnType<typeof useTimelineStore.getState>,
  projectStore: ReturnType<typeof useProjectStore.getState>
) {
  const demoBeats = [
    { number: 1, duration: 12 },
    { number: 2, duration: 15 },
    { number: 3, duration: 10 },
    { number: 4, duration: 12 },
    { number: 5, duration: 8 },
  ]

  const keyframeTrack = timelineStore.tracks.find((t) => t.type === 'keyframe')
  if (!keyframeTrack) timelineStore.initDefaultTracks()
  const track = timelineStore.tracks.find((t) => t.type === 'keyframe')!

  const itemIds: string[] = []
  let startTime = 0
  for (const beat of demoBeats) {
    const itemId = timelineStore.addItem(track.id, {
      label: `Beat ${beat.number}`,
      startTime,
      duration: beat.duration,
    })
    itemIds.push(itemId)
    startTime += beat.duration
  }

  useChatStore.getState().addMessage('action', `Created ${itemIds.length} timeline beats (demo mode)`, {
    type: 'generate_script', status: 'success', timelineItemIds: itemIds,
  })
  return { assetIds: [], itemIds }
}
