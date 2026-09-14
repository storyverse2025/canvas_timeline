/**
 * Style library — runtime mirror of
 * /data/repos/storyverse_skills_v2/style-library/style_presets.json.
 *
 * Single source of truth for the StylePresetsGrid (director assistant UI)
 * and the global-style-node (canvas Production Pack). Keep `data.ts` in
 * sync by re-copying the source JSON when storyverse_skills_v2 ships
 * updated style cards.
 *
 * Photoreal-risk hardening: presets that could be misread by Seedance /
 * other video models as a real human actor (live-action + photoreal 3D)
 * get a CG-stylization rider appended at load time. The rider is a
 * canvas_timeline-specific guardrail, not part of the upstream style
 * library, so it's applied here rather than baked into data.ts.
 */

import { STYLE_PRESETS_DATA } from './data'
import { STYLE_LABELS_ZH } from './labels.zh'
import type { StyleCategory, StyleGuide, StylePresetDefinition } from './types'

export type { StyleCategory, StyleGuide, StylePresetDefinition } from './types'

/**
 * Display label for a preset — prefers the canvas_timeline Chinese
 * translation, falls back to the upstream English label. Use this in any
 * user-facing surface (grid, panels, dropdowns); never render the raw
 * `preset.label` directly.
 */
export function styleDisplayLabel(preset: StylePresetDefinition): string {
  return STYLE_LABELS_ZH[preset.style_id] ?? preset.label
}

export const STYLE_LIBRARY_DEFAULT_ID: string = STYLE_PRESETS_DATA.default_style_id

/**
 * IDs whose look could trick a video model's "is this a real recorded
 * actor?" guardrail. Every live-action preset is in here; so are the
 * 3D presets that aim at photoreal humans (Weta perf-cap, Pixar's
 * emotional realism, the Chinese mythic epic's high-fidelity material).
 * Stylized 3D (Spider-Verse, Arcane, DreamWorks, Disney fairytale,
 * Illumination) and all 2D anime presets stay out.
 */
const PHOTOREAL_RISK_IDS: ReadonlySet<string> = new Set([
  'liveaction_nolan_filmic',
  'liveaction_japanese_film_look',
  'liveaction_madmax_kinetic_desert',
  'liveaction_dune_epic_scale',
  'liveaction_matrix_neo_noir',
  'liveaction_crouching_tiger_poetic_wuxia',
  'liveaction_sin_city_high_contrast_noir',
  'liveaction_wong_kar_wai_neon_romance',
  'liveaction_fincher_precision_noir',
  'liveaction_deakins_naturalist_epic',
  'liveaction_michael_mann_urban_night',
  'liveaction_kurosawa_weather_drama',
  'liveaction_park_chan_wook_baroque_tension',
  'liveaction_malick_magic_hour_poetry',
  'liveaction_del_toro_gothic_fable',
  '3d_pixar_emotional_realism',
  '3d_weta_performance_capture_epic',
  '3d_chinese_mythic_epic',
])

/**
 * Rider appended to at-risk presets so downstream image/video models read
 * the look as a stylized CG render and don't flag the output as a real
 * recorded actor. Wording mirrors the privacy-retry copy elsewhere in the
 * pipeline — keep facial detail, drop the photographed-real cue.
 */
export const PHOTOREAL_AVOIDANCE_RIDER = {
  zh: 'AAA 电影级 CG 渲染，虚幻引擎 5 品质（Lumen 全局光照、光线追踪反射、次表面散射皮肤、基于物理的 PBR 材质、微表情与毛发级细节、电影级浅景深与轻微胶片颗粒）。这是高精度渲染的 CG 角色而非实拍真人镜头——保留全部面部与皮肤细节、把真实感与材质质感拉满，仅作为"渲染角色"存在以免被判定为真实拍摄的演员。严禁 2D 动漫 / 卡通 / 赛璐璐平涂 / 廉价塑料感或低精度 3D。',
  en: 'AAA cinematic CG render, Unreal Engine 5 quality (Lumen global illumination, ray-traced reflections, subsurface-scattering skin, physically-based PBR materials, micro-expression and hair-level detail, cinematic shallow depth of field with subtle film grain). A high-fidelity rendered CG character, NOT live-action footage — preserve every facial and skin detail and push realism and material quality to the maximum; it exists only as a rendered character so it is not judged to be a photographed real actor. Strictly NO 2D anime, NO cartoon, NO flat cel shading, NO cheap plastic-looking or low-fidelity 3D.',
}

