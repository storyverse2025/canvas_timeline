import { streamClaude } from './claude-client'
import { generateImage, generateVideo, generateSfx } from './fal-client'
import { api } from './api-client'
import { isBackendAvailable, ensureAuth } from './api'
import {
  episodeToBeats,
  characterToNodeData,
  keyframeToNodeData,
  videoShotToNodeData,
  sceneToNodeData,
  propToNodeData,
  resolveStaticUrl,
} from './backend-mapper'
import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useChatStore } from '@/stores/chat-store'
import { useProjectStore } from '@/stores/project-store'
import type { ScriptNodeData, VisualAssetNodeData, AudioBlockNodeData } from '@/types/canvas'

// ─── Shared Pipeline Context ───

interface Beat {
  number: number
  title: string
  narration: string
  dialogues: { speaker: string; text: string }[]
}

interface AssetInfo {
  name: string
  role?: string
  visualPrompt: string
  nodeId: string
  imageUrl?: string
  beats?: number[]
}

interface KeyframeInfo {
  beatNumber: number
  prompt: string
  nodeId: string
  imageUrl?: string
}

interface PipelineContext {
  concept: string
  beats: Beat[]
  shotIds: string[]
  characters: AssetInfo[]
  scenes: AssetInfo[]
  props: AssetInfo[]
  keyframes: KeyframeInfo[]
}

const CTX_STORAGE_KEY = 'pipeline-context'
const PROJECT_ID = 'test'
const EPISODE_INDEX = 1

let ctx: PipelineContext | null = null

try {
  const stored = localStorage.getItem(CTX_STORAGE_KEY)
  if (stored) ctx = JSON.parse(stored)
} catch { /* ignore */ }

function persistCtx() {
  if (ctx) {
    localStorage.setItem(CTX_STORAGE_KEY, JSON.stringify(ctx))
  } else {
    localStorage.removeItem(CTX_STORAGE_KEY)
  }
}

function log(msg: string) {
  useChatStore.getState().addMessage('system', msg)
}

// ─── Shared system prompt rules for JSON output ───

const JSON_SYSTEM_RULES = `## Output Format
Return your response as a single raw JSON object. Do not wrap in markdown code fences.
Do not add any text before or after the JSON. Use straight double quotes for all strings.
No trailing commas. No smart/unicode quotes. Keep string values on single lines.
Escape quotes inside strings with backslash.`

// ─── Chat-visible Claude call ───

async function chatClaude(
  userPrompt: string,
  options: { system: string; maxTokens?: number }
): Promise<string> {
  const chat = useChatStore.getState()
  chat.addMessage('user', userPrompt)
  const assistantId = chat.addMessage('assistant', '')
  let fullText = ''
  let fullThinking = ''

  for await (const event of streamClaude(
    [{ role: 'user', content: userPrompt }],
    { system: options.system, maxTokens: 16000, enableThinking: true, budgetTokens: 5000 }
  )) {
    switch (event.type) {
      case 'thinking':
        fullThinking += event.text
        chat.updateMessage(assistantId, { thinking: fullThinking })
        break
      case 'text':
        fullText += event.text
        chat.updateMessage(assistantId, { content: fullText })
        break
      case 'error':
        chat.updateMessage(assistantId, { content: fullText || `Error: ${event.text}` })
        throw new Error(event.text)
      case 'done':
        break
    }
  }

  if (!fullText) throw new Error('Empty response from Claude')
  return fullText
}

// ─── JSON helpers ───

export function extractJson(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  let raw = codeBlock ? codeBlock[1].trim() : null
  if (!raw) {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) raw = jsonMatch[0]
  }
  if (!raw) throw new Error('No JSON found in response')

  raw = raw.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
  raw = raw.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
  raw = raw.replace(/,\s*([\]}])/g, '$1')
  raw = raw.replace(/"([^"]*?)"/g, (_match, content: string) => {
    return '"' + content.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
  })

  return raw
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeJsonParse(text: string): any {
  const raw = extractJson(text)
  try {
    return JSON.parse(raw)
  } catch (e) {
    log(`JSON parse error. First 200 chars: ${raw.slice(0, 200)}...`)
    throw new Error(`JSON parse failed: ${e instanceof Error ? e.message : 'unknown'}`)
  }
}

// ─── Backend availability helper ───

async function tryBackend(): Promise<boolean> {
  const available = await isBackendAvailable()
  if (available) await ensureAuth()
  return available
}

// ─── Public API ───

