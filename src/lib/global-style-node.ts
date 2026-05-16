/**
 * Global "art style" canvas node.
 *
 * Surfaces the current art direction (preset + custom style + image model)
 * as a single text node on the canvas, with edges drawn from it to every
 * visual asset / image node so users can see at a glance what style prompt
 * informs the generations downstream.
 *
 * The node is identified by `item.role === 'style'`. Initial content is
 * pulled from `useProjectDB.artDirection`; subsequent calls don't overwrite
 * the user's edits — the node is theirs to refine.
 */

import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useProjectDB } from '@/stores/project-db'

const STYLE_NODE_POS = { x: 20, y: 20 }
const STYLE_NODE_SIZE = { width: 360, height: 260 }

interface StyleGuide {
  goal: string
  consistency_rules: string[]
  [key: string]: string | string[] | StyleGuide | Record<string, string> | undefined
}

interface StylePresetDefinition {
  style_id: string
  label: string
  category: '2d' | '3d' | 'live_action'
  source: string
  global_style_guide: StyleGuide
}

const STYLE_LIBRARY_DEFAULT_ID = 'anime_psych_thriller_motion_comic'

/**
 * Curated runtime mirror of storyverse_skills_v2/style-library/style_presets.json.
 * Keep the shape aligned with that source so this node is a tool-agnostic
 * Production Pack, not another charming hard-coded one-line style string.
 */
const STYLE_LIBRARY_PRESETS: Record<string, StylePresetDefinition> = {
  anime_psych_thriller_motion_comic: {
    style_id: 'anime_psych_thriller_motion_comic',
    label: 'Death Note x Re:Zero x Psycho-Pass',
    category: '2d',
    source: 'existing baseline',
    global_style_guide: {
      goal: 'Psychological thriller motion comic anime style. Fast tempo with sharp 2-second rhythm. Emotional arc per beat: Suspense to Shock to Cold Resolve.',
      consistency_rules: [
        'Character facial features, hairstyles, clothing, and physique are consistent across all cuts.',
        'Camera language stays dynamic and handheld-feeling, not static tripod.',
        'Maintain continuity physics across cuts: fog drift, rain streak direction, light flares, and screen glow.',
        'Use noir composition: negative space, off-center framing, hard rim light, and dramatic eye close-ups.',
        'System moments allow clean in-world UI overlays only when story-critical, with no dialogue subtitles.',
        'No music bed; emotion is carried by SFX and short spoken lines.',
      ],
    },
  },
  liveaction_nolan_filmic: {
    style_id: 'liveaction_nolan_filmic',
    label: 'Christopher Nolan Inspired Hollywood Cinematic',
    category: 'live_action',
    source: 'user requirement',
    global_style_guide: {
      goal: 'Photoreal live-action Hollywood cinematic style inspired by Nolan scale and clarity. Tension is built through grounded realism, practical environments, and high-contrast filmic texture.',
      film_emulation: 'Kodak Vision3 500T color, authentic 16mm film grain, halation, realistic texture',
      lens_characteristics: 'Vintage 16mm lenses, soft edges, chromatic aberration',
      lighting_aesthetic: 'Volumetric skylight, practical tungsten accents, moody realism',
      color_grading_profile: 'Warm interiors, high-contrast skin tones, natural light falloff',
      composition_mandate: 'Rule of Thirds, Over-the-Shoulder, Dirty Framing, avoid symmetry',
      scale_mandate: 'Human scale and proportion must be preserved at all times',
      consistency_rules: [
        'Use photoreal live-action imagery only; no anime, cel-shading, or illustrated textures.',
        'Prioritize practical lighting and motivated sources; keep skin tone natural and physically plausible.',
        'Frame with architectural geometry, strong depth, and clean eyeline continuity.',
        'Use restrained but purposeful camera movement; avoid chaotic over-shake unless story-justified.',
        'Apply filmic color science with deep blacks, controlled highlight rolloff, and subtle grain.',
        'No subtitle text overlays; story-critical UI appears only as in-world objects.',
        'Use cinematic sound design with clear dialogue intelligibility and restrained score usage.',
      ],
    },
  },
  '3d_arcane_painterly_hybrid': {
    style_id: '3d_arcane_painterly_hybrid',
    label: 'Arcane Inspired Painterly 3D Hybrid',
    category: '3d',
    source: 'animation industry canon',
    global_style_guide: {
      goal: 'Painterly hybrid 3D with hand-painted finish, dramatic lighting, and mature character psychology.',
      consistency_rules: [
        'Use painterly texture overlays with consistent brush language.',
        'Keep contrast-driven cinematic lighting for emotional peaks.',
        'Facial animation supports nuanced dramatic acting, not broad caricature.',
        'FX layers remain integrated with painterly compositing style.',
        'Do not drift into pure live-action photorealism.',
      ],
    },
  },
}

