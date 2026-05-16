import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'
import { validateStoryboard, type StoryboardRowInput, type StoryboardValidationResult } from '@/types/storyboard'

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
 * Parse + validate a storyboard response. Returns structured rows or a list of
 * schema errors that can be fed back into a retry prompt.
 */
export function parseAndValidateStoryboard(response: string): ParseResult {
  const raw = extractJsonArray(response)
  if (!raw) return { ok: false, errors: ['未找到 JSON 数组（请用 ```json ... ``` 包裹完整数组）'] }

  // Coerce reference_image: if it's a canvas short id, resolve it.
  const coerced: unknown[] = Array.isArray(raw) ? raw.map((row: unknown) => {
    if (!row || typeof row !== 'object') return row
    const r = { ...(row as Record<string, unknown>) }
    // duration → number if numeric-string
    if (typeof r.duration === 'string' && r.duration.trim() !== '') {
      const n = parseFloat(r.duration as string)
      if (!Number.isNaN(n)) r.duration = n
    }
    return r
  }) : []

  const v: StoryboardValidationResult = validateStoryboard(coerced)
  if (!v.ok || !v.rows) return { ok: false, errors: v.errors }

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
    for (const slotKey of ['character1', 'character2', 'prop1', 'prop2', 'scene'] as const) {
      const slot = out[slotKey]
      if (!slot || typeof slot !== 'object') continue
      const img = String(slot.image ?? '').trim()
      if (!img || /^https?:\/\//i.test(img) || img.startsWith('data:')) continue
      const sm = img.match(SHORT_ID_RE)
      if (!sm) continue
      const ref = resolveCanvasReference(sm[1])
      out[slotKey] = {
        image: ref.url ?? img,
        description: slot.description ?? '',
        nodeId: ref.nodeId ?? slot.nodeId ?? '',
      }
    }
    return out
  })

  return { ok: true, rows }
}
