import { api } from './api-client'
import { useCanvasStore } from '@/stores/canvas-store'
import { useAssetStore } from '@/stores/asset-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useProjectStore } from '@/stores/project-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useChatStore } from '@/stores/chat-store'
import { useProjectDB } from '@/stores/project-db'
import { buildCharacterMaterialPrompt, CHARACTER_MATERIAL_SYSTEM_PROMPT } from '@/lib/canvas-elements'
import { runCapability } from '@/lib/capabilities/client'
import { streamClaude } from '@/lib/claude-client'
import type { Episode, Character, Scene, Prop, Keyframe } from '@/types/backend'

/**
 * Returns true when the projectId clearly does not point to a real backend
 * project — either the 'test' sentinel from chat-intent.ts (no project loaded)
 * or an empty/undefined value. Skills use this to short-circuit straight to
 * the local fallback instead of firing a doomed fetch that 404s.
 */
function isLocalOnlyProject(projectId: string | undefined | null): boolean {
  return !projectId || projectId === 'test'
}

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
    if (isLocalOnlyProject(projectId)) {
      return createLocalScriptDraft(settings.inspiration, null)
    }
    try {
      const result = await api.scripts.generate(projectId, settings)
      const itemIds = syncGeneratedScriptToStores(result.episodes, settings.inspiration)

      useChatStore.getState().addMessage('action', `Created ${itemIds.length} script beat timeline items`, {
        type: 'generate_script', status: 'success', timelineItemIds: itemIds,
      })
      return { assetIds: [], itemIds }
    } catch (err) {
      return createLocalScriptDraft(settings.inspiration, err)
    }
  },

  async generateCharacters(projectId: string, episodes: Episode[]) {
    const projectStore = useProjectStore.getState()
    if (isLocalOnlyProject(projectId)) return createDemoCharacters(projectStore)
    try {
      const result = await api.characters.generate(projectId, {
        episodes,
        character_material_system_prompt: CHARACTER_MATERIAL_SYSTEM_PROMPT,
      })
      const characters = result.characters.map((char) => ({
        ...char,
        prompt: toCharacterMaterialPrompt(char),
      }))
      projectStore.setCharacters(characters)
      return createCharacterAssets(characters)
    } catch {
      return createDemoCharacters(projectStore)
    }
  },

  async generateScenes(projectId: string) {
    const projectStore = useProjectStore.getState()
    if (isLocalOnlyProject(projectId)) return createDemoScenes(projectStore)
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
    if (isLocalOnlyProject(projectId)) return createDemoProps(projectStore)
    try {
      const result = await api.props.list(projectId)
      projectStore.setProps(result.props)
      return createPropAssets(result.props)
    } catch {
      return createDemoProps(projectStore)
    }
  },

  async generateKeyframes(projectId: string, episodeId: string, opts?: { userInput?: string; count?: number }) {
    const timelineStore = useTimelineStore.getState()
    const mappingStore = useMappingStore.getState()
    const projectStore = useProjectStore.getState()

    if (isLocalOnlyProject(projectId)) {
      return generateKeyframesLocal(opts?.userInput ?? '', opts?.count ?? 5)
    }
    try {
      const result = await api.keyframes.list(projectId, episodeId)
      projectStore.setKeyframes(result.keyframes)
      return createKeyframeAssets(timelineStore, mappingStore, result.keyframes)
    } catch {
      return generateKeyframesLocal(opts?.userInput ?? '', opts?.count ?? 5)
    }
  },

  async generateVideoShots(projectId: string, episodeIndex: number) {
    const projectStore = useProjectStore.getState()
    if (isLocalOnlyProject(projectId)) {
      useChatStore.getState().addMessage('assistant', '本地模式：视频镜头生成需要后端项目。请在画布或表格上手动生成视频。')
      return { shots: [] }
    }
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
    if (isLocalOnlyProject(projectId)) {
      useChatStore.getState().addMessage('assistant', '本地模式：剪辑流水线需要后端项目。')
      return null
    }
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
    if (isLocalOnlyProject(projectId)) {
      useChatStore.getState().addMessage('assistant', '本地模式：质量分析需要后端项目。')
      return { issues: [], suggestions: [] }
    }
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
    return api.characters.regenerate(projectId, charId, {
      prompt: buildCharacterMaterialPrompt(prompt, getCharacterMaterialArtStyle()),
      gacha: true,
    })
  },

  async regenerateKeyframe(projectId: string, episodeId: string, keyframeId: string, prompt: string) {
    return api.keyframes.regenerate(projectId, episodeId, keyframeId, { prompt })
  },
}