export function initPipeline(concept: string) {
  ctx = {
    concept,
    beats: [],
    shotIds: [],
    characters: [],
    scenes: [],
    props: [],
    keyframes: [],
  }
}

export function getPipelineContext(): PipelineContext | null {
  return ctx
}

export function clearPipeline() {
  ctx = null
  persistCtx()
  useCanvasStore.getState().clearAll()
  useTimelineStore.getState().setShots([])
  useMappingStore.getState().clearLinks()
}

// ─── Step 1: Generate Script ───

export async function generateStep1_Script(): Promise<{ beatCount: number; nodeCount: number }> {
  if (!ctx) throw new Error('Pipeline not initialized. Set a concept first.')

  log(`Step 1: Generating script for "${ctx.concept}"...`)

  // Try backend first
  const backendUp = await tryBackend()
  if (backendUp) {
    try {
      log('Step 1: Calling backend API...')
      const result = await api.scripts.generate(PROJECT_ID, { inspiration: ctx.concept })
      const episodes = result.episodes
      if (episodes && episodes.length > 0) {
        useProjectStore.getState().setEpisodes(episodes)
        const beats = episodeToBeats(episodes[0])
        log(`Step 1: Backend returned ${beats.length} beats`)
        return createScriptNodes(beats)
      }
    } catch (err) {
      log(`Step 1: Backend error (${err instanceof Error ? err.message : 'unknown'}), using local AI fallback...`)
    }
  }

  // Fallback: Claude
  const systemPrompt = `You are a professional screenwriter.\n\n${JSON_SYSTEM_RULES}\n\n## Schema\n{"title": "string", "beats": [{"number": 1, "title": "string", "narration": "string", "dialogues": [{"speaker": "string", "text": "string"}]}]}`

  const userPrompt = `Write a 10-beat animated short film script for: "${ctx.concept}". Each beat = 12 seconds. 10 beats total, narration under 80 chars, 0-3 dialogues under 60 chars. Write in Chinese if concept is Chinese.`

  const response = await chatClaude(userPrompt, { system: systemPrompt, maxTokens: 4000 })
  const parsed = safeJsonParse(response)
  return createScriptNodes(parsed.beats)
}

function createScriptNodes(beats: Beat[]): { beatCount: number; nodeCount: number } {
  if (!ctx) throw new Error('Pipeline not initialized')
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()

  ctx.beats = beats
  ctx.shotIds = []
  let nodeCount = 0

  for (const beat of beats) {
    const shotId = timeline.addShot(`Beat ${beat.number}: ${beat.title}`, 12)
    ctx.shotIds.push(shotId)

    const yBase = (beat.number - 1) * 200

    if (beat.narration) {
      const nid = canvas.addNode('script', {
        scriptType: 'narration',
        content: beat.narration,
        beatNumber: beat.number,
        tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beat.number}` }],
      } as ScriptNodeData, { x: 0, y: yBase })
      nodeCount++
      timeline.linkNodeToShot(shotId, nid)
      mapping.addLinkToShot(nid, shotId)
    }

    for (let i = 0; i < beat.dialogues.length; i++) {
      const dlg = beat.dialogues[i]
      const did = canvas.addNode('script', {
        scriptType: 'dialogue',
        content: dlg.text,
        characterName: dlg.speaker,
        beatNumber: beat.number,
        tags: [
          { id: `t-${Date.now()}-${Math.random()}`, category: 'character', label: dlg.speaker },
          { id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beat.number}` },
        ],
      } as ScriptNodeData, { x: 300 + i * 280, y: yBase })
      nodeCount++
      timeline.linkNodeToShot(shotId, did)
      mapping.addLinkToShot(did, shotId)
    }
  }

  persistCtx()
  log(`Step 1 done: ${beats.length} beats, ${nodeCount} script nodes, ${ctx.shotIds.length} timeline shots`)
  return { beatCount: beats.length, nodeCount }
}

// ─── Step 2: Generate Visual Assets (Characters, Scenes, Props) ───

