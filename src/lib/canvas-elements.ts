import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { runCapability } from '@/lib/capabilities/client'
import {
  ASSET_TIMEOUT_MS,
  characterImageContext,
  extractElements as artDirectorExtractElements,
  generateOneImage as artDirectorGenerateOneImage,
  propImageContext,
  sceneImageContext,
} from '@/lib/agents/art-director-agent'
import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'
import { styleFragmentFor } from '@/lib/style-library'

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

export const CHARACTER_MATERIAL_SYSTEM_PROMPT = 'Sony Venice camera, Panavision C-series lenses, 24mm focal length, f/1.4 aperture, full-frame capture, clean shadows, cinematic lighting, anamorphic lens, wide angle, ultra-high detail, 8k, Final Fantasy CG game style, refined CG, Unreal Engine 5 render. pure white background. Composition requirement: top 1/3 is a front-face extreme close-up with natural expression; lower 2/3 is divided into three blocks showing the character from neck down to feet only, no head visible, three-view full body reference: front view, side view, back view, hands naturally hanging down.'

export function buildCharacterMaterialPrompt(basePrompt: string, artStyle: string): string {
  return `${basePrompt}. ${artStyle}. ${CHARACTER_MATERIAL_SYSTEM_PROMPT}`
}

export function getArtStyle(opts?: EnsureElementsOptions): string {
  if (opts?.customStyle) return opts.customStyle
  if (opts?.stylePreset) return styleFragmentFor(opts.stylePreset)
  return styleFragmentFor(undefined)
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

  // Generate missing characters + scenes + props — image generation routed
  // through art-director-agent.generateAssetImages, then results are written
  // back to the canvas stores here (the agent stays pure of side effects).
  const needCharacters = inventory.characters.length === 0 && (extraction?.characters?.length ?? 0) > 0
  const needScenes = inventory.scenes.length === 0 && (extraction?.scenes?.length ?? 0) > 0
  const needProps = inventory.props.length === 0 && (extraction?.props?.length ?? 0) > 0

  if (extraction && (needCharacters || needScenes || needProps)) {
    // Wrap AI-generated image_prompts with global-style guidance before
    // sending; the per-asset background tasks forward them as-is.
    //   characters → three-view material system prompt
    //   scenes     → append art style
    //   props      → append art style (the prop-image.md template owns the
    //                turnaround layout; we only ensure the style flows in)
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
      props: extraction.props.map((p) => ({
        ...p,
        image_prompt: p.image_prompt ? `${p.image_prompt}. ${artStyle}` : '',
      })),
    }

    // Generate an image for EVERY extracted character — the earlier
    // CHAR_CAP=2 was dropping 3rd/4th characters silently (user reported:
    // 3 个角色的人物小传和音色都有，但只有 2 个角色的图生成成功). Bumped to
    // 6 to bound runaway scripts but cover ensemble casts. Scenes / props
    // stay at their tighter caps because they're typically fewer + cheaper
    // to add back manually if needed; lift them if a similar drop is
    // reported.
    const CHAR_CAP = needCharacters ? Math.min(preppedExtraction.characters.length, 6) : 0
    const SCENE_CAP = needScenes ? Math.min(preppedExtraction.scenes.length, 4) : 0
    const PROP_CAP = needProps ? Math.min(preppedExtraction.props.length, 5) : 0

    // Pre-create the canvas items + nodes with EMPTY content so the
    // downstream director-assistant pipeline immediately has stable
    // node short-ids for buildElementContext / storyboard slot wiring.
    // The actual image URLs land later in the background, patching the
    // item.content via useCanvasItemStore.updateItem.
    const queued: Array<{
      kind: 'character' | 'scene' | 'prop'
      element: ExtractedCharacter | ExtractedScene | ExtractedProp
      itemId: string
      name: string
    }> = []

    for (let i = 0; i < Math.min(preppedExtraction.characters.length, CHAR_CAP); i++) {
      const ch = preppedExtraction.characters[i]!
      const itemId = useCanvasItemStore.getState().addItem({
        kind: 'image', name: ch.name, content: '', prompt: '',
      })
      const nodeId = useCanvasStore.getState().addItemNode(
        itemId, 'image', { x: 50, y: 50 + inventory.characters.length * 220 }, { width: 200, height: 200 },
      )
      inventory.characters.push({
        nodeId, itemId, name: ch.name,
        imageUrl: '', role: 'character',
        description: `${ch.appearance}, ${ch.clothing}`,
      })
      queued.push({ kind: 'character', element: ch, itemId, name: ch.name })
    }
    for (let i = 0; i < Math.min(preppedExtraction.scenes.length, SCENE_CAP); i++) {
      const sc = preppedExtraction.scenes[i]!
      // role: 'scene' tags the canvas item as a 360° equirectangular
      // panorama so ImageCanvasNode renders it through PanoramaViewer
      // (drag-to-pan) instead of a flat <img>.
      const itemId = useCanvasItemStore.getState().addItem({
        kind: 'image', name: sc.name, content: '', prompt: '', role: 'scene',
      })
      const nodeId = useCanvasStore.getState().addItemNode(
        itemId, 'image', { x: 50, y: 500 + inventory.scenes.length * 220 }, { width: 360, height: 220 },
      )
      inventory.scenes.push({
        nodeId, itemId, name: sc.name,
        imageUrl: '', role: 'scene',
        description: `${sc.location}, ${sc.mood}`,
      })
      queued.push({ kind: 'scene', element: sc, itemId, name: sc.name })
    }
    for (let i = 0; i < Math.min(preppedExtraction.props.length, PROP_CAP); i++) {
      const pr = preppedExtraction.props[i]!
      const itemId = useCanvasItemStore.getState().addItem({
        kind: 'image', name: pr.name, content: '', prompt: '',
      })
      const nodeId = useCanvasStore.getState().addItemNode(
        itemId, 'image', { x: 50, y: 950 + inventory.props.length * 220 }, { width: 200, height: 200 },
      )
      inventory.props.push({
        nodeId, itemId, name: pr.name,
        imageUrl: '', role: 'prop',
        description: pr.description,
      })
      queued.push({ kind: 'prop', element: pr, itemId, name: pr.name })
    }

    onStatus(`已为 ${queued.length} 个素材创建画布节点；图片在后台并行生成中…`)

    // Fire every asset's image generation in parallel. Each settles
    // independently and patches its canvas item content via
    // useCanvasItemStore.updateItem. We do NOT await this — the director
    // pipeline proceeds immediately to allocateShots / composeShots /
    // generateStoryboardTable (those only need node short-ids + textual
    // descriptions, not the rendered image URLs).
    const bgCtx = createMemoryContext({
      llm: createCapabilityLLM(),
      log: (m) => onStatus(m),
    })
    void runAssetImageGenerationInBackground(queued, artStyle, bgCtx, onStatus)
  }

  onStatus(`元素准备完成：${inventory.characters.length} 角色, ${inventory.props.length} 道具, ${inventory.scenes.length} 场景 (图片可能仍在后台生成)`)
  return inventory
}