// === Asset creators (replace old node creators) ===

function getCharacterMaterialArtStyle(): string {
  const artDirection = useProjectDB.getState().artDirection
  return artDirection.customStyle || artDirection.stylePreset || 'cinematic'
}

function toCharacterMaterialPrompt(char: Character): string {
  const basePrompt = char.prompt || char.description || char.asset_identifier || char.asset_id
  return buildCharacterMaterialPrompt(basePrompt, getCharacterMaterialArtStyle())
}

function createCharacterAssets(characters: Character[]) {
  const assetIds = characters.map((char, i) =>
    addVisualAsset('character', char.asset_identifier, char.img_url, toCharacterMaterialPrompt(char), char.asset_id, i)
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

/**
 * Parse `[IMAGE_PROMPT]: ...` lines (or bullet lines / numbered lines) out of
 * an LLM response. Falls back to splitting non-empty lines if no marker is
 * found, so we still get some prompts even when the model ignores the format.
 */
function extractImagePrompts(text: string, count: number): string[] {
  const out: string[] = []
  const re = /\[IMAGE_PROMPT\]\s*[:：]\s*([^\n]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && out.length < count) out.push(m[1].trim())
  if (out.length > 0) return out
  // Fallback: numbered or bullet lines
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[\s\-•*]*\d+[.、)]\s*/, '').replace(/^[\s\-•*]+/, '').trim())
    .filter((l) => l.length > 12)
  return lines.slice(0, count)
}

async function planKeyframePrompts(userInput: string, count: number): Promise<string[]> {
  const projectDb = useProjectDB.getState()
  const scriptText = projectDb.script?.text?.trim() ?? ''
  const artStyle = projectDb.artDirection?.customStyle?.trim() || projectDb.artDirection?.stylePreset || ''
  const system = `You are a storyboard artist. Produce exactly ${count} keyframe image prompts, one per line. Each line must start with "[IMAGE_PROMPT]:" followed by a detailed, self-contained visual prompt (1-2 sentences) that an image model can render directly. Cover the story arc beat by beat. No headers, no commentary, no numbering, just the ${count} [IMAGE_PROMPT] lines.`
  const context = [
    artStyle ? `Art style: ${artStyle}` : '',
    scriptText ? `Script / story beats:\n${scriptText.slice(0, 4000)}` : '',
    userInput ? `User request: ${userInput}` : '',
  ].filter(Boolean).join('\n\n')
  const userMsg = context || `Generate ${count} keyframes for a generic short animated film.`
  let full = ''
  try {
    for await (const ev of streamClaude([{ role: 'user', content: userMsg }], { system })) {
      if (ev.type === 'text') full += ev.text
      else if (ev.type === 'error') break
    }
  } catch {
    // Bridge unreachable — fall through to fallback prompts below.
  }
  const parsed = extractImagePrompts(full, count)
  if (parsed.length >= 1) return parsed
  return Array.from({ length: count }, (_, i) =>
    userInput
      ? `${userInput} — beat ${i + 1}, cinematic, ${artStyle || 'illustrated'}`
      : `Cinematic keyframe ${i + 1}, ${artStyle || 'illustrated'}, dramatic lighting, wide shot`,
  )
}

/**
 * Local-mode keyframe generation: ask the LLM (via the bridge) for image
 * prompts, create placeholder keyframe assets immediately, then fire image
 * generation per-asset in parallel and patch each asset's imageUrl when its
 * generation returns. Returns once placeholders + their timeline items exist;
 * the images fill in asynchronously.
 */
