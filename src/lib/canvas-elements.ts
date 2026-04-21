import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { runCapability } from '@/lib/capabilities/client'
import { fillPrompt } from '@/lib/prompts'

export type ElementRole = 'character' | 'prop' | 'scene' | 'keyframe' | 'unknown'

export interface ClassifiedElement {
  nodeId: string
  itemId: string
  name: string
  imageUrl: string
  role: ElementRole
  description: string
}

export interface ElementInventory {
  characters: ClassifiedElement[]
  props: ClassifiedElement[]
  scenes: ClassifiedElement[]
  keyframes: ClassifiedElement[]
  unknown: ClassifiedElement[]
}

export interface ExtractedCharacter {
  name: string
  gender: string
  appearance: string
  clothing: string
  expression: string
  image_prompt: string
}

export interface ExtractedScene {
  name: string
  location: string
  lighting: string
  mood: string
  image_prompt: string
}

export interface ExtractedProp {
  name: string
  description: string
  image_prompt: string
}

export interface ExtractionResult {
  characters: ExtractedCharacter[]
  scenes: ExtractedScene[]
  props: ExtractedProp[]
}

/** Collect all image nodes from the canvas. */
function getImageNodes(): { nodeId: string; itemId: string; name: string; imageUrl: string }[] {
  const nodes = useCanvasStore.getState().nodes
  const items = useCanvasItemStore.getState().items
  const result: { nodeId: string; itemId: string; name: string; imageUrl: string }[] = []
  for (const n of nodes) {
    if (!n.data.itemId) continue
    const it = items[n.data.itemId]
    if (!it || it.kind !== 'image' || !it.content) continue
    if (/\.(mp4|webm|mov)(\?|$)/i.test(it.content)) continue
    result.push({ nodeId: n.id, itemId: it.id, name: it.name, imageUrl: it.content })
  }
  return result
}

/** Use AI to classify image nodes into roles. */
export async function classifyCanvasElements(): Promise<ElementInventory> {
  const imageNodes = getImageNodes()
  if (imageNodes.length === 0) {
    return { characters: [], props: [], scenes: [], keyframes: [], unknown: [] }
  }

  const nodeList = imageNodes.map((n, i) =>
    `${i + 1}. id="${n.nodeId.slice(0, 8)}" name="${n.name}"`
  ).join('\n')

  const result = await runCapability({
    capability: 'element-extraction',
    inputs: [{ kind: 'text', text:
      `以下是画布上的图片节点列表。请根据节点名称分类每个节点的角色类型。
输出 JSON 数组：[{ "id": "节点id前8位", "role": "character|prop|scene|keyframe|unknown", "description": "简短描述" }]
只输出 JSON。

节点列表：
${nodeList}` }],
  })

  const text = result.outputs[0]?.text ?? ''
  let classifications: { id: string; role: ElementRole; description: string }[] = []
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) classifications = JSON.parse(jsonMatch[0])
  } catch { /* all stay unknown */ }

  const inventory: ElementInventory = { characters: [], props: [], scenes: [], keyframes: [], unknown: [] }

  for (const node of imageNodes) {
    const shortId = node.nodeId.slice(0, 8)
    const cls = classifications.find((c) => shortId.startsWith(c.id) || c.id.startsWith(shortId.slice(0, 6)))
    const role: ElementRole = cls?.role ?? guessRoleFromName(node.name)
    const el: ClassifiedElement = {
      nodeId: node.nodeId, itemId: node.itemId, name: node.name,
      imageUrl: node.imageUrl, role, description: cls?.description ?? node.name,
    }
    const bucket = inventory[role === 'beat-video' ? 'unknown' : role] ?? inventory.unknown
    bucket.push(el)
  }
  return inventory
}

function guessRoleFromName(name: string): ElementRole {
  const n = name.toLowerCase()
  if (/角色|character|人物|主角|配角|英雄|导师|反派|盟友/i.test(n)) return 'character'
  if (/道具|prop|物品|武器|工具/i.test(n)) return 'prop'
  if (/场景|scene|背景|环境|地点|森林|城市/i.test(n)) return 'scene'
  if (/keyframe|kf-|分镜|关键帧/i.test(n)) return 'keyframe'
  return 'unknown'
}

// ─── Extraction from script ─────────────────────────────────────────

