import type { StoryboardRow } from '@/types/storyboard'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useProjectDB } from '@/stores/project-db'
import { formatStyleGuide, getStylePreset, styleDisplayLabel } from '@/lib/style-library'

export type RagReferenceKind = 'art' | 'action' | 'camera'

export interface RagReferenceHit {
  id: string
  prompt: string
  similarity: number
  output_media_url?: string | null
  output_media_type?: string | null
  source_name?: string | null
  source_url?: string | null
}

export type RagReferenceGroups = Record<RagReferenceKind, RagReferenceHit[]>
export type RagSelection = Record<RagReferenceKind, string[]>

export const RAG_REFERENCE_LABELS: Record<RagReferenceKind, string> = {
  art: '美术参考',
  action: '动作参考',
  camera: '镜头参考',
}

export const EMPTY_RAG_SELECTION: RagSelection = { art: [], action: [], camera: [] }

export interface RagQueryInputs {
  globalArtStyle?: string
  row: StoryboardRow
}

function projectGenreToneLine(): string {
  const brief = useProjectDB.getState().script.creativeBrief
  const genre = typeof brief?.genre === 'string' ? brief.genre.trim() : ''
  const tone = typeof brief?.tone === 'string' ? brief.tone.trim() : ''
  if (!genre && !tone) return ''
  return `Project genre/tone: ${genre || '(unspecified)'} / ${tone || '(unspecified)'}`
}

function findEditedStyleNodeContent(): string {
  const items = useCanvasItemStore.getState().items
  for (const node of useCanvasStore.getState().nodes) {
    const itemId = (node.data as { itemId?: string } | undefined)?.itemId
    const item = itemId ? items[itemId] : undefined
    if (item?.role === 'style' && item.content.trim()) return item.content.trim()
  }
  const looseStyleItem = Object.values(items).find((item) => item.role === 'style' && item.content.trim())
  return looseStyleItem?.content.trim() ?? ''
}

export function buildRagGlobalArtStyleContext(): string {
  const editedStyleNode = findEditedStyleNodeContent()
  const genreTone = projectGenreToneLine()
  if (editedStyleNode) return [editedStyleNode, genreTone].filter(Boolean).join('\n\n')

  const db = useProjectDB.getState()
  const ad = db.artDirection
  const preset = getStylePreset(ad.stylePreset)
  const parts: string[] = [
    `Preset label: ${preset.label}`,
    `Display label: ${styleDisplayLabel(preset)}`,
    `style_id: ${preset.style_id}`,
    `category: ${preset.category}`,
    `source: ${preset.source}`,
    'Production Pack / global_style_guide:',
    ...formatStyleGuide(preset),
  ]

  if (ad.customStyle?.trim()) {
    parts.push('', `Custom override: ${ad.customStyle.trim()}`)
  }
  if (genreTone) {
    parts.push('', genreTone)
  }
  return parts.join('\n')
}

export function buildRagQueries(row: StoryboardRow): Record<RagReferenceKind, string> {
  const base = [row.visual_description, row.emotion_mood, row.emotion_atmosphere, row.lighting_atmosphere]
    .filter(Boolean)
    .join('，')
  const art = [base, row.scene?.description, row.visual_anchor]
    .filter(Boolean)
    .join('，')
  const action = [row.visual_description, row.character_actions, row.character_motivation, row.performance_guidance]
    .filter(Boolean)
    .join('，')
  const camera = [row.shot_size, row.storyboard_prompts, row.motion_prompts, row.visual_description]
    .filter(Boolean)
    .join('，')
  return {
    art: art || row.storyboard_prompts || row.visual_description || '',
    action: action || row.visual_description || row.storyboard_prompts || '',
    camera: camera || row.storyboard_prompts || row.visual_description || '',
  }
}

export function buildRagQueryExtractionPrompt({ globalArtStyle, row }: RagQueryInputs): string {
  return `你是视频 prompt RAG 检索查询词提取器。目标：从当前分镜 row 和项目全局设置中，分别提取 3 条高召回、可用于检索视频 prompt 库的 query。不要改写分镜，不要输出解释。

项目全局美术风格（必须用于 art_query；这是 row 以外的 global art style 设置）:
${globalArtStyle?.trim() || '（未设置；仅从 row 里提取可见美术风格）'}

当前 row JSON:
${JSON.stringify(row, null, 2)}

提取规则：
1. art_query：优先提取 global art style + row 的场景/灯光/材质/色彩/媒介/时代/整体视觉风格；不要塞角色动作。
2. action_query：提取角色主要动作、身体动作、互动关系、表情、当前情绪；尽量用可观察动词。
3. camera_query：提取镜头景别、角度、运动、构图、焦段/景深（如有）+ 当前情绪/情绪氛围。
4. 每条 query 用英文关键词/短语为主，可以保留少量中文专名；长度 18-45 words；适合检索 text-to-video prompt examples。

只输出 JSON object，格式：
{"art_query":"...","action_query":"...","camera_query":"..."}`
}

export function parseRagExtractedQueries(text: string, fallback: Record<RagReferenceKind, string>): Record<RagReferenceKind, string> {
  try {
    const raw = text.trim()
    const match = raw.match(/\{[\s\S]*\}/)
    const parsed = JSON.parse(match ? match[0] : raw) as Record<string, unknown>
    return {
      art: typeof parsed.art_query === 'string' && parsed.art_query.trim() ? parsed.art_query.trim() : fallback.art,
      action: typeof parsed.action_query === 'string' && parsed.action_query.trim() ? parsed.action_query.trim() : fallback.action,
      camera: typeof parsed.camera_query === 'string' && parsed.camera_query.trim() ? parsed.camera_query.trim() : fallback.camera,
    }
  } catch {
    return fallback
  }
}

