import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { runCapability } from '@/lib/capabilities/client'
import {
  extractElements as artDirectorExtractElements,
  generateAssetImages as artDirectorGenerateAssetImages,
} from '@/lib/agents/art-director-agent'
import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'

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
    const bucketName = role === 'character' ? 'characters'
      : role === 'prop' ? 'props'
      : role === 'scene' ? 'scenes'
      : role === 'keyframe' ? 'keyframes'
      : 'unknown'
    inventory[bucketName].push(el)
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

/**
 * Extract characters, scenes, props from script using dedicated AI prompts.
 * Returns structured data with image generation prompts.
 *
 * Routed through art-director-agent.extractElements — the agent owns the
 * extraction prompts and Zod-validates each element.
 */
export async function extractElementsFromScript(
  scriptAnalysis: string,
  artStyle: string,
): Promise<ExtractionResult> {
  const ctx = createMemoryContext({ llm: createCapabilityLLM() })
  const result = await runAgentWithChatBridge(
    'art-director-agent',
    artDirectorExtractElements({ scriptAnalysis, artStyle }, ctx),
    { verb: 'extract-elements' },
  )
  // The legacy types are a subset of the agent's schema — Zod-validated fields
  // map 1:1 onto ExtractedCharacter/ExtractedScene/ExtractedProp.
  return {
    characters: result.characters as ExtractedCharacter[],
    scenes: result.scenes as ExtractedScene[],
    props: result.props as ExtractedProp[],
  }
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

export const CHARACTER_MATERIAL_SYSTEM_PROMPT = 'Sony Venice camera, Panavision C-series lenses, 24mm focal length, f/1.4 aperture, full-frame capture, clean shadows, cinematic lighting, anamorphic lens, wide angle, ultra-high detail, 8k, Final Fantasy CG game style, refined CG, Unreal Engine 5 render. pure white background. Composition requirement: top 1/3 is a front-face extreme close-up with natural expression; lower 2/3 is divided into three blocks showing the character from neck down to feet only, no head visible, three-view full body reference: front view, side view, back view, hands naturally hanging down.'

export function buildCharacterMaterialPrompt(basePrompt: string, artStyle: string): string {
  return `${basePrompt}. ${artStyle}. ${CHARACTER_MATERIAL_SYSTEM_PROMPT}`
}

export function getArtStyle(opts?: EnsureElementsOptions): string {
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

  // Generate missing characters + scenes — image generation routed through
  // art-director-agent.generateAssetImages, then results are written back to
  // the canvas stores here (the agent stays pure of side effects).
  const needCharacters = inventory.characters.length === 0 && (extraction?.characters?.length ?? 0) > 0
  const needScenes = inventory.scenes.length === 0 && (extraction?.scenes?.length ?? 0) > 0

  if (extraction && (needCharacters || needScenes)) {
    // Wrap AI-generated character image_prompts with the three-view material
    // system prompt before sending; the agent forwards them as-is.
    const preppedExtraction = {
      ...extraction,
      characters: extraction.characters.map((c) => ({
        ...c,
        image_prompt: c.image_prompt
          ? buildCharacterMaterialPrompt(c.image_prompt, artStyle)
          : '',
      })),
      scenes: extraction.scenes.map((s) => ({
        ...s,
        image_prompt: s.image_prompt ? `${s.image_prompt}. ${artStyle}` : '',
      })),
      // Props are not generated here (legacy behavior); cap to 0 below.
    }

    const agentCtx = createMemoryContext({
      llm: createCapabilityLLM(),
      log: (m) => onStatus(m),
    })
    const generated = await runAgentWithChatBridge(
      'art-director-agent',
      artDirectorGenerateAssetImages({
        artStyle,
        extraction: preppedExtraction,
        maxPerKind: {
          characters: needCharacters ? 2 : 0,
          scenes: needScenes ? 2 : 0,
          props: 0,
        },
      }, agentCtx),
      { verb: 'generate-asset-images' },
    )

    for (const char of generated.characters) {
      if (!char.img_url) continue
      onStatus(`正在生成角色: ${char.name}…`)
      const itemId = useCanvasItemStore.getState().addItem({
        kind: 'image', name: char.name, content: char.img_url, prompt: char.generation_prompt ?? '',
      })
      const nodeId = useCanvasStore.getState().addItemNode(
        itemId, 'image', { x: 50, y: 50 + inventory.characters.length * 220 }, { width: 200, height: 200 },
      )
      inventory.characters.push({
        nodeId, itemId, name: char.name,
        imageUrl: char.img_url, role: 'character',
        description: `${char.appearance}, ${char.clothing}`,
      })
    }

    for (const scene of generated.scenes) {
      if (!scene.img_url) continue
      onStatus(`正在生成场景: ${scene.name}…`)
      const itemId = useCanvasItemStore.getState().addItem({
        kind: 'image', name: scene.name, content: scene.img_url, prompt: scene.generation_prompt ?? '',
      })
      const nodeId = useCanvasStore.getState().addItemNode(
        itemId, 'image', { x: 50, y: 500 + inventory.scenes.length * 220 }, { width: 320, height: 180 },
      )
      inventory.scenes.push({
        nodeId, itemId, name: scene.name,
        imageUrl: scene.img_url, role: 'scene',
        description: `${scene.location}, ${scene.mood}`,
      })
    }
  }

  onStatus(`元素准备完成：${inventory.characters.length} 角色, ${inventory.props.length} 道具, ${inventory.scenes.length} 场景`)
  return inventory
}

/** Build element context string for the storyboard generation prompt. */
export function buildElementContext(inv: ElementInventory): string {
  // Tell the LLM to put the [node:xxxxxx] short id in slot.image rather than
  // a URL — the storyboard parser resolves short ids back to full URLs after
  // validation. This avoids the LLM ever copying a long URL incorrectly.
  const lines: string[] = []
  const fmt = (label: string, e: { name: string; nodeId: string; description: string }) =>
    `- "${e.name}" [node:${e.nodeId.slice(0, 6)}] (${label}) — ${e.description}`
  if (inv.characters.length > 0) {
    lines.push('## 角色 Characters (use [node:xxxxxx] in slot.image)')
    inv.characters.forEach((c) => lines.push(fmt('character', c)))
  }
  if (inv.props.length > 0) {
    lines.push('## 道具 Props (use [node:xxxxxx] in slot.image)')
    inv.props.forEach((p) => lines.push(fmt('prop', p)))
  }
  if (inv.scenes.length > 0) {
    lines.push('## 场景 Scenes (use [node:xxxxxx] in slot.image)')
    inv.scenes.forEach((s) => lines.push(fmt('scene', s)))
  }
  return lines.join('\n')
}