async function aiCall(prompt: string): Promise<string> {
  const r = await runCapability({
    capability: 'element-extraction',
    inputs: [{ kind: 'text', text: prompt }],
  })
  return r.outputs[0]?.text ?? ''
}

function parseJsonArray<T>(text: string): T[] {
  try {
    const m = text.match(/\[[\s\S]*\]/)
    if (m) return JSON.parse(m[0])
  } catch { /* ignore */ }
  return []
}

/**
 * Extract characters, scenes, props from script using dedicated AI prompts.
 * Returns structured data with image generation prompts.
 */
export async function extractElementsFromScript(
  scriptAnalysis: string,
  artStyle: string,
): Promise<ExtractionResult> {
  // Extract characters
  const charText = await aiCall(fillPrompt('characterExtraction', { scriptAnalysis, artStyle }))
  const characters = parseJsonArray<ExtractedCharacter>(charText)

  // Extract scenes
  const sceneText = await aiCall(fillPrompt('sceneExtraction', { scriptAnalysis, artStyle }))
  const scenes = parseJsonArray<ExtractedScene>(sceneText)

  // Extract props
  const propText = await aiCall(fillPrompt('propExtraction', { scriptAnalysis, artStyle }))
  const props = parseJsonArray<ExtractedProp>(propText)

  return { characters, scenes, props }
}

// ─── Ensure elements with proper prompts ────────────────────────────

export interface EnsureElementsOptions {
  scriptText?: string
  stylePreset?: string
  customStyle?: string
  /** Pre-extracted elements (from director pipeline). If provided, skips AI extraction. */
  extraction?: ExtractionResult
}

const STYLE_MAP: Record<string, string> = {
  cinematic: 'cinematic film style, dramatic lighting',
  anime: 'anime style, cel-shaded, vibrant colors, Japanese animation',
  realistic: 'photorealistic, detailed, 8k photograph',
  watercolor: 'watercolor painting style, soft edges',
  'pixel-art': '8-bit pixel art, retro game style',
  '3d-render': '3D CGI render, Pixar quality',
  comic: 'comic book illustration, ink and color',
  'oil-painting': 'oil painting, impressionist brushstrokes',
  gothic: 'gothic dark art, dramatic shadows',
  cyberpunk: 'cyberpunk neon aesthetic, futuristic',
}

function getArtStyle(opts?: EnsureElementsOptions): string {
  if (opts?.customStyle) return opts.customStyle
  if (opts?.stylePreset) return STYLE_MAP[opts.stylePreset] ?? opts.stylePreset
  return 'cinematic'
}

