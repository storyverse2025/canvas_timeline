import { api } from './api-client'
import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useProjectStore } from '@/stores/project-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useChatStore } from '@/stores/chat-store'
import type { Episode, Character, Scene, Prop, Keyframe } from '@/types/backend'
import type { ScriptNodeData, VisualAssetNodeData } from '@/types/canvas'

function autoLayout(index: number, category: string): { x: number; y: number } {
  const columns: Record<string, number> = {
    dialogue: 0,
    narration: 250,
    character: 550,
    scene: 800,
    prop: 1050,
    keyframe: 550,
  }
  return { x: columns[category] ?? 0, y: index * 160 }
}

export const skills = {
  async generateScript(projectId: string, settings: { inspiration: string }) {
    const canvasStore = useCanvasStore.getState()
    const timelineStore = useTimelineStore.getState()
    const projectStore = useProjectStore.getState()

    try {
      const result = await api.scripts.generate(projectId, settings)
      projectStore.setEpisodes(result.episodes)

      const nodeIds: string[] = []
      const shotIds: string[] = []
      let beatIndex = 0

      for (const episode of result.episodes) {
        if (episode.beats) {
          for (const beat of episode.beats) {
            // Create a shot for each beat
            const shotId = timelineStore.addShot(`Beat ${beat.number}`, beat.duration_seconds || 12)
            shotIds.push(shotId)

            // Create dialogue nodes
            if (beat.dialogues) {
              for (const dialogue of beat.dialogues) {
                const id = canvasStore.addNode('script', {
                  scriptType: 'dialogue',
                  content: dialogue.text,
                  characterName: dialogue.speaker,
                  beatNumber: beat.number,
                  tags: [{ id: `tag-${Date.now()}-${Math.random()}`, category: 'character', label: `Character: ${dialogue.speaker}` }],
                } as ScriptNodeData, autoLayout(beatIndex, 'dialogue'))
                nodeIds.push(id)
                timelineStore.linkNodeToShot(shotId, id)
                useMappingStore.getState().addLinkToShot(id, shotId)
              }
            }

            // Create narration nodes
            if (beat.narration) {
              const id = canvasStore.addNode('script', {
                scriptType: 'narration',
                content: beat.narration,
                beatNumber: beat.number,
                tags: [{ id: `tag-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beat.number}` }],
              } as ScriptNodeData, autoLayout(beatIndex, 'narration'))
              nodeIds.push(id)
              timelineStore.linkNodeToShot(shotId, id)
              useMappingStore.getState().addLinkToShot(id, shotId)
            }

            beatIndex++
          }
        }
      }

      useChatStore.getState().addMessage('action', `Created ${nodeIds.length} script nodes and ${shotIds.length} shots`, {
        type: 'generate_script',
        status: 'success',
        canvasNodeIds: nodeIds,
        timelineItemIds: shotIds,
      })

      return { nodeIds, shotIds }
    } catch (err) {
      // Demo mode: create sample data
      return createDemoScript(canvasStore, timelineStore, projectStore)
    }
  },

  async generateCharacters(projectId: string, episodes: Episode[]) {
    const canvasStore = useCanvasStore.getState()
    const projectStore = useProjectStore.getState()

    try {
      const result = await api.characters.generate(projectId, { episodes })
      projectStore.setCharacters(result.characters)
      return createCharacterNodes(canvasStore, result.characters)
    } catch {
      return createDemoCharacters(canvasStore, projectStore)
    }
  },

  async generateScenes(projectId: string) {
    const canvasStore = useCanvasStore.getState()
    const projectStore = useProjectStore.getState()

    try {
      const result = await api.scenes.list(projectId)
      projectStore.setScenes(result.scenes)
      return createSceneNodes(canvasStore, result.scenes)
    } catch {
      return createDemoScenes(canvasStore, projectStore)
    }
  },

  async generateProps(projectId: string) {
    const canvasStore = useCanvasStore.getState()
    const projectStore = useProjectStore.getState()

    try {
      const result = await api.props.list(projectId)
      projectStore.setProps(result.props)
      return createPropNodes(canvasStore, result.props)
    } catch {
      return createDemoProps(canvasStore, projectStore)
    }
  },

  async generateKeyframes(projectId: string, episodeId: string) {
    const canvasStore = useCanvasStore.getState()
    const timelineStore = useTimelineStore.getState()
    const mappingStore = useMappingStore.getState()
    const projectStore = useProjectStore.getState()

    try {
      const result = await api.keyframes.list(projectId, episodeId)
      projectStore.setKeyframes(result.keyframes)
      return createKeyframeNodes(canvasStore, timelineStore, mappingStore, result.keyframes)
    } catch {
      return createDemoKeyframes(canvasStore, timelineStore, mappingStore, projectStore)
    }
  },

  async generateVideoShots(projectId: string, episodeIndex: number) {
    const projectStore = useProjectStore.getState()
    try {
      const result = await api.shots.list(projectId, episodeIndex, 'en')
      projectStore.setShots(result.shots)
      useChatStore.getState().addMessage('action', `Loaded ${result.shots.length} video shots`, {
        type: 'generate_shots',
        status: 'success',
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
        type: 'edit_pipeline',
        status: 'success',
        data: result as unknown as Record<string, unknown>,
      })
      return result
    } catch {
      useChatStore.getState().addMessage('assistant', 'Edit pipeline will be available when connected to the backend.')
      return null
    }
  },

  async autoMapTimeline() {
    const canvasStore = useCanvasStore.getState()
    const timelineStore = useTimelineStore.getState()
    const mappingStore = useMappingStore.getState()

    mappingStore.clearLinks()
    let linkCount = 0

    for (const shot of timelineStore.shots) {
      for (const node of canvasStore.nodes) {
        if (shot.linkedNodeIds.includes(node.id)) continue

        const data = node.data as Record<string, unknown>
        let matched = false

        // Match by beat number
        const beatMatch = shot.label.match(/\d+/)
        const shotBeat = beatMatch ? parseInt(beatMatch[0]) : null

        if (shotBeat && 'beatNumber' in data && data.beatNumber === shotBeat) {
          matched = true
        }

        if (!matched && node.type === 'visual' && 'label' in data) {
          const nodeLabel = String(data.label).toLowerCase()
          if (shot.label.toLowerCase().includes(nodeLabel) || nodeLabel.includes(shot.label.toLowerCase())) {
            matched = true
          }
        }

        if (matched) {
          timelineStore.linkNodeToShot(shot.id, node.id)
          mappingStore.addLink(node.id, shot.id, 0.8, true)
          linkCount++
        }
      }
    }

    useChatStore.getState().addMessage('action', `Auto-mapped ${linkCount} connections between canvas and timeline`, {
      type: 'auto_map',
      status: 'success',
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
        type: 'analyze',
        status: 'success',
        data: result as unknown as Record<string, unknown>,
      })
      return result
    } catch {
      useChatStore.getState().addMessage('assistant', 'Quality analysis will be available when connected to the backend.')
      return { issues: [], suggestions: [] }
    }
  },

  async regenerateCharacter(projectId: string, charId: string, prompt: string) {
    const result = await api.characters.regenerate(projectId, charId, { prompt, gacha: true })
    return result
  },

  async regenerateKeyframe(projectId: string, episodeId: string, keyframeId: string, prompt: string) {
    const result = await api.keyframes.regenerate(projectId, episodeId, keyframeId, { prompt })
    return result
  },
}

