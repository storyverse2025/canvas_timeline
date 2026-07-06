import { z } from 'zod'

/**
 * Each "element slot" (character, prop, scene) is an image + text description pair
 * that references a canvas node for cross-tab sync.
 */
export const EMPTY_ELEMENT_SLOT = { image: '', description: '', nodeId: '' }

export const ElementSlotSchema = z.object({
  image: z.string().default(''),
  description: z.string().default(''),
  nodeId: z.string().default(''),
})

const NullableElementSlotSchema = z.preprocess(
  (value) => (value === null ? { ...EMPTY_ELEMENT_SLOT } : value),
  ElementSlotSchema,
).default({ ...EMPTY_ELEMENT_SLOT })

export type ElementSlot = z.infer<typeof ElementSlotSchema>

export const StoryboardRowSchema = z.object({
  shot_number: z.string().min(1),
  duration: z.number().positive().max(600),
  status: z.enum(['todo', 'in_progress', 'done', 'pending', 'generating', 'completed', 'failed']).default('todo'),
  visual_description: z.string().default(''),
  reference_image: z.string().default(''),
  shot_size: z.string().default(''),
  character_actions: z.string().default(''),
  emotion_mood: z.string().default(''),
  /** Per-shot emotional + atmospheric intent used to steer camera/lens/motion. */
  emotion_atmosphere: z.string().default(''),
  /** Why the visible character acts this way in this shot. */
  character_motivation: z.string().default(''),
  /** Inner conflict / psychological pressure translated from the script beat. */
  character_psychology: z.string().default(''),
  /** Actor-facing performance note: playable behavior, not abstract prose. */
  performance_guidance: z.string().default(''),
  scene_tags: z.string().default(''),
  lighting_atmosphere: z.string().default(''),
  sound_effects: z.string().default(''),
  /** sound-agent 3-track mixing brief: dialogue / SFX / BGM levels + timing
   *  + ducking + row-boundary fades. Free-form text the mixer reads. */
  mixing_brief: z.string().default(''),
  /** Dialogue text */
  dialogue: z.string().default(''),
  /** 相对上一行的衔接设计：场景切换→开头过渡手法 + 结尾 ~1s 留白；
   *  同场景连续→画面构图衔接（机位/视线/调度如何承接上一行收尾画面）。 */
  transition_note: z.string().default(''),
  storyboard_prompts: z.string().default(''),
  motion_prompts: z.string().default(''),
  /** BGM description/tag */
  bgm: z.string().default(''),
  /** Visual anchor: a reference point for visual consistency across shots */
  visual_anchor: z.string().default(''),
  // Element slots.
  // `characters` / `props` are the CANONICAL multi-slot arrays (up to
  // MAX_ROW_CHARACTERS / MAX_ROW_PROPS) — a row can now reference a whole
  // ensemble (e.g. a 5-member K-pop group) instead of just two. The legacy
  // `character1/2` + `prop1/2` pair fields are kept in sync with the first two
  // array entries so un-migrated readers keep working; normalizeRowSlots()
  // reconciles the two representations (and back-fills arrays from the pair
  // fields for storyboards persisted before this change).
  character1: NullableElementSlotSchema,
  character2: NullableElementSlotSchema,
  prop1: NullableElementSlotSchema,
  prop2: NullableElementSlotSchema,
  characters: z.array(ElementSlotSchema).default([]),
  props: z.array(ElementSlotSchema).default([]),
  scene: NullableElementSlotSchema,
})

/** Soft caps: one row references at most this many characters / props. */
export const MAX_ROW_CHARACTERS = 6
export const MAX_ROW_PROPS = 6

export type StoryboardRowInput = z.infer<typeof StoryboardRowSchema>

export interface StoryboardRow extends StoryboardRowInput {
  id: string;
  createdAt: number;
  referenceNodeId?: string;
  /** Canvas node ID for the keyframe image */
  keyframeNodeId?: string;
  keyframeUrl?: string;
  /**
   * Optional second keyframe rendered as a single clean cinematic frame
   * (no panels / no time labels / no grid). When present, cinematographer
   * uses this as the Seedance omni-reference instead of keyframeUrl so the
   * grid sheet's borders + labels don't leak into the generated video. The
   * grid `keyframeUrl` is kept for the storyboard UI's pacing reference.
   */
  keyframeCleanUrl?: string;
  /** Canvas node ID for the clean keyframe image (separate from grid). */
  keyframeCleanNodeId?: string;
  /** Canvas node ID for the beat video */
  beatVideoNodeId?: string;
  beatVideoUrl?: string;
  /**
   * 角色身份版 (character identity sheets), one per character slot. A 16:9
   * model sheet locking the character: full-body anchor + 7 auxiliary views
   * + 3 silhouettes + 3 expressions + 3 detail close-ups + ID block, relit
   * with THIS row's scene lighting and scale-locked against the row's props.
   * Ships to Seedance as the FIRST reference images (角色→场景→分镜→机位).
   */
  identitySheet1Url?: string;
  identitySheet1NodeId?: string;
  identitySheet2Url?: string;
  identitySheet2NodeId?: string;
  /**
   * Per-member identity sheets, index-aligned with `characters[]` (member i →
   * identitySheetUrls[i]). Supports ensembles (a 5-member group gets 5 sheets).
   * identitySheet1/2Url mirror [0]/[1] so legacy readers keep working.
   */
  identitySheetUrls?: string[];
  identitySheetNodeIds?: string[];
  /**
   * Canvas node ID of the text node holding the LLM-derived 黑白手绘故事板
   * prompt (结构模板+参考图+主题 → 提示词). Wired upstream of the storyboard
   * image node so the derivation chain is visible and editable.
   */
  storyboardPromptNodeId?: string;
  /**
   * Marks a row inserted by the storyboard-bridge pipeline as a transition
   * clip between its neighbors. When true, generateBeatVideo extracts the
   * prev row's last frame + the next row's first frame and calls Seedance
   * in first-last-frame mode so the bridge actually transitions instead of
   * playing as an independent shot.
   */
  isTransition?: boolean;
}