export async function generateStep2_Assets(): Promise<{ nodeCount: number; imageCount: number }> {
  if (!ctx || ctx.beats.length === 0) throw new Error('Run Step 1 first')

  log('Step 2: Generating visual assets...')

  const backendUp = await tryBackend()
  if (backendUp) {
    try {
      log('Step 2: Calling backend API...')
      const projectStore = useProjectStore.getState()
      const episodes = projectStore.episodes.length > 0 ? projectStore.episodes : undefined

      // Characters
      if (episodes) {
        const charResult = await api.characters.generate(PROJECT_ID, { episodes, language: 'zh' })
        if (charResult.characters) {
          projectStore.setCharacters(charResult.characters)
          log(`Step 2: Backend returned ${charResult.characters.length} characters`)
        }
      }

      // Scenes & Props
      const [scenesResult, propsResult] = await Promise.all([
        api.scenes.list(PROJECT_ID),
        api.props.list(PROJECT_ID),
      ])
      if (scenesResult.scenes) projectStore.setScenes(scenesResult.scenes)
      if (propsResult.props) projectStore.setProps(propsResult.props)

      log(`Step 2: Backend returned ${scenesResult.scenes?.length || 0} scenes, ${propsResult.props?.length || 0} props`)

      return createAssetNodesFromBackend()
    } catch (err) {
      log(`Step 2: Backend error (${err instanceof Error ? err.message : 'unknown'}), using local AI fallback...`)
    }
  }

  // Fallback: Claude + FAL
  return generateAssetsWithClaude()
}

function createAssetNodesFromBackend(): { nodeCount: number; imageCount: number } {
  if (!ctx) throw new Error('Pipeline not initialized')
  const projectStore = useProjectStore.getState()
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()
  let nodeCount = 0
  let imageCount = 0

  const linkToShots = (nodeId: string, beatNums: number[]) => {
    if (!ctx) return
    for (const bn of beatNums) {
      const shotId = ctx.shotIds[bn - 1]
      if (shotId) {
        timeline.linkNodeToShot(shotId, nodeId)
        mapping.addLinkToShot(nodeId, shotId)
      }
    }
  }

  // Characters
  for (let i = 0; i < projectStore.characters.length; i++) {
    const char = projectStore.characters[i]
    const nodeData = characterToNodeData(char)
    const nodeId = canvas.addNode('visual', nodeData, { x: 700, y: i * 250 })
    nodeCount++
    if (nodeData.imageUrl) imageCount++
    const info: AssetInfo = { name: char.asset_identifier, visualPrompt: char.prompt || '', nodeId, imageUrl: nodeData.imageUrl }
    ctx.characters.push(info)
    // Link to all shots by default (backend doesn't provide per-beat mapping)
    linkToShots(nodeId, ctx.beats.map(b => b.number))
  }

  // Scenes
  for (let i = 0; i < projectStore.scenes.length; i++) {
    const scene = projectStore.scenes[i]
    const nodeData = sceneToNodeData(scene)
    const nodeId = canvas.addNode('visual', nodeData, { x: 1000, y: i * 250 })
    nodeCount++
    if (nodeData.imageUrl) imageCount++
    ctx.scenes.push({ name: scene.name, visualPrompt: scene.prompt || '', nodeId, imageUrl: nodeData.imageUrl })
  }

  // Props
  for (let i = 0; i < projectStore.props.length; i++) {
    const prop = projectStore.props[i]
    const nodeData = propToNodeData(prop)
    const nodeId = canvas.addNode('visual', nodeData, { x: 1300, y: i * 250 })
    nodeCount++
    if (nodeData.imageUrl) imageCount++
    ctx.props.push({ name: prop.name, visualPrompt: prop.prompt || '', nodeId, imageUrl: nodeData.imageUrl })
  }

  persistCtx()
  log(`Step 2 done: ${nodeCount} asset nodes, ${imageCount} with images (from backend)`)
  return { nodeCount, imageCount }
}