export async function ensureElements(
  onStatus: (msg: string) => void,
  opts?: EnsureElementsOptions,
): Promise<ElementInventory> {
  onStatus('正在分析画布元素…')
  const inventory = await classifyCanvasElements()

  const missing: string[] = []
  if (inventory.characters.length === 0) missing.push('角色')
  if (inventory.scenes.length === 0) missing.push('场景')

  if (missing.length === 0) {
    onStatus(`画布元素齐全：${inventory.characters.length} 角色, ${inventory.props.length} 道具, ${inventory.scenes.length} 场景`)
    return inventory
  }

  onStatus(`缺少 ${missing.join('、')}，正在从剧本提取并生成…`)
  const artStyle = getArtStyle(opts)

  // Get extraction (from director pipeline or do it now)
  let extraction = opts?.extraction
  if (!extraction && opts?.scriptText) {
    onStatus('正在从剧本提取角色和场景…')
    // Quick script analysis first
    const scriptAnalysis = await aiCall(
      `简要分析这个剧本的角色和场景：\n${opts.scriptText.slice(0, 1000)}\n\n列出所有角色（姓名、性别、外貌）和场景（地点、氛围）。`
    )
    extraction = await extractElementsFromScript(scriptAnalysis, artStyle)
    onStatus(`提取完成：${extraction.characters.length} 角色, ${extraction.scenes.length} 场景, ${extraction.props.length} 道具`)
  }

  // Generate missing characters
  if (inventory.characters.length === 0 && extraction?.characters?.length) {
    for (const char of extraction.characters.slice(0, 2)) { // max 2 characters
      onStatus(`正在生成角色: ${char.name}…`)
      try {
        const basePrompt = char.image_prompt || fillPrompt('characterImageGen', {
          characterDescription: `${char.name}, ${char.gender}, ${char.appearance}, wearing ${char.clothing}, ${char.expression}`,
          artStyle,
        })
        // Always ensure artStyle is in the prompt (AI-generated image_prompt may omit it)
        const prompt = char.image_prompt ? `${basePrompt}. ${artStyle}` : basePrompt
        console.log('[ensureElements] Character prompt:', prompt)
        const r = await runCapability({
          capability: 'text-to-image',
          inputs: [{ kind: 'text', text: prompt }],
          params: { aspect: '1:1' },
        })
        if (r.outputs[0]?.url) {
          const itemId = useCanvasItemStore.getState().addItem({
            kind: 'image', name: char.name, content: r.outputs[0].url, prompt,
          })
          const nodeId = useCanvasStore.getState().addItemNode(
            itemId, 'image', { x: 50, y: 50 + inventory.characters.length * 220 }, { width: 200, height: 200 },
          )
          inventory.characters.push({
            nodeId, itemId, name: char.name,
            imageUrl: r.outputs[0].url, role: 'character',
            description: `${char.appearance}, ${char.clothing}`,
          })
        }
      } catch (e) {
        onStatus(`角色 ${char.name} 生成失败: ${(e as Error).message}`)
      }
    }
  }

  // Generate missing scenes
  if (inventory.scenes.length === 0 && extraction?.scenes?.length) {
    for (const scene of extraction.scenes.slice(0, 2)) { // max 2 scenes
      onStatus(`正在生成场景: ${scene.name}…`)
      try {
        const basePrompt = scene.image_prompt || fillPrompt('sceneImageGen', {
          sceneDescription: `${scene.name}, ${scene.location}, ${scene.lighting}, ${scene.mood}`,
          artStyle,
        })
        // Always ensure artStyle is in the prompt (AI-generated image_prompt may omit it)
        const prompt = scene.image_prompt ? `${basePrompt}. ${artStyle}` : basePrompt
        console.log('[ensureElements] Scene prompt:', prompt)
        const r = await runCapability({
          capability: 'text-to-image',
          inputs: [{ kind: 'text', text: prompt }],
          params: { aspect: '16:9' },
        })
        if (r.outputs[0]?.url) {
          const itemId = useCanvasItemStore.getState().addItem({
            kind: 'image', name: scene.name, content: r.outputs[0].url, prompt,
          })
          const nodeId = useCanvasStore.getState().addItemNode(
            itemId, 'image', { x: 50, y: 500 + inventory.scenes.length * 220 }, { width: 320, height: 180 },
          )
          inventory.scenes.push({
            nodeId, itemId, name: scene.name,
            imageUrl: r.outputs[0].url, role: 'scene',
            description: `${scene.location}, ${scene.mood}`,
          })
        }
      } catch (e) {
        onStatus(`场景 ${scene.name} 生成失败: ${(e as Error).message}`)
      }
    }
  }

  onStatus(`元素准备完成：${inventory.characters.length} 角色, ${inventory.props.length} 道具, ${inventory.scenes.length} 场景`)
  return inventory
}

/** Build element context string for the storyboard generation prompt. */
export function buildElementContext(inv: ElementInventory): string {
  const lines: string[] = []
  if (inv.characters.length > 0) {
    lines.push('## 角色 Characters')
    inv.characters.forEach((c, i) => {
      lines.push(`${i + 1}. "${c.name}" [node:${c.nodeId.slice(0, 6)}] — ${c.description} — image: ${c.imageUrl.slice(0, 100)}`)
    })
  }
  if (inv.props.length > 0) {
    lines.push('## 道具 Props')
    inv.props.forEach((p, i) => {
      lines.push(`${i + 1}. "${p.name}" [node:${p.nodeId.slice(0, 6)}] — ${p.description} — image: ${p.imageUrl.slice(0, 100)}`)
    })
  }
  if (inv.scenes.length > 0) {
    lines.push('## 场景 Scenes')
    inv.scenes.forEach((s, i) => {
      lines.push(`${i + 1}. "${s.name}" [node:${s.nodeId.slice(0, 6)}] — ${s.description} — image: ${s.imageUrl.slice(0, 100)}`)
    })
  }
  return lines.join('\n')
}
