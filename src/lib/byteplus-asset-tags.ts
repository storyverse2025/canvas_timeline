/**
 * Vision-derived gender/age tags for BytePlus 开白 assets.
 *
 * ListAssets carries NO gender/age metadata (Name is a machine hash), so the
 * asset picker can't filter by "female / young" out of the box. We classify
 * each asset's preview image once with a vision LLM (freeform-text accepts an
 * image input) and cache the result in localStorage keyed by asset id —
 * assets are stable, so this is a one-time cost per asset, reused across
 * reloads and sessions.
 */

import { runCapability } from '@/lib/capabilities/client'
import type { ByteplusAsset } from '@/lib/byteplus-asset-library'

export type AssetGender = 'male' | 'female' | 'unknown'
export type AssetAgeBand = 'child' | 'teen' | 'young' | 'adult' | 'senior' | 'unknown'

export interface AssetTag {
  gender: AssetGender
  ageBand: AssetAgeBand
}

const LS_KEY = 'byteplus-asset-tags-v1'
const GENDERS: AssetGender[] = ['male', 'female', 'unknown']
const AGE_BANDS: AssetAgeBand[] = ['child', 'teen', 'young', 'adult', 'senior', 'unknown']

export const AGE_BAND_LABELS: Record<AssetAgeBand, string> = {
  child: '儿童', teen: '青少年', young: '青年', adult: '中年', senior: '年长', unknown: '未知',
}
export const GENDER_LABELS: Record<AssetGender, string> = {
  male: '男', female: '女', unknown: '未知',
}

let mem: Record<string, AssetTag> | null = null

function readCache(): Record<string, AssetTag> {
  if (mem) return mem
  try {
    const raw = localStorage.getItem(LS_KEY)
    mem = raw ? (JSON.parse(raw) as Record<string, AssetTag>) : {}
  } catch {
    mem = {}
  }
  return mem
}

function writeCache(next: Record<string, AssetTag>): void {
  mem = next
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* localStorage may be disabled */ }
}

export function getCachedTag(id: string): AssetTag | undefined {
  return readCache()[id]
}

function normGender(v: unknown): AssetGender {
  const s = String(v ?? '').toLowerCase()
  return (GENDERS as string[]).includes(s) ? (s as AssetGender) : 'unknown'
}
function normAge(v: unknown): AssetAgeBand {
  const s = String(v ?? '').toLowerCase()
  return (AGE_BANDS as string[]).includes(s) ? (s as AssetAgeBand) : 'unknown'
}

/** Classify ONE asset's preview via the vision LLM. Returns unknown/unknown
 *  on any failure so a bad classification never blocks the picker. */
export async function classifyAsset(asset: ByteplusAsset): Promise<AssetTag> {
  if (!asset.previewUrl) return { gender: 'unknown', ageBand: 'unknown' }
  const prompt = [
    '这是一张人物形象参考图。只输出一行 JSON，不要解释、不要代码围栏：',
    '{"gender":"male|female|unknown","age_band":"child|teen|young|adult|senior|unknown"}',
    'gender 按外观判断；age_band：child=儿童, teen=青少年, young=青年(约18-30), adult=中年(约30-55), senior=年长(55+)。',
  ].join('\n')
  try {
    const out = await runCapability({
      capability: 'freeform-text',
      inputs: [
        { kind: 'text', text: prompt },
        { kind: 'image', url: asset.previewUrl },
      ],
    })
    const text = (out.outputs[0]?.text ?? '').trim()
    const m = text.match(/\{[^}]*\}/)
    if (!m) return { gender: 'unknown', ageBand: 'unknown' }
    const parsed = JSON.parse(m[0]) as { gender?: unknown; age_band?: unknown }
    return { gender: normGender(parsed.gender), ageBand: normAge(parsed.age_band) }
  } catch {
    return { gender: 'unknown', ageBand: 'unknown' }
  }
}

/**
 * Ensure every asset has a tag, classifying uncached ones with bounded
 * concurrency. Calls onTag(id, tag) as each resolves so the UI can update
 * incrementally. Returns the full id→tag map (cached + freshly classified).
 */
export async function ensureAssetTags(
  assets: ByteplusAsset[],
  onTag?: (id: string, tag: AssetTag) => void,
  concurrency = 4,
): Promise<Record<string, AssetTag>> {
  const cache = { ...readCache() }
  const todo = assets.filter((a) => a.previewUrl && !cache[a.id])
  let i = 0
  async function worker() {
    while (i < todo.length) {
      const asset = todo[i++]!
      const tag = await classifyAsset(asset)
      cache[asset.id] = tag
      writeCache(cache)
      onTag?.(asset.id, tag)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  return cache
}

/** Best-effort map a casting card's free-text gender/age → filter values, so
 *  the picker can default to the character's demographic. */
export function inferGenderFromText(text: string | undefined): AssetGender {
  const t = (text ?? '').toLowerCase()
  if (/女|female|woman|girl|少女|女性/.test(t)) return 'female'
  if (/男|male|man|boy|少年|男性/.test(t)) return 'male'
  return 'unknown'
}
export function inferAgeBandFromText(text: string | undefined): AssetAgeBand {
  const t = (text ?? '').toLowerCase()
  if (/儿童|child|小孩|幼/.test(t)) return 'child'
  if (/青少年|teen|少年|少女|中学/.test(t)) return 'teen'
  if (/年长|senior|老|elderly|花甲|\b(5[5-9]|[6-9]\d)\b/.test(t)) return 'senior'
  if (/中年|adult|middle|\b(3[5-9]|4\d|5[0-4])\b/.test(t)) return 'adult'
  if (/青年|young|少|\b(1[8-9]|2\d|3[0-4])\b|twenties|thirties/.test(t)) return 'young'
  return 'unknown'
}