// === Demo data creators (when backend is unavailable) ===

function createDemoScript(
  canvasStore: ReturnType<typeof useCanvasStore.getState>,
  timelineStore: ReturnType<typeof useTimelineStore.getState>,
  projectStore: ReturnType<typeof useProjectStore.getState>
) {
  const demoBeats = [
    { number: 1, narration: 'In a world where stories come alive...', dialogues: [{ speaker: 'Narrator', text: 'Once upon a time, in a land far away...' }] },
    { number: 2, narration: 'Our hero discovers a hidden power.', dialogues: [{ speaker: 'Hero', text: 'What is this strange light?' }, { speaker: 'Mentor', text: 'It is your destiny.' }] },
    { number: 3, narration: 'The journey begins.', dialogues: [{ speaker: 'Hero', text: 'I must find the truth.' }] },
    { number: 4, narration: 'Challenges arise at every turn.', dialogues: [{ speaker: 'Villain', text: 'You will never succeed!' }] },
    { number: 5, narration: 'But hope endures.', dialogues: [{ speaker: 'Hero', text: 'I will not give up.' }, { speaker: 'Ally', text: 'We are with you.' }] },
  ]

  const episodes: Episode[] = [{
    episode_number: 1,
    title: 'The Beginning',
    content: 'Demo episode content',
    beats: demoBeats.map((b) => ({
      number: b.number,
      duration_seconds: 12,
      narration: b.narration,
      dialogues: b.dialogues.map((d) => ({ speaker: d.speaker, text: d.text })),
    })),
  }]

  projectStore.setEpisodes(episodes)
  const nodeIds: string[] = []
  const shotIds: string[] = []

  demoBeats.forEach((beat, i) => {
    // Create shot for each beat
    const shotId = timelineStore.addShot(`Beat ${beat.number}`, 12)
    shotIds.push(shotId)

    for (const dialogue of beat.dialogues) {
      const nodeId = canvasStore.addNode('script', {
        scriptType: 'dialogue', content: dialogue.text, characterName: dialogue.speaker,
        beatNumber: beat.number, tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'character', label: `Character: ${dialogue.speaker}` }],
      } as ScriptNodeData, autoLayout(i, 'dialogue'))
      nodeIds.push(nodeId)
      timelineStore.linkNodeToShot(shotId, nodeId)
      useMappingStore.getState().addLinkToShot(nodeId, shotId)
    }

    if (beat.narration) {
      const nodeId = canvasStore.addNode('script', {
        scriptType: 'narration', content: beat.narration, beatNumber: beat.number,
        tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beat.number}` }],
      } as ScriptNodeData, autoLayout(i, 'narration'))
      nodeIds.push(nodeId)
      timelineStore.linkNodeToShot(shotId, nodeId)
      useMappingStore.getState().addLinkToShot(nodeId, shotId)
    }
  })

  useChatStore.getState().addMessage('action', `Created ${nodeIds.length} script nodes and ${shotIds.length} shots (demo mode)`, {
    type: 'generate_script', status: 'success', canvasNodeIds: nodeIds, timelineItemIds: shotIds,
  })

  return { nodeIds, shotIds }
}

function createCharacterNodes(canvasStore: ReturnType<typeof useCanvasStore.getState>, characters: Character[]) {
  const nodeIds = characters.map((char, i) =>
    canvasStore.addNode('visual', {
      assetType: 'character', imageUrl: char.img_url, label: char.asset_identifier,
      sourceId: char.asset_id, prompt: char.prompt,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'character', label: `Character: ${char.asset_identifier}` }],
    } as VisualAssetNodeData, autoLayout(i, 'character'))
  )

  useChatStore.getState().addMessage('action', `Created ${nodeIds.length} character nodes`, {
    type: 'generate_characters', status: 'success', canvasNodeIds: nodeIds,
  })
  return { nodeIds }
}

function createDemoCharacters(canvasStore: ReturnType<typeof useCanvasStore.getState>, projectStore: ReturnType<typeof useProjectStore.getState>) {
  const demoChars: Character[] = [
    { asset_id: 'char_001', asset_identifier: 'Hero', description: 'The protagonist' },
    { asset_id: 'char_002', asset_identifier: 'Mentor', description: 'A wise guide' },
    { asset_id: 'char_003', asset_identifier: 'Villain', description: 'The antagonist' },
    { asset_id: 'char_004', asset_identifier: 'Ally', description: 'A loyal companion' },
  ]
  projectStore.setCharacters(demoChars)
  return createCharacterNodes(canvasStore, demoChars)
}

function createSceneNodes(canvasStore: ReturnType<typeof useCanvasStore.getState>, scenes: Scene[]) {
  const nodeIds = scenes.map((scene, i) =>
    canvasStore.addNode('visual', {
      assetType: 'scene', imageUrl: scene.image_url, label: scene.name,
      sourceId: scene.id, prompt: scene.prompt,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'scene', label: `Scene: ${scene.name}` }],
    } as VisualAssetNodeData, autoLayout(i, 'scene'))
  )

  useChatStore.getState().addMessage('action', `Created ${nodeIds.length} scene nodes`, {
    type: 'generate_scenes', status: 'success', canvasNodeIds: nodeIds,
  })
  return { nodeIds }
}

function createDemoScenes(canvasStore: ReturnType<typeof useCanvasStore.getState>, projectStore: ReturnType<typeof useProjectStore.getState>) {
  const demoScenes: Scene[] = [
    { id: 'scene_001', name: 'Enchanted Forest', description: 'A mystical forest' },
    { id: 'scene_002', name: 'Crystal Cave', description: 'A cave of crystals' },
    { id: 'scene_003', name: 'Dark Tower', description: 'The villain stronghold' },
  ]
  projectStore.setScenes(demoScenes)
  return createSceneNodes(canvasStore, demoScenes)
}

function createPropNodes(canvasStore: ReturnType<typeof useCanvasStore.getState>, props: Prop[]) {
  const nodeIds = props.map((prop, i) =>
    canvasStore.addNode('visual', {
      assetType: 'prop', imageUrl: prop.image_url, label: prop.name,
      sourceId: prop.id, prompt: prop.prompt,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'prop', label: `Prop: ${prop.name}` }],
    } as VisualAssetNodeData, autoLayout(i, 'prop'))
  )

  useChatStore.getState().addMessage('action', `Created ${nodeIds.length} prop nodes`, {
    type: 'generate_props', status: 'success', canvasNodeIds: nodeIds,
  })
  return { nodeIds }
}

function createDemoProps(canvasStore: ReturnType<typeof useCanvasStore.getState>, projectStore: ReturnType<typeof useProjectStore.getState>) {
  const demoProps: Prop[] = [
    { id: 'prop_001', name: 'Magic Sword', description: 'A legendary weapon' },
    { id: 'prop_002', name: 'Ancient Map', description: 'Shows the path' },
  ]
  projectStore.setProps(demoProps)
  return createPropNodes(canvasStore, demoProps)
}

function createKeyframeNodes(
  canvasStore: ReturnType<typeof useCanvasStore.getState>,
  timelineStore: ReturnType<typeof useTimelineStore.getState>,
  mappingStore: ReturnType<typeof useMappingStore.getState>,
  keyframes: Keyframe[]
) {
  const nodeIds: string[] = []
  const shotIds: string[] = []
  const linkIds: string[] = []

  keyframes.forEach((kf, i) => {
    const nodeId = canvasStore.addNode('visual', {
      assetType: 'keyframe', imageUrl: kf.image_url, label: `Keyframe ${kf.beat_number}`,
      sourceId: kf.id, prompt: kf.prompt,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${kf.beat_number}` }],
    } as VisualAssetNodeData, autoLayout(i, 'keyframe'))
    nodeIds.push(nodeId)

    // Find existing shot for this beat, or create one
    const existingShot = timelineStore.shots.find((s) => {
      const m = s.label.match(/\d+/)
      return m && parseInt(m[0]) === kf.beat_number
    })

    let shotId: string
    if (existingShot) {
      shotId = existingShot.id
    } else {
      shotId = timelineStore.addShot(`Beat ${kf.beat_number}`, 12)
    }
    shotIds.push(shotId)

    timelineStore.linkNodeToShot(shotId, nodeId)
    linkIds.push(mappingStore.addLink(nodeId, shotId, 0.9, true))
  })

  useChatStore.getState().addMessage('action', `Created ${nodeIds.length} keyframe nodes with timeline links`, {
    type: 'generate_keyframes', status: 'success', canvasNodeIds: nodeIds, timelineItemIds: shotIds,
  })

  return { nodeIds, shotIds, linkIds }
}

function createDemoKeyframes(
  canvasStore: ReturnType<typeof useCanvasStore.getState>,
  timelineStore: ReturnType<typeof useTimelineStore.getState>,
  mappingStore: ReturnType<typeof useMappingStore.getState>,
  projectStore: ReturnType<typeof useProjectStore.getState>
) {
  const demoKeyframes: Keyframe[] = Array.from({ length: 5 }, (_, i) => ({
    id: `kf_${i + 1}`,
    beat_number: i + 1,
    prompt: `Keyframe for beat ${i + 1}`,
  }))
  projectStore.setKeyframes(demoKeyframes)
  return createKeyframeNodes(canvasStore, timelineStore, mappingStore, demoKeyframes)
}
