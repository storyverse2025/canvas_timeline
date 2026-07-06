import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'
import { normalizeRowSlots, validateStoryboard, type ElementSlot, type StoryboardRowInput, type StoryboardValidationResult } from '@/types/storyboard'

const SHORT_ID_RE = /\b([0-9a-f]{6,8})\b/i

/** Resolve canvas node short-id prefix → image URL / text content / full node id */
export function resolveCanvasReference(shortId: string): { url?: string; nodeId?: string; text?: string } {
  const nodes = useCanvasStore.getState().nodes
  const items = useCanvasItemStore.getState().items
  const assets = useAssetStore.getState().assets
  const node = nodes.find((n) => n.id.startsWith(shortId))
  if (!node) return {}
  if (node.data.itemId) {
    const it = items[node.data.itemId]
    if (!it) return { nodeId: node.id }
    return it.kind === 'image'
      ? { nodeId: node.id, url: it.content }
      : { nodeId: node.id, text: it.content }
  }
  if (node.data.assetId) {
    const a = assets.find((x) => x.id === node.data.assetId)
    return { nodeId: node.id, url: a?.imageUrl }
  }
  return { nodeId: node.id }
}

/** Try every balanced JSON-array-looking span, ignoring brackets inside strings. */
function parseFirstBalancedJsonArray(text: string): unknown[] | null {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '[') continue

    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < text.length; i++) {
      const ch = text[i]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }

      if (ch === '"') {
        inString = true
      } else if (ch === '[') {
        depth++
      } else if (ch === ']') {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1))
            if (Array.isArray(parsed)) return parsed
          } catch {
            // Not the storyboard array; continue scanning later '[' chars.
          }
          break
        }
      }
    }
  }
  return null
}

/** Extract the first JSON array of storyboard rows from a model response. */
function extractJsonArray(text: string): unknown | null {
  // Prefer fenced ```json ... ``` blocks, but still scan robustly because retries
  // often include prose like “fixed [S1]” before the corrected array.
  const fence = text.match(/```json\s*([\s\S]+?)\s*```/i) ?? text.match(/```\s*([\s\S]+?)\s*```/)
  const candidates = [fence?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const parsed = parseFirstBalancedJsonArray(c)
    if (parsed) return parsed
  }
  return null
}

export interface ParseResult {
  ok: boolean;
  rows?: Array<StoryboardRowInput & { referenceNodeId?: string }>;
  errors?: string[];
}

/**
 * Map common LLM field-name drift back to the canonical schema keys before
 * Zod validation. Models intermittently emit `shot` / `shotNumber` for
 * `shot_number`, `time` / `length` / `seconds` for `duration`, etc. Without
 * this, the validation message reads "shot_number undefined" and the user
 * has no idea the model actually returned a fully-populated row under a
 * different key. Only fills the canonical key when it's currently empty —
 * we never overwrite a value the model already put under the correct name.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  shot_number: ['shotNumber', 'shot', 'shot_no', 'shot_id', 'shotId', 'shotID', 'id', 'number'],
  duration: ['time', 'length', 'dur', 'seconds', 'secs', 'durationSeconds', 'duration_seconds', 'time_seconds', 'timeSeconds'],
  visual_description: ['visualDescription', 'description', 'visual_desc', 'visualDesc'],
  shot_size: ['shotSize', 'framing', 'size', 'lens'],
  character_actions: ['characterActions', 'actions', 'action'],
  emotion_mood: ['emotionMood', 'mood', 'emotion'],
  emotion_atmosphere: ['emotionAtmosphere', 'atmosphere'],
  lighting_atmosphere: ['lightingAtmosphere', 'lighting'],
  storyboard_prompts: ['storyboardPrompts', 'storyboardPrompt', 'prompt'],
  motion_prompts: ['motionPrompts', 'motionPrompt', 'motion'],
  sound_effects: ['soundEffects', 'sfx', 'sound'],
  character_motivation: ['characterMotivation', 'motivation'],
  character_psychology: ['characterPsychology', 'psychology'],
  performance_guidance: ['performanceGuidance', 'performance'],
  visual_anchor: ['visualAnchor', 'anchor'],
  scene_tags: ['sceneTags', 'tags'],
  mixing_brief: ['mixingBrief', 'mixing'],
}

function coerceFieldAliases(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row }
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    const present = out[canonical]
    const presentIsEmpty =
      present === undefined ||
      present === null ||
      (typeof present === 'string' && present.trim() === '')
    if (!presentIsEmpty) continue
    for (const alt of aliases) {
      const v = out[alt]
      if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) {
        out[canonical] = v
        break
      }
    }
  }
  return out
}

/** One-line snippet of a single row, capped, for inclusion in error messages. */
function previewRow(row: unknown): string {
  try {
    const s = JSON.stringify(row)
    return s.length > 180 ? s.slice(0, 180) + '…' : s
  } catch {
    return String(row).slice(0, 180)
  }
}

