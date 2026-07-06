import type { ElementSlot, StoryboardRowInput } from '@/types/storyboard'

/**
 * 同场景分镜合并 — deterministic post-pass that merges ADJACENT rows sharing
 * the same scene into one long row, so each Beat Video runs as close to
 * Seedance's 15s ceiling as possible instead of burning a generation per
 * 3-second fragment.
 *
 * The generate-storyboard-table prompt already asks the LLM for 10-15s
 * same-scene rows (commit f26ed9c); this pass is the GUARANTEE for when the
 * model fragments anyway. Pure function — callers apply it between parsing
 * and replaceAll().
 *
 * Merge conditions (a boundary breaks the group when any fails):
 *   1. Adjacent rows resolve to the same non-empty scene identity
 *      (scene.description first-segment, falling back to scene_tags).
 *   2. Accumulated duration + next row's duration ≤ maxSeconds (15 =
 *      Seedance 2.0's hard ceiling).
 *   3. The union of distinct characters fits the 2 character slots, and the
 *      union of distinct props fits the 2 prop slots.
 *
 * Merged-row semantics: durations sum; per-beat action/motion/storyboard
 * text is re-laid out as 分时段 blocks (【0-4.0s】…) so Seedance's ≥8s
 * time-segment requirement is satisfied by construction; dialogue keeps
 * line order; identity-ish fields (scene slot, visual_anchor, scene_tags)
 * come from the first row; transition_note keeps the first row's opening
 * linkage plus the last row's tail 留白 note.
 */

const SEEDANCE_MAX_SECONDS = 15

/** First comma/period-delimited segment, trimmed + lowercased — the same
 *  canonical-name convention used across the storyboard pipeline. */
function canonical(text: string | undefined): string {
  const first = (text ?? '').split(/[，,。\n]/)[0] ?? ''
  return first.replace(/\s*[（(][^)）]*[)）]/g, '').trim().toLowerCase()
}

function sceneIdentity(row: StoryboardRowInput): string {
  return canonical(row.scene?.description) || canonical(row.scene_tags)
}

function slotIdentity(slot: ElementSlot | null | undefined): string {
  return canonical(slot?.description)
}

/** Union of non-empty slots in first-seen order, deduped by identity.
 *  Returns null when the union exceeds `cap` (merge must not drop anyone). */
function unionSlots(
  rows: StoryboardRowInput[],
  keys: Array<'character1' | 'character2'> | Array<'prop1' | 'prop2'>,
  cap: number,
): ElementSlot[] | null {
  const out: ElementSlot[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const key of keys) {
      const slot = row[key]
      const id = slotIdentity(slot)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(slot)
      if (out.length > cap) return null
    }
  }
  return out
}

/** Transition/bridge rows (runtime flag) must never merge — they exist to
 *  interpolate between their neighbors via first-last-frame mode. */
function isTransitionRow(row: StoryboardRowInput): boolean {
  return Boolean((row as { isTransition?: boolean }).isTransition)
}

function canJoin(group: StoryboardRowInput[], next: StoryboardRowInput, maxSeconds: number): boolean {
  if (isTransitionRow(next) || group.some(isTransitionRow)) return false
  const scene = sceneIdentity(group[0]!)
  if (!scene || sceneIdentity(next) !== scene) return false
  const total = group.reduce((s, r) => s + (r.duration || 0), 0) + (next.duration || 0)
  if (total > maxSeconds) return false
  const candidate = [...group, next]
  if (!unionSlots(candidate, ['character1', 'character2'], 2)) return false
  if (!unionSlots(candidate, ['prop1', 'prop2'], 2)) return false
  return true
}

const fmtSec = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** Per-beat text re-laid out as time-segment blocks. Rows with empty text
 *  still advance the clock so the labels always match real timing. */
function timeSegmented(rows: StoryboardRowInput[], pick: (r: StoryboardRowInput) => string): string {
  let clock = 0
  const parts: string[] = []
  for (const row of rows) {
    const start = clock
    clock += row.duration || 0
    const text = pick(row).trim()
    if (text) parts.push(`【${fmtSec(start)}-${fmtSec(clock)}s】${text}`)
  }
  return parts.join('\n')
}