export function toggleRagSelection(selection: RagSelection, kind: RagReferenceKind, id: string, max = 3): RagSelection {
  const current = selection[kind]
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : current.length >= max
      ? current
      : [...current, id]
  return { ...selection, [kind]: next }
}

export function selectedRagHits(groups: RagReferenceGroups, selection: RagSelection): RagReferenceGroups {
  return {
    art: groups.art.filter((h) => selection.art.includes(h.id)),
    action: groups.action.filter((h) => selection.action.includes(h.id)),
    camera: groups.camera.filter((h) => selection.camera.includes(h.id)),
  }
}

function formatHits(label: string, hits: RagReferenceHit[]): string {
  if (hits.length === 0) return `${label}: （未选择）`
  return `${label}:\n` + hits.map((h, i) => {
    const media = h.output_media_url ? `\n  media: ${h.output_media_url}` : ''
    const source = h.source_name ? ` source=${h.source_name}` : ''
    return `${i + 1}. similarity=${Math.round(h.similarity * 100)}%${source}\n  prompt: ${h.prompt}${media}`
  }).join('\n')
}

const EDITABLE_TEXT_COLUMNS = [
  ['visual_description', '画面描述'],
  ['visual_anchor', '视觉锚点'],
  ['shot_size', '景别'],
  ['character_actions', '角色动作'],
  ['emotion_mood', '情绪'],
  ['emotion_atmosphere', '情绪/氛围感'],
  ['character_motivation', '角色动机'],
  ['character_psychology', '心理/潜台词'],
  ['performance_guidance', '表演指导'],
  ['lighting_atmosphere', '光影氛围'],
  ['dialogue', '对白文本'],
  ['transition_note', '前后衔接'],
  ['sound_effects', '音效'],
  ['mixing_brief', '混音说明'],
  ['storyboard_prompts', '分镜提示词'],
  ['motion_prompts', '视频运动提示词'],
  ['bgm', 'BGM'],
] as const satisfies readonly (readonly [keyof StoryboardRow, string])[]

type EditableTextField = typeof EDITABLE_TEXT_COLUMNS[number][0]

const PATCH_FIELD_ALIASES = new Map<string, EditableTextField>(
  EDITABLE_TEXT_COLUMNS.flatMap(([field, label]) => [
    [field, field],
    [label, field],
  ]),
)

const EDITABLE_TEXT_FIELD_CONTRACT = EDITABLE_TEXT_COLUMNS
  .map(([field, label]) => `${field}（${label}）`)
  .join(', ')

function normalizePatchField(key: string): EditableTextField | null {
  return PATCH_FIELD_ALIASES.get(key.trim()) ?? null
}

export function buildRagRowRewritePrompt(row: StoryboardRow, groups: RagReferenceGroups, selection: RagSelection, userFeedback: string): string {
  const picked = selectedRagHits(groups, selection)
  return `你是分镜表编辑助手。请根据用户手动反馈和 RAG 参考，改写当前分镜 row。\n\n当前 row JSON:\n${JSON.stringify(row, null, 2)}\n\n用户反馈:\n${userFeedback.trim() || '请综合所选参考，提升这一镜的美术、动作、镜头表达。'}\n\n所选 RAG 参考（分别只作为参考，不要照抄专名/图片编号）:\n${formatHits('美术参考', picked.art)}\n\n${formatHits('动作参考', picked.action)}\n\n${formatHits('镜头参考', picked.camera)}\n\n输出要求：只输出 JSON object，不要 markdown。理论上所有可编辑文字 column 都可以改；字段只允许包含以下可改字段（括号内为表格中文列名）：${EDITABLE_TEXT_FIELD_CONTRACT}。\nstoryboard_prompts 应综合美术参考 + 镜头参考；motion_prompts 应综合动作参考 + 镜头参考。不要改 shot_number/duration/reference_image/keyframeUrl/beatVideoUrl/keyframeNodeId/beatVideoNodeId/角色道具场景图片字段。`
}

const EDITABLE_TEXT_FIELD_SET = new Set<EditableTextField>(EDITABLE_TEXT_COLUMNS.map(([field]) => field))

export function parseRagRowPatch(text: string): Partial<StoryboardRow> {
  const raw = text.trim()
  const match = raw.match(/\{[\s\S]*\}/)
  const parsed = JSON.parse(match ? match[0] : raw) as Record<string, unknown>
  const patch: Partial<StoryboardRow> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const normalizedKey = normalizePatchField(key)
    if (!normalizedKey) continue
    ;(patch as Record<string, string>)[normalizedKey] = typeof value === 'string' ? value : String(value ?? '')
  }
  return patch
}

function compactDiffValue(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return '（空）'
  return normalized.length > 360 ? `${normalized.slice(0, 357)}...` : normalized
}

export function buildRagRowPatchDiffMessage(row: StoryboardRow, patch: Partial<StoryboardRow>): string {
  const changed = Object.entries(patch)
    .filter(([key]) => EDITABLE_TEXT_FIELD_SET.has(key as EditableTextField))
    .map(([key, value]) => {
      const before = compactDiffValue((row as unknown as Record<string, unknown>)[key])
      const after = compactDiffValue(value)
      return { key, before, after }
    })
    .filter((entry) => entry.before !== entry.after)

  if (changed.length === 0) {
    return `RAG 已检查镜头 ${row.shot_number || row.id}，没有产生文本字段变化。`
  }

  return [
    `RAG 已改写镜头 ${row.shot_number || row.id}，修改前后 diff：`,
    '',
    ...changed.flatMap(({ key, before, after }) => [
      `字段：${key}`,
      `- ${before}`,
      `+ ${after}`,
      '',
    ]),
  ].join('\n').trimEnd()
}