function applyPhotorealRider(preset: StylePresetDefinition): StylePresetDefinition {
  if (!PHOTOREAL_RISK_IDS.has(preset.style_id)) return preset
  const guide = preset.global_style_guide
  // Goal-line tag (so model reads it immediately) + a fresh consistency rule.
  const goalRider = ` [安全]：${PHOTOREAL_AVOIDANCE_RIDER.zh}`
  return {
    ...preset,
    global_style_guide: {
      ...guide,
      goal: guide.goal.includes('[安全]') ? guide.goal : `${guide.goal}${goalRider}`,
      consistency_rules: [
        ...guide.consistency_rules,
        PHOTOREAL_AVOIDANCE_RIDER.en,
      ],
    },
  }
}

const PRESETS_BY_ID: Record<string, StylePresetDefinition> = Object.fromEntries(
  STYLE_PRESETS_DATA.styles.map((s) => [s.style_id, applyPhotorealRider(s)]),
)

const ALL_PRESETS: StylePresetDefinition[] = Object.values(PRESETS_BY_ID)

export function listStylePresets(): StylePresetDefinition[] {
  return ALL_PRESETS
}

export function listStylePresetsByCategory(category: StyleCategory): StylePresetDefinition[] {
  return ALL_PRESETS.filter((p) => p.category === category)
}

/** Returns the preset for `id`, falling back to the library default if unknown. */
export function getStylePreset(id: string | undefined | null): StylePresetDefinition {
  if (id && PRESETS_BY_ID[id]) return PRESETS_BY_ID[id]
  return PRESETS_BY_ID[STYLE_LIBRARY_DEFAULT_ID]
}

/** True iff `id` is a known library preset (no fallback). */
export function isKnownStylePreset(id: string | undefined | null): boolean {
  return !!(id && PRESETS_BY_ID[id])
}

/** True iff the preset id is one we mark as photoreal-risk and rider-augment. */
export function isPhotorealRiskPreset(id: string | undefined | null): boolean {
  return !!(id && PHOTOREAL_RISK_IDS.has(id))
}

/**
 * Flatten the preset's global_style_guide into a human-readable multi-line
 * block. Used by global-style-node when rendering the canvas Production
 * Pack text and by downstream prompts that want the full guide.
 */
export function formatStyleGuide(preset: StylePresetDefinition): string[] {
  const parts: string[] = []
  const guide = preset.global_style_guide
  parts.push(...renderGuideKey('goal', guide.goal))
  for (const [key, value] of Object.entries(guide)) {
    if (key === 'goal') continue
    parts.push(...renderGuideKey(key, value as StyleGuide[keyof StyleGuide]))
  }
  return parts
}

function renderGuideKey(key: string, value: StyleGuide[keyof StyleGuide]): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return [`${key}:`, ...value.map((rule) => `- ${rule}`)]
  if (typeof value === 'object') {
    return [
      `${key}:`,
      ...Object.entries(value).flatMap(([k, v]) =>
        renderGuideKey(`  ${k}`, v as StyleGuide[keyof StyleGuide]),
      ),
    ]
  }
  return [`${key}: ${value}`]
}

/**
 * Short style fragment for prompt injection. Returns the guide's `goal`
 * line — the densest one-sentence-ish summary of the look — so legacy
 * call sites that want a single style string keep working.
 */
export function styleFragmentFor(id: string | undefined | null): string {
  return getStylePreset(id).global_style_guide.goal
}