function getStylePreset(stylePreset: string): StylePresetDefinition {
  return STYLE_LIBRARY_PRESETS[stylePreset] ?? STYLE_LIBRARY_PRESETS[STYLE_LIBRARY_DEFAULT_ID]
}

function formatGuideValue(key: string, value: StyleGuide[keyof StyleGuide]): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return [`${key}:`, ...value.map((rule) => `- ${rule}`)]
  if (typeof value === 'object') {
    return [
      `${key}:`,
      ...Object.entries(value).flatMap(([nestedKey, nestedValue]) =>
        formatGuideValue(`  ${nestedKey}`, nestedValue as StyleGuide[keyof StyleGuide]),
      ),
    ]
  }
  return [`${key}: ${value}`]
}

export function buildGlobalStyleDefinition(): string {
  const ad = useProjectDB.getState().artDirection
  const preset = getStylePreset(ad.stylePreset)
  const guide = preset.global_style_guide
  const parts: string[] = []

  parts.push('🎨 全局风格 / Global Art Style')
  parts.push(`${preset.label}`)
  parts.push(`style_id: ${preset.style_id}`)
  parts.push(`category: ${preset.category}`)
  parts.push(`source: ${preset.source}`)
  parts.push(`requested_preset: ${ad.stylePreset || '(none)'}`)
  parts.push(`Image model: ${ad.defaultImageModel}`)
  parts.push(`Video model: ${ad.defaultVideoModel}`)
  parts.push(`Aspect: ${ad.defaultAspectRatio}`)
  parts.push('')
  parts.push('Production Pack / global_style_guide:')
  parts.push(...formatGuideValue('goal', guide.goal))
  for (const [key, value] of Object.entries(guide)) {
    if (key === 'goal') continue
    parts.push(...formatGuideValue(key, value as StyleGuide[keyof StyleGuide]))
  }
  if (ad.customStyle) {
    parts.push('')
    parts.push(`Custom override: ${ad.customStyle}`)
  }
  parts.push('')
  parts.push('Usage: pass this style guide into casting, asset, storyboard, keyframe, and video agents; preserve user edits on this node.')
  parts.push('（此节点会自动连接到画布上的所有资产，作为它们的风格参考。可以直接编辑。）')
  return parts.join('\n')
}

/**
 * Find or create the canvas node for the global style. Returns the node id.
 * Only creates content from `artDirection` on first creation; existing nodes
 * keep whatever the user has edited into them.
 */
export function ensureGlobalStyleNode(): string {
  const canvas = useCanvasStore.getState()
  const items = useCanvasItemStore.getState().items
  for (const n of canvas.nodes) {
    const itemId = (n.data as { itemId?: string }).itemId
    if (!itemId) continue
    const it = items[itemId]
    if (it && it.role === 'style') return n.id
  }
  const itemId = useCanvasItemStore.getState().addItem({
    kind: 'text',
    name: '全局风格',
    content: buildGlobalStyleDefinition(),
    role: 'style',
  })
  return useCanvasStore.getState().addItemNode(itemId, 'text', STYLE_NODE_POS, STYLE_NODE_SIZE)
}

/** True iff the node represents something that should be styled by the global text. */
function isStylableTarget(node: { id: string; data: Record<string, unknown> }): boolean {
  const data = node.data as { assetId?: string; itemId?: string }
  if (data.assetId) return true // character / scene / prop / keyframe
  if (data.itemId) {
    const it = useCanvasItemStore.getState().items[data.itemId]
    if (it && it.role === 'style') return false // don't connect style → style
    if (it && it.kind === 'image') return true
  }
  return false
}

/**
 * Ensure the style node exists and that there's an edge from it to every
 * visual asset / image node currently on the canvas. Returns counts so the
 * caller can surface a "linked N nodes" toast.
 */
export function connectStyleToAllAssets(): { styleNodeId: string; linked: number } {
  const styleNodeId = ensureGlobalStyleNode()
  const canvas = useCanvasStore.getState()
  const existing = new Set(
    canvas.edges.filter((e) => e.source === styleNodeId).map((e) => e.target),
  )
  let linked = 0
  for (const n of canvas.nodes) {
    if (n.id === styleNodeId) continue
    if (existing.has(n.id)) continue
    if (!isStylableTarget(n as { id: string; data: Record<string, unknown> })) continue
    canvas.addEdge(styleNodeId, n.id)
    linked++
  }
  return { styleNodeId, linked }
}