async function generateAssetsWithClaude(): Promise<{ nodeCount: number; imageCount: number }> {
  if (!ctx) throw new Error('Pipeline not initialized')
  const scriptSummary = ctx.beats.map(
    (b) => `Beat ${b.number} "${b.title}": ${b.narration}`
  ).join('\n')

  const systemPrompt = `You are an art director.\n\n${JSON_SYSTEM_RULES}\n\n## Schema\n{"characters": [{"name": "string", "role": "string", "beats": [1,2], "visual_prompt": "english description"}], "scenes": [{"name": "string", "beats": [1], "visual_prompt": "english description"}], "props": [{"name": "string", "beats": [3], "visual_prompt": "english description"}]}`

  const userPrompt = `Based on this script, list the visual assets needed.\n\nScript:\n${scriptSummary}\n\n3-5 characters, 3-5 scenes, 2-4 props. visual_prompt must be in English, anime/cinematic style, 30-50 words. Every asset must have a "beats" array listing which beat numbers it appears in.`

  const response = await chatClaude(userPrompt, { system: systemPrompt, maxTokens: 3000 })
  const parsed = safeJsonParse(response)
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()
  let nodeCount = 0
  let imageCount = 0

  const linkToShots = (nodeId: string, beatNums: number[]) => {
    if (!ctx) return
    for (const bn of beatNums) {
      const shotId = ctx.shotIds[bn - 1]
      if (shotId) {
        timeline.linkNodeToShot(shotId, nodeId)
        mapping.addLinkToShot(nodeId, shotId)
      }
    }
  }

  // Characters
  log(`Step 2: Generating ${parsed.characters.length} character images...`)
  for (let i = 0; i < parsed.characters.length; i++) {
    const char = parsed.characters[i]
    const beats: number[] = Array.isArray(char.beats) ? char.beats : []
    const nodeId = canvas.addNode('visual', {
      assetType: 'character',
      label: `${char.name} (${char.role})`,
      prompt: char.visual_prompt,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'character', label: char.name }],
    } as VisualAssetNodeData, { x: 700, y: i * 250 })
    nodeCount++

    const info: AssetInfo = { name: char.name, role: char.role, visualPrompt: char.visual_prompt, nodeId, beats }
    ctx.characters.push(info)
    linkToShots(nodeId, beats)

    try {
      const result = await generateImage(char.visual_prompt)
      canvas.updateNode(nodeId, { imageUrl: result.url })
      info.imageUrl = result.url
      imageCount++
      log(`  Character "${char.name}" image generated (beats: ${beats.join(',')})`)
    } catch (err) {
      log(`  Character "${char.name}" image failed: ${err instanceof Error ? err.message : 'error'}`)
    }
  }

  // Scenes
  log(`Step 2: Generating ${parsed.scenes.length} scene images...`)
  for (let i = 0; i < parsed.scenes.length; i++) {
    const scene = parsed.scenes[i]
    const beats: number[] = Array.isArray(scene.beats) ? scene.beats : []
    const nodeId = canvas.addNode('visual', {
      assetType: 'scene',
      label: scene.name,
      prompt: scene.visual_prompt,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'scene', label: scene.name }],
    } as VisualAssetNodeData, { x: 1000, y: i * 250 })
    nodeCount++

    const info: AssetInfo = { name: scene.name, visualPrompt: scene.visual_prompt, nodeId, beats }
    ctx.scenes.push(info)
    linkToShots(nodeId, beats)

    try {
      const result = await generateImage(scene.visual_prompt)
      canvas.updateNode(nodeId, { imageUrl: result.url })
      info.imageUrl = result.url
      imageCount++
      log(`  Scene "${scene.name}" image generated (beats: ${beats.join(',')})`)
    } catch (err) {
      log(`  Scene "${scene.name}" image failed: ${err instanceof Error ? err.message : 'error'}`)
    }
  }

  // Props
  log(`Step 2: Generating ${parsed.props.length} prop images...`)
  for (let i = 0; i < parsed.props.length; i++) {
    const prop = parsed.props[i]
    const beats: number[] = Array.isArray(prop.beats) ? prop.beats : []
    const nodeId = canvas.addNode('visual', {
      assetType: 'prop',
      label: prop.name,
      prompt: prop.visual_prompt,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'prop', label: prop.name }],
    } as VisualAssetNodeData, { x: 1300, y: i * 250 })
    nodeCount++

    const info: AssetInfo = { name: prop.name, visualPrompt: prop.visual_prompt, nodeId, beats }
    ctx.props.push(info)
    linkToShots(nodeId, beats)

    try {
      const result = await generateImage(prop.visual_prompt)
      canvas.updateNode(nodeId, { imageUrl: result.url })
      info.imageUrl = result.url
      imageCount++
      log(`  Prop "${prop.name}" image generated`)
    } catch (err) {
      log(`  Prop "${prop.name}" image failed: ${err instanceof Error ? err.message : 'error'}`)
    }
  }

  persistCtx()
  log(`Step 2 done: ${nodeCount} asset nodes, ${imageCount} images generated`)
  return { nodeCount, imageCount }
}

// ─── Step 3: Generate Keyframe Images ───