async function generateKeyframesLocal(userInput: string, count: number) {
  const timelineStore = useTimelineStore.getState()
  const mappingStore = useMappingStore.getState()
  const projectStore = useProjectStore.getState()
  const chatStore = useChatStore.getState()
  const assetStore = useAssetStore.getState()

  chatStore.addMessage('system', `本地模式：正在为 ${count} 个关键帧生成提示词…`)
  const prompts = await planKeyframePrompts(userInput, count)
  chatStore.addMessage('system', `已生成 ${prompts.length} 条提示词，开始并行渲染图片…`)

  const demoKeyframes: Keyframe[] = prompts.map((p, i) => ({
    id: `kf_${i + 1}`,
    beat_number: i + 1,
    prompt: p,
  }))
  projectStore.setKeyframes(demoKeyframes)
  const { assetIds, itemIds } = createKeyframeAssets(timelineStore, mappingStore, demoKeyframes)

  // Fire-and-forget per-asset image generation. We deliberately don't await
  // them all here so the function returns quickly and the UI can show
  // placeholders → images as each completes.
  void Promise.all(
    assetIds.map(async (assetId, i) => {
      const prompt = prompts[i]
      try {
        const result = await runCapability({
          capability: 'text-to-image',
          inputs: [{ kind: 'text', text: prompt }],
          params: { aspect: '16:9' },
        })
        const url = result.outputs[0]?.url
        if (!url) throw new Error('no image url')
        assetStore.updateAsset(assetId, { imageUrl: url, status: 'completed' })
      } catch (err) {
        assetStore.updateAsset(assetId, { status: 'failed' })
        chatStore.addMessage('system', `关键帧 ${i + 1} 渲染失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }),
  ).then(() => {
    chatStore.addMessage('system', `✓ 关键帧渲染完成（${assetIds.length} 张）`)
  })

  return { assetIds, itemIds }
}

function getOrCreateKeyframeTrack() {
  const timelineStore = useTimelineStore.getState()
  let track = timelineStore.tracks.find((t) => t.type === 'keyframe')
  if (track) return track

  timelineStore.initDefaultTracks()
  track = useTimelineStore.getState().tracks.find((t) => t.type === 'keyframe')
  if (track) return track

  const trackId = useTimelineStore.getState().addTrack('keyframe', '关键帧')
  track = useTimelineStore.getState().tracks.find((t) => t.id === trackId)
  if (!track) throw new Error('Failed to create keyframe track')
  return track
}

function createScriptTimelineItems(episodes: Episode[]): string[] {
  const itemIds: string[] = []

  for (const episode of episodes) {
    for (const beat of episode.beats ?? []) {
      const track = getOrCreateKeyframeTrack()
      const duration = Math.max(1, beat.duration_seconds || 8)
      const startTime = track.items.reduce((max, item) => Math.max(max, item.startTime + item.duration), 0)
      const label = getBeatLabel(beat.number, beat.narration || beat.action || episode.title)
      const itemId = useTimelineStore.getState().addItem(track.id, { label, startTime, duration })
      itemIds.push(itemId)
    }
  }

  return itemIds
}

function createLocalScriptDraft(inspiration: string, err?: unknown) {
  const episodes = buildLocalEpisodesFromPrompt(inspiration)
  const itemIds = syncGeneratedScriptToStores(episodes, inspiration)
  const reason = err ? '（后端暂不可用，已切换本地草稿）' : '（本地草稿）'

  useChatStore.getState().addMessage(
    'action',
    `已基于用户输入生成本地剧本草稿 ${reason}：${episodes[0]?.title ?? '未命名'}，${itemIds.length} 个可编辑时间线节拍。`,
    { type: 'generate_script', status: 'success', timelineItemIds: itemIds }
  )
  return { assetIds: [], itemIds }
}

function syncGeneratedScriptToStores(episodes: Episode[], sourcePrompt: string): string[] {
  const projectStore = useProjectStore.getState()
  projectStore.setEpisodes(episodes)
  projectStore.setEpisodeIndex(0)

  const scriptText = episodesToScriptText(episodes)
  useProjectDB.getState().updateScript({
    text: [sourcePrompt.trim(), scriptText].filter(Boolean).join('\n\n---\n\n'),
    optimizedText: scriptText,
  })

  const itemIds = createScriptTimelineItems(episodes)
  createScriptCanvasNodes(itemIds)
  return itemIds
}

function createScriptCanvasNodes(itemIds: string[]): string[] {
  const canvasStore = useCanvasStore.getState()
  return itemIds.map((itemId, index) =>
    canvasStore.addItemNode(
      itemId,
      'text',
      { x: 80 + (index % 2) * 340, y: 80 + Math.floor(index / 2) * 180 },
      { width: 300, height: 130 }
    )
  )
}

function episodesToScriptText(episodes: Episode[]): string {
  return episodes.map((episode) => {
    const beats = (episode.beats ?? []).map((beat) => {
      const dialogue = (beat.dialogues ?? [])
        .map((line) => `${line.speaker}: ${line.text}`)
        .join('\n')
      return [
        `### Beat ${beat.number}`,
        `时长：${beat.duration_seconds ?? 0}秒`,
        beat.narration ? `旁白/画面：${beat.narration}` : '',
        beat.action ? `动作：${beat.action}` : '',
        dialogue ? `对白：\n${dialogue}` : '',
      ].filter(Boolean).join('\n')
    }).join('\n\n')

    return [`# Episode ${episode.episode_number}: ${episode.title}`, episode.content, beats]
      .filter(Boolean)
      .join('\n\n')
  }).join('\n\n')
}