/**
 * Per-asset image generation, fired in parallel and patched into the
 * canvas item store as each settles. Caller does NOT await this — it's a
 * fire-and-forget background task so the director-assistant pipeline can
 * advance to storyboard generation without being blocked by 4K panorama
 * latency.
 *
 * Failures are non-fatal: the canvas item just stays at empty content,
 * the user can click 上传 / URL to fill it in manually (existing empty-
 * state UI in ImageCanvasNode handles this gracefully).
 */
async function runAssetImageGenerationInBackground(
  queued: Array<{
    kind: 'character' | 'scene' | 'prop'
    element: ExtractedCharacter | ExtractedScene | ExtractedProp
    itemId: string
    name: string
  }>,
  artStyle: string,
  ctx: ReturnType<typeof createMemoryContext>,
  onStatus: (msg: string) => void,
): Promise<void> {
  const tasks = queued.map(async (q) => {
    onStatus(`art-director: → 生成 ${q.kind} ${q.name}…`)
    const imgCtx =
      q.kind === 'character' ? characterImageContext(artStyle)
        : q.kind === 'scene' ? sceneImageContext(artStyle)
        : propImageContext(artStyle)
    const timeoutMs =
      q.kind === 'scene' ? ASSET_TIMEOUT_MS.scene
        : q.kind === 'character' ? ASSET_TIMEOUT_MS.character
        : ASSET_TIMEOUT_MS.prop
    try {
      const { url, prompt } = await artDirectorGenerateOneImage(q.element, imgCtx, ctx, timeoutMs)
      if (url) {
        useCanvasItemStore.getState().updateItem(q.itemId, { content: url, prompt })
        onStatus(`art-director: ✓ ${q.kind} ${q.name} 完成`)
      } else {
        onStatus(`art-director: ✗ ${q.kind} ${q.name} 失败 — provider 返回空 URL`)
      }
    } catch (e) {
      onStatus(`art-director: ✗ ${q.kind} ${q.name} 失败 — ${(e as Error).message}`)
    }
  })
  await Promise.allSettled(tasks)
  onStatus(`art-director: 所有后台图片生成结束`)
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