export async function generateStep3_Keyframes(): Promise<{ nodeCount: number; imageCount: number }> {
  if (!ctx || ctx.beats.length === 0) throw new Error('Run Step 1 first')

  log('Step 3: Generating keyframes...')

  const backendUp = await tryBackend()
  if (backendUp) {
    try {
      log('Step 3: Calling backend API...')
      const result = await api.keyframes.list(PROJECT_ID, EPISODE_INDEX)
      if (result.keyframes && result.keyframes.length > 0) {
        useProjectStore.getState().setKeyframes(result.keyframes)
        log(`Step 3: Backend returned ${result.keyframes.length} keyframes`)
        return createKeyframeNodesFromBackend(result.keyframes)
      }
    } catch (err) {
      log(`Step 3: Backend error (${err instanceof Error ? err.message : 'unknown'}), using local AI fallback...`)
    }
  }

  // Fallback: Claude + FAL
  return generateKeyframesWithClaude()
}

function createKeyframeNodesFromBackend(keyframes: import('@/types/backend').Keyframe[]): { nodeCount: number; imageCount: number } {
  if (!ctx) throw new Error('Pipeline not initialized')
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()
  let nodeCount = 0
  let imageCount = 0

  for (const kf of keyframes) {
    const beatIndex = kf.beat_number - 1
    const shotId = ctx.shotIds[beatIndex]
    const nodeData = keyframeToNodeData(kf)
    nodeData.label = `KF ${kf.beat_number}: ${ctx.beats[beatIndex]?.title || ''}`

    const nodeId = canvas.addNode('visual', nodeData, { x: -350, y: beatIndex * 200 })
    nodeCount++
    if (nodeData.imageUrl) imageCount++

    const info: KeyframeInfo = { beatNumber: kf.beat_number, prompt: kf.prompt || '', nodeId, imageUrl: nodeData.imageUrl }

    if (shotId) {
      timeline.linkNodeToShot(shotId, nodeId)
      mapping.addLinkToShot(nodeId, shotId)
    }

    // Edges from keyframe → related assets
    const allAssets = [...(ctx.characters || []), ...(ctx.scenes || []), ...(ctx.props || [])]
    for (const asset of allAssets) {
      if (asset.beats?.includes(kf.beat_number)) {
        canvas.addEdge(asset.nodeId, nodeId)
      }
    }

    ctx.keyframes.push(info)
  }

  persistCtx()
  log(`Step 3 done: ${nodeCount} keyframe nodes, ${imageCount} with images (from backend)`)
  return { nodeCount, imageCount }
}