function buildLocalEpisodesFromPrompt(inspiration: string): Episode[] {
  const cleaned = inspiration.trim() || 'Generate a creative story'
  const title = extractScriptTitle(cleaned)
  const timedBeats = parseTimedBeats(cleaned)
  const beats = timedBeats.length > 0
    ? timedBeats.map((beat, index) => ({
      number: index + 1,
      duration_seconds: Math.max(1, beat.end - beat.start),
      narration: beat.text,
      action: beat.text,
      dialogues: extractDialogue(beat.text),
    }))
    : [{
      number: 1,
      duration_seconds: 15,
      narration: cleaned,
      action: cleaned,
      dialogues: extractDialogue(cleaned),
    }]

  return [{
    episode_number: 1,
    title,
    content: cleaned,
    beats,
  }]
}

function extractScriptTitle(text: string): string {
  const bracketTitle = text.match(/【([^】]+)】/)
  if (bracketTitle?.[1]) return bracketTitle[1].trim()

  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? 'AI 视频剧本草稿'
  return firstLine
    .replace(/^(generate script|生成剧本|写剧本|create script)\s*[:：]?\s*/i, '')
    .replace(/[（(].*?[）)]/g, '')
    .trim()
    .slice(0, 40) || 'AI 视频剧本草稿'
}

function parseTimedBeats(text: string): Array<{ start: number; end: number; text: string }> {
  const timedBeatPattern = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*秒\s*[：:]\s*([\s\S]*?)(?=\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*秒\s*[：:]|$)/g
  const matches = Array.from(text.matchAll(timedBeatPattern))
  return matches.map((match) => ({
    start: Number(match[1]),
    end: Number(match[2]),
    text: match[3].trim(),
  })).filter((beat) => Number.isFinite(beat.start) && Number.isFinite(beat.end) && beat.end > beat.start && beat.text.length > 0)
}

function extractDialogue(text: string) {
  const quoted = Array.from(text.matchAll(/[“"]([^”"]+)[”"]/g)).map((match) => match[1].trim())
  return quoted.map((line) => ({ speaker: '旁白/字幕', text: line }))
}

function getBeatLabel(number: number, description: string): string {
  if (/入学邀请卡|邀请卡/.test(description) && /门缝|关着的门|正对/.test(description)) return '0-3秒 入学邀请卡'
  if (/升级|像素风|2D|3D|推开门/.test(description)) return '3-8秒 角色升级开门'
  if (/欢迎|相视一笑|看向镜头|无限进化/.test(description)) return '12-15秒 社区欢迎钩子'
  if (/AIGC|代码|发光/.test(description)) return '8-12秒 AIGC邀请卡特写'
  return `Beat ${number}: ${description.slice(0, 18)}`
}