/**
 * Parse + validate a storyboard response. Returns structured rows or a list of
 * schema errors that can be fed back into a retry prompt.
 */
export function parseAndValidateStoryboard(response: string): ParseResult {
  const raw = extractJsonArray(response)
  if (!raw) return { ok: false, errors: ['未找到 JSON 数组（请用 ```json ... ``` 包裹完整数组）'] }

  const coerced: unknown[] = Array.isArray(raw) ? raw.map((row: unknown) => {
    if (!row || typeof row !== 'object') return row
    let r = { ...(row as Record<string, unknown>) }
    // Field-name aliases: shot/shotNumber → shot_number, time → duration, etc.
    r = coerceFieldAliases(r)
    // duration → number if numeric-string
    if (typeof r.duration === 'string' && r.duration.trim() !== '') {
      const n = parseFloat(r.duration as string)
      if (!Number.isNaN(n)) r.duration = n
    }
    return r
  }) : []

  const v: StoryboardValidationResult = validateStoryboard(coerced)
  if (!v.ok || !v.rows) {
    // Append previews of the failing rows so the user / dev can see WHAT
    // the model returned, not just "shot_number undefined". The schema
    // error message alone is useless when the model output a sibling
    // shape the alias coercion didn't catch.
    const previews: string[] = []
    if (Array.isArray(coerced)) {
      // Find which indices the errors point at and quote those rows.
      const referencedIdxs = new Set<number>()
      for (const e of v.errors ?? []) {
        const m = e.match(/^(\d+)\./)
        if (m) referencedIdxs.add(parseInt(m[1]!, 10))
      }
      if (referencedIdxs.size === 0 && coerced.length > 0) referencedIdxs.add(0)
      for (const i of Array.from(referencedIdxs).sort((a, b) => a - b).slice(0, 3)) {
        previews.push(`row[${i}] = ${previewRow(coerced[i])}`)
      }
    }
    const errors = [...(v.errors ?? []), ...previews]
    return { ok: false, errors }
  }

  const rows = v.rows.map((row) => {
    const out: StoryboardRowInput & { referenceNodeId?: string } = { ...row }
    const refStr = (row.reference_image ?? '').trim()
    const m = refStr.match(SHORT_ID_RE)
    if (m && !/^https?:\/\//i.test(refStr)) {
      const ref = resolveCanvasReference(m[1])
      if (ref.nodeId) out.referenceNodeId = ref.nodeId
      if (ref.url) out.reference_image = ref.url
    }
    // Element slots: resolve [node:xxxxxx] short ids in slot.image to full URLs.
    // IMPORTANT: art-director runs asset image generation in the background
    // while the storyboard table is being written. If parsing happens before
    // an asset image arrives, `ref.url` is the empty string. Use `||` (not
    // `??`) so the empty string falls through to the original short-id —
    // resolveSlotNode at keyframe time will re-resolve via slot.nodeId from
    // the live item store, and a future re-parse will also recover.
    const resolveSlot = (slot: unknown): ElementSlot | undefined => {
      if (!slot || typeof slot !== 'object') return undefined
      const s = slot as ElementSlot
      const img = String(s.image ?? '').trim()
      if (!img || /^https?:\/\//i.test(img) || img.startsWith('data:')) return undefined
      const sm = img.match(SHORT_ID_RE)
      if (!sm) return undefined
      const ref = resolveCanvasReference(sm[1])
      return { image: ref.url || img, description: s.description ?? '', nodeId: ref.nodeId ?? s.nodeId ?? '' }
    }
    for (const slotKey of ['character1', 'character2', 'prop1', 'prop2', 'scene'] as const) {
      const resolved = resolveSlot(out[slotKey])
      if (resolved) out[slotKey] = resolved
    }
    // Same short-id resolution for the canonical multi-slot arrays.
    for (const arrKey of ['characters', 'props'] as const) {
      const arr = out[arrKey]
      if (!Array.isArray(arr)) continue
      out[arrKey] = arr.map((slot) => resolveSlot(slot) ?? slot)
    }
    // Reconcile arrays ↔ legacy pair fields (back-fills arrays for old
    // storyboards, mirrors first-two onto character1/2 + prop1/2).
    return normalizeRowSlots(out)
  })

  return { ok: true, rows }
}