async function generateKeyframesWithClaude(): Promise<{ nodeCount: number; imageCount: number }> {
  if (!ctx) throw new Error('Pipeline not initialized')
  const scriptSummary = ctx.beats.map(
    (b) => `Beat ${b.number} "${b.title}": ${b.narration}`
  ).join('\n')
  const characterNames = ctx.characters.map((c) => c.name).join(', ')

  const systemPrompt = `You are a storyboard artist.\n\n${JSON_SYSTEM_RULES}\n\n## Schema\n{"keyframes": [{"beat_number": 1, "prompt": "english image prompt, 40-60 words"}]}`

  const userPrompt = `Write one keyframe image prompt per beat.\n\nScript:\n${scriptSummary}\n\nCharacters: ${characterNames || 'as described in script'}\n\n10 keyframes total, one per beat. Each prompt is self-contained with characters, action, environment, mood, camera, lighting. Anime cinematic style.`

  const response = await chatClaude(userPrompt, { system: systemPrompt, maxTokens: 4000 })
  const parsed = safeJsonParse(response)
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()

  let nodeCount = 0
  let imageCount = 0

  for (const kf of parsed.keyframes) {
    const beatIndex = kf.beat_number - 1
    const shotId = ctx.shotIds[beatIndex]

    log(`Step 3: Generating keyframe ${kf.beat_number}/10...`)

    const nodeId = canvas.addNode('visual', {
      assetType: 'keyframe',
      label: `KF ${kf.beat_number}: ${ctx.beats[beatIndex]?.title || ''}`,
      prompt: kf.prompt,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${kf.beat_number}` }],
    } as VisualAssetNodeData, { x: -350, y: beatIndex * 200 })
    nodeCount++

    const info: KeyframeInfo = { beatNumber: kf.beat_number, prompt: kf.prompt, nodeId }

    if (shotId) {
      timeline.linkNodeToShot(shotId, nodeId)
      mapping.addLinkToShot(nodeId, shotId)
    }

    const allAssets = [...(ctx.characters || []), ...(ctx.scenes || []), ...(ctx.props || [])]
    for (const asset of allAssets) {
      if (asset.beats?.includes(kf.beat_number)) {
        canvas.addEdge(asset.nodeId, nodeId)
      }
    }

    try {
      const result = await generateImage(kf.prompt)
      canvas.updateNode(nodeId, { imageUrl: result.url })
      info.imageUrl = result.url
      imageCount++
    } catch (err) {
      log(`  Keyframe ${kf.beat_number} image failed: ${err instanceof Error ? err.message : 'error'}`)
    }

    ctx.keyframes.push(info)
  }

  persistCtx()
  log(`Step 3 done: ${nodeCount} keyframe nodes, ${imageCount} images generated`)
  return { nodeCount, imageCount }
}

// ─── Step 4: Generate Audio (SFX via ElevenLabs + BGM placeholder) ───

export async function generateStep4_Audio(): Promise<{ nodeCount: number; audioCount: number }> {
  if (!ctx || ctx.beats.length === 0) throw new Error('Run Step 1 first')

  log('Step 4: Planning sound effects...')

  // Backend handles audio during the edit pipeline (Step 6).
  // For Step 4, we check if backend is available and create placeholders accordingly.
  const backendUp = await tryBackend()
  if (backendUp) {
    log('Step 4: Backend available — audio will be generated during final edit (Step 6). Creating placeholders...')
    return createAudioPlaceholders()
  }

  // Fallback: Claude + ElevenLabs
  return generateAudioWithClaude()
}

function createAudioPlaceholders(): { nodeCount: number; audioCount: number } {
  if (!ctx) throw new Error('Pipeline not initialized')
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()

  // BGM placeholder
  const bgmId = canvas.addNode('audio', {
    audioType: 'bgm',
    duration: ctx.beats.length * 12,
    label: `BGM - ${ctx.concept.slice(0, 20)}`,
    tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'custom', label: 'BGM' }],
  } as AudioBlockNodeData, { x: -600, y: 0 })
  for (const shotId of ctx.shotIds) {
    timeline.linkNodeToShot(shotId, bgmId)
    mapping.addLinkToShot(bgmId, shotId)
  }

  persistCtx()
  log('Step 4 done: BGM placeholder created (audio will be generated by backend during edit)')
  return { nodeCount: 1, audioCount: 0 }
}

async function generateAudioWithClaude(): Promise<{ nodeCount: number; audioCount: number }> {
  if (!ctx) throw new Error('Pipeline not initialized')
  const scriptSummary = ctx.beats.map(
    (b) => `Beat ${b.number} "${b.title}": ${b.narration}`
  ).join('\n')

  const systemPrompt = `You are a sound designer.\n\n${JSON_SYSTEM_RULES}\n\n## Schema\n{"sfx": [{"beat_number": 1, "label": "short name", "prompt": "english sound description", "duration": 5}]}`

  const userPrompt = `Suggest sound effects for this script.\n\nScript:\n${scriptSummary}\n\n5-8 SFX total, duration 3-10s each. Prompt describes the actual sound (not visual). Label is 2-4 words.`

  const response = await chatClaude(userPrompt, { system: systemPrompt, maxTokens: 2000 })
  const parsed = safeJsonParse(response)
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()

  let nodeCount = 0
  let audioCount = 0

  // BGM placeholder
  const bgmId = canvas.addNode('audio', {
    audioType: 'bgm',
    duration: ctx.beats.length * 12,
    label: `BGM - ${ctx.concept.slice(0, 20)}`,
    tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'custom', label: 'BGM' }],
  } as AudioBlockNodeData, { x: -600, y: 0 })
  nodeCount++
  for (const shotId of ctx.shotIds) {
    timeline.linkNodeToShot(shotId, bgmId)
    mapping.addLinkToShot(bgmId, shotId)
  }
  log('Step 4: BGM placeholder created (linked to all shots)')

  // Generate SFX
  for (let i = 0; i < parsed.sfx.length; i++) {
    const sfx = parsed.sfx[i]
    const beatNum: number = sfx.beat_number || 1
    const nodeId = canvas.addNode('audio', {
      audioType: 'sfx',
      duration: sfx.duration,
      label: `SFX: ${sfx.label}`,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beatNum}` }],
    } as AudioBlockNodeData, { x: -600, y: 180 + i * 140 })
    nodeCount++

    const shotId = ctx.shotIds[beatNum - 1]
    if (shotId) {
      timeline.linkNodeToShot(shotId, nodeId)
      mapping.addLinkToShot(nodeId, shotId)
    }

    try {
      log(`Step 4: Generating SFX "${sfx.label}" (beat ${beatNum})...`)
      const result = await generateSfx(sfx.prompt, sfx.duration)
      canvas.updateNode(nodeId, { audioUrl: result.url, duration: result.duration })
      audioCount++
    } catch (err) {
      log(`  SFX "${sfx.label}" generation failed: ${err instanceof Error ? err.message : 'error'} (node created as placeholder)`)
    }
  }

  persistCtx()
  log(`Step 4 done: ${nodeCount} audio nodes, ${audioCount} SFX generated`)
  return { nodeCount, audioCount }
}

// ─── Step 5: Generate Video Shots (Image-to-Video) ───

export async function generateStep5_VideoShots(): Promise<{ videoCount: number }> {
  if (!ctx || ctx.keyframes.length === 0) throw new Error('Run Step 3 first (need keyframe images)')

  log('Step 5: Generating video shots...')

  const backendUp = await tryBackend()
  if (backendUp) {
    try {
      log('Step 5: Calling backend API...')
      const result = await api.shots.list(PROJECT_ID, EPISODE_INDEX, 'zh')
      const shots = result.shots
      if (shots && shots.length > 0) {
        useProjectStore.getState().setShots(shots)
        log(`Step 5: Backend returned ${shots.length} video shots`)
        return createVideoNodesFromBackend(shots)
      }
    } catch (err) {
      log(`Step 5: Backend error (${err instanceof Error ? err.message : 'unknown'}), using local AI fallback...`)
    }
  }

  // Fallback: FAL MiniMax
  return generateVideosWithFal()
}

function createVideoNodesFromBackend(shots: import('@/types/backend').VideoShot[]): { videoCount: number } {
  if (!ctx) throw new Error('Pipeline not initialized')
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()
  let videoCount = 0

  for (const shot of shots) {
    const beatIndex = shot.beat_number - 1
    const shotId = ctx.shotIds[beatIndex]
    const nodeData = videoShotToNodeData(shot)
    nodeData.label = `Video ${shot.beat_number}: ${ctx.beats[beatIndex]?.title || ''}`

    const nodeId = canvas.addNode('visual', nodeData, { x: -650, y: beatIndex * 200 })

    if (shotId) {
      timeline.linkNodeToShot(shotId, nodeId)
      mapping.addLinkToShot(nodeId, shotId)
      // Also update shot data with video URL
      if (shot.shot_url) {
        const existing = timeline.getShotById(shotId)
        timeline.updateShot(shotId, {
          data: { ...(existing?.data || {}), videoUrl: resolveStaticUrl(shot.shot_url), status: 'completed' },
        })
      }
    }

    if (shot.shot_url) videoCount++
  }

  persistCtx()
  log(`Step 5 done: ${videoCount} videos from backend, ${shots.length} total shot nodes`)
  return { videoCount }
}

async function generateVideosWithFal(): Promise<{ videoCount: number }> {
  if (!ctx) throw new Error('Pipeline not initialized')
  const keyframesWithImages = ctx.keyframes.filter((kf) => kf.imageUrl)
  if (keyframesWithImages.length === 0) throw new Error('No keyframe images available for video generation')

  log(`Step 5: Launching ${keyframesWithImages.length} video generation jobs in background (each takes ~60-120s)...`)
  log('Step 5: You can continue using the app. Videos will appear on the timeline as they complete.')

  const canvas = useCanvasStore.getState()
  const shotIdsCopy = [...ctx.shotIds]

  // Create video canvas nodes first
  for (const kf of keyframesWithImages) {
    const beatIndex = kf.beatNumber - 1
    const shotId = shotIdsCopy[beatIndex]
    if (!shotId || !kf.imageUrl) continue

    const nodeId = canvas.addNode('visual', {
      assetType: 'video',
      imageUrl: kf.imageUrl,
      label: `Video ${kf.beatNumber}: ${ctx.beats[beatIndex]?.title || ''}`,
      prompt: kf.prompt,
      status: 'generating',
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${kf.beatNumber}` }],
    } as VisualAssetNodeData, { x: -650, y: beatIndex * 200 })

    const timelineStore = useTimelineStore.getState()
    const mappingStore = useMappingStore.getState()
    timelineStore.linkNodeToShot(shotId, nodeId)
    mappingStore.addLinkToShot(nodeId, shotId)
  }

  let completed = 0
  let failed = 0
  const total = keyframesWithImages.length

  const jobs = keyframesWithImages.map((kf) => {
    const beatIndex = kf.beatNumber - 1
    const shotId = shotIdsCopy[beatIndex]
    if (!shotId || !kf.imageUrl) return Promise.resolve()

    return generateVideo(
      kf.imageUrl,
      kf.prompt,
      (msg) => log(`  Beat ${kf.beatNumber}: ${msg}`)
    ).then((result) => {
      const timeline = useTimelineStore.getState()
      const existing = timeline.getShotById(shotId)
      timeline.updateShot(shotId, {
        data: { ...(existing?.data || {}), videoUrl: result.url, status: 'completed' },
      })
      // Update video canvas node
      const canvasStore = useCanvasStore.getState()
      const videoNode = canvasStore.nodes.find(n => {
        const d = n.data as Record<string, unknown>
        return d.assetType === 'video' && (d.label as string)?.includes(`Video ${kf.beatNumber}`)
      })
      if (videoNode) {
        canvasStore.updateNode(videoNode.id, { videoUrl: result.url, status: 'completed' } as Partial<VisualAssetNodeData>)
      }
      completed++
      log(`  Beat ${kf.beatNumber} video done! (${completed}/${total} complete)`)
    }).catch((err) => {
      const canvasStore = useCanvasStore.getState()
      const videoNode = canvasStore.nodes.find(n => {
        const d = n.data as Record<string, unknown>
        return d.assetType === 'video' && (d.label as string)?.includes(`Video ${kf.beatNumber}`)
      })
      if (videoNode) {
        canvasStore.updateNode(videoNode.id, { status: 'failed' } as Partial<VisualAssetNodeData>)
      }
      failed++
      log(`  Beat ${kf.beatNumber} video failed: ${err instanceof Error ? err.message : 'error'} (${completed}/${total} complete, ${failed} failed)`)
    })
  })

  await Promise.race(jobs.filter(Boolean))

  Promise.all(jobs).then(() => {
    log(`Step 5 complete: ${completed} videos generated, ${failed} failed out of ${total}`)
  })

  return { videoCount: completed }
}