/** Join non-empty values, deduped, with a separator. */
function joinUnique(rows: StoryboardRowInput[], pick: (r: StoryboardRowInput) => string, sep = '；'): string {
  const out: string[] = []
  for (const row of rows) {
    const v = pick(row).trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out.join(sep)
}

/**
 * Merge one adjacent same-scene group into a single row. The FIRST row is
 * the base spread, so when callers pass runtime StoryboardRow objects the
 * merged row keeps the first row's id / keyframe / canvas references.
 * Exported for the table's manual 合并同场景 action.
 */
export function mergeRowGroup<T extends StoryboardRowInput>(group: T[]): T {
  if (group.length === 1) return group[0]!
  const first = group[0]!
  const last = group[group.length - 1]!
  const characters = unionSlots(group, ['character1', 'character2'], 2) ?? []
  const props = unionSlots(group, ['prop1', 'prop2'], 2) ?? []
  const emptySlot = { image: '', description: '', nodeId: '' }

  return {
    ...first,
    shot_number: `${first.shot_number}~${last.shot_number}`,
    duration: group.reduce((s, r) => s + (r.duration || 0), 0),
    status: 'todo',
    visual_description: timeSegmented(group, (r) => r.visual_description),
    character_actions: timeSegmented(group, (r) => r.character_actions),
    motion_prompts: timeSegmented(group, (r) => r.motion_prompts || r.character_actions || r.visual_description),
    storyboard_prompts: timeSegmented(group, (r) => r.storyboard_prompts || r.visual_description),
    dialogue: group.map((r) => r.dialogue.trim()).filter(Boolean).join('\n'),
    sound_effects: joinUnique(group, (r) => r.sound_effects),
    shot_size: joinUnique(group, (r) => r.shot_size, ' → '),
    emotion_mood: joinUnique(group, (r) => r.emotion_mood),
    emotion_atmosphere: joinUnique(group, (r) => r.emotion_atmosphere),
    character_motivation: joinUnique(group, (r) => r.character_motivation),
    character_psychology: joinUnique(group, (r) => r.character_psychology),
    performance_guidance: joinUnique(group, (r) => r.performance_guidance),
    lighting_atmosphere: joinUnique(group, (r) => r.lighting_atmosphere),
    mixing_brief: joinUnique(group, (r) => r.mixing_brief),
    bgm: joinUnique(group, (r) => r.bgm),
    // Opening linkage from the first beat + tail 留白 from the last one.
    transition_note: joinUnique([first, last], (r) => r.transition_note, '\n'),
    character1: characters[0] ?? { ...emptySlot },
    character2: characters[1] ?? { ...emptySlot },
    prop1: props[0] ?? { ...emptySlot },
    prop2: props[1] ?? { ...emptySlot },
    // scene / scene_tags / visual_anchor / reference_image stay from `first`.
  }
}

/**
 * Compute adjacent same-scene merge groups as index lists into `rows`.
 * Every index appears exactly once; singleton groups mean "keep as-is".
 * Exported so the table's manual merge can patch/remove rows by id
 * instead of replacing the whole store.
 */
export function computeMergeGroups(
  rows: StoryboardRowInput[],
  maxSeconds: number = SEEDANCE_MAX_SECONDS,
): number[][] {
  const groups: number[][] = []
  let group: number[] = []
  for (let i = 0; i < rows.length; i++) {
    if (group.length === 0) {
      group = [i]
    } else if (canJoin(group.map((g) => rows[g]!), rows[i]!, maxSeconds)) {
      group.push(i)
    } else {
      groups.push(group)
      group = [i]
    }
  }
  if (group.length > 0) groups.push(group)
  return groups
}

export function mergeSameSceneRows<T extends StoryboardRowInput>(
  rows: T[],
  maxSeconds: number = SEEDANCE_MAX_SECONDS,
): { rows: T[]; mergedAway: number } {
  const out = computeMergeGroups(rows, maxSeconds).map((g) => mergeRowGroup(g.map((i) => rows[i]!)))
  return { rows: out, mergedAway: rows.length - out.length }
}