/** A slot carries meaning if it has any of description / image / nodeId. */
export function isNonEmptySlot(slot: ElementSlot | null | undefined): boolean {
  if (!slot) return false
  return Boolean((slot.description ?? '').trim() || (slot.image ?? '').trim() || (slot.nodeId ?? '').trim())
}

type SlotBearingRow = {
  character1?: ElementSlot | null
  character2?: ElementSlot | null
  prop1?: ElementSlot | null
  prop2?: ElementSlot | null
  characters?: ElementSlot[] | null
  props?: ElementSlot[] | null
}

/**
 * Canonical character slots for a row. Prefers the `characters[]` array; falls
 * back to the legacy `character1/2` pair for storyboards written before the
 * array existed. Only non-empty slots are returned.
 */
export function rowCharacters(row: SlotBearingRow): ElementSlot[] {
  const arr = (row.characters ?? []).filter(isNonEmptySlot)
  if (arr.length) return arr
  return [row.character1, row.character2].filter(isNonEmptySlot) as ElementSlot[]
}

/** Canonical prop slots for a row (same array-first, pair-fallback rule). */
export function rowProps(row: SlotBearingRow): ElementSlot[] {
  const arr = (row.props ?? []).filter(isNonEmptySlot)
  if (arr.length) return arr
  return [row.prop1, row.prop2].filter(isNonEmptySlot) as ElementSlot[]
}

/**
 * Reconcile the array + legacy-pair representations in place and return the row.
 *
 * - If `characters`/`props` are empty but the legacy pair fields are set
 *   (old storyboard), back-fill the arrays from the pair fields.
 * - Always mirror the first two array entries back onto character1/2 (prop1/2)
 *   so legacy readers see the same first-two slots.
 * - Cap arrays to MAX_ROW_CHARACTERS / MAX_ROW_PROPS.
 */
export function normalizeRowSlots<T extends SlotBearingRow>(row: T): T {
  const emptySlot = (): ElementSlot => ({ ...EMPTY_ELEMENT_SLOT })
  const reconcile = (
    arr: ElementSlot[] | null | undefined,
    a: ElementSlot | null | undefined,
    b: ElementSlot | null | undefined,
    cap: number,
  ): { list: ElementSlot[]; first: ElementSlot; second: ElementSlot } => {
    let list = (arr ?? []).filter(isNonEmptySlot)
    if (!list.length) list = [a, b].filter(isNonEmptySlot) as ElementSlot[]
    list = list.slice(0, cap)
    return { list, first: list[0] ?? emptySlot(), second: list[1] ?? emptySlot() }
  }
  const chars = reconcile(row.characters, row.character1, row.character2, MAX_ROW_CHARACTERS)
  const props = reconcile(row.props, row.prop1, row.prop2, MAX_ROW_PROPS)
  row.characters = chars.list
  row.character1 = chars.first
  row.character2 = chars.second
  row.props = props.list
  row.prop1 = props.first
  row.prop2 = props.second
  return row
}

/**
 * Identity-sheet URLs index-aligned with the row's characters (member i →
 * result[i]; '' when that member has no sheet yet). Prefers the array; falls
 * back to the legacy identitySheet1/2Url pair.
 */
export function rowIdentitySheets(row: {
  identitySheetUrls?: string[] | null
  identitySheet1Url?: string
  identitySheet2Url?: string
}): string[] {
  if (row.identitySheetUrls?.length) return row.identitySheetUrls
  return [row.identitySheet1Url ?? '', row.identitySheet2Url ?? '']
}

/**
 * Build the row patch that stores member `index`'s identity sheet: writes the
 * index-aligned arrays AND mirrors the first two onto identitySheet1/2Url so
 * un-migrated readers (reference-pack fallback, old code) stay consistent.
 */
export function withIdentitySheet(
  row: { identitySheetUrls?: string[]; identitySheetNodeIds?: string[] },
  index: number,
  url: string,
  nodeId: string,
): Record<string, unknown> {
  const urls = [...(row.identitySheetUrls ?? [])]
  const nodeIds = [...(row.identitySheetNodeIds ?? [])]
  while (urls.length <= index) urls.push('')
  while (nodeIds.length <= index) nodeIds.push('')
  urls[index] = url
  nodeIds[index] = nodeId
  const patch: Record<string, unknown> = { identitySheetUrls: urls, identitySheetNodeIds: nodeIds }
  if (index === 0) { patch.identitySheet1Url = url; patch.identitySheet1NodeId = nodeId }
  if (index === 1) { patch.identitySheet2Url = url; patch.identitySheet2NodeId = nodeId }
  return patch
}

export const StoryboardListSchema = z.array(StoryboardRowSchema).min(1)

export interface StoryboardValidationResult {
  ok: boolean;
  rows?: StoryboardRowInput[];
  errors?: string[];
}

export function validateStoryboard(raw: unknown): StoryboardValidationResult {
  const r = StoryboardListSchema.safeParse(raw)
  if (r.success) return { ok: true, rows: r.data }
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }
}