// ─── Step 6: Final Assembly / Summary ───

export async function generateStep6_FinalEdit(): Promise<void> {
  if (!ctx || ctx.beats.length === 0) throw new Error('Run previous steps first')

  log('Step 6: Final assembly...')

  const backendUp = await tryBackend()
  if (backendUp) {
    try {
      log('Step 6: Calling backend edit/render API...')
      const result = await api.edits.render(PROJECT_ID, EPISODE_INDEX, 'default')
      log(
        `Step 6 done (backend): Edit result id=${result.id}, status=${result.status}\n` +
        `  Video URL: ${result.video_url || 'pending'}\n` +
        `  Job ID: ${result.job_id || 'N/A'}`
      )
      return
    } catch (err) {
      log(`Step 6: Backend error (${err instanceof Error ? err.message : 'unknown'}), using local AI fallback...`)
    }
  }

  // Fallback: Claude subtitle generation
  const scriptText = ctx.beats.map((b) => {
    const lines = [`[Beat ${b.number}: ${b.title}]`, b.narration]
    for (const d of b.dialogues) {
      lines.push(`${d.speaker}: ${d.text}`)
    }
    return lines.join('\n')
  }).join('\n\n')

  const systemPrompt = `You are a video editor.\n\n${JSON_SYSTEM_RULES}\n\n## Schema\n{"subtitles": [{"start": 0.0, "end": 3.0, "text": "string", "speaker": "string"}], "summary": "string"}`

  const userPrompt = `Generate timed subtitles for this script (each beat = 12 seconds).\n\n${scriptText}\n\nCover full ${ctx.beats.length * 12} seconds. Each subtitle 1-4s. Include narration and dialogue.`

  const response = await chatClaude(userPrompt, { system: systemPrompt, maxTokens: 4000 })
  const parsed = safeJsonParse(response)

  const totalDuration = ctx.beats.length * 12
  const videoCount = ctx.keyframes.filter((kf) => kf.imageUrl).length

  log(
    `Step 6 done: Final assembly summary\n` +
    `  Title: ${ctx.concept}\n` +
    `  Duration: ${totalDuration}s (${ctx.beats.length} beats × 12s)\n` +
    `  Characters: ${ctx.characters.length} (${ctx.characters.filter((c) => c.imageUrl).length} with images)\n` +
    `  Scenes: ${ctx.scenes.length} (${ctx.scenes.filter((s) => s.imageUrl).length} with images)\n` +
    `  Keyframes: ${ctx.keyframes.length} (${ctx.keyframes.filter((k) => k.imageUrl).length} with images)\n` +
    `  Video shots: ${videoCount}\n` +
    `  Subtitles: ${parsed.subtitles?.length || 0} entries\n` +
    `  Summary: ${parsed.summary || 'N/A'}`
  )
}
