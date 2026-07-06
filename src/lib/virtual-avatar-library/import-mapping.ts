/**
 * Map raw BytePlus / Volcano asset objects (from the console avatar library or
 * the ListAssets OpenAPI) into our VirtualAvatarAsset catalog shape.
 *
 * The exact console response isn't publicly documented, so the mapper is
 * lenient: it tries several field-name spellings (PascalCase OpenAPI, camelCase
 * console, snake_case) and infers gender / age / nationality from any tag or
 * profile text when there's no explicit field. Unknown shapes degrade to
 * id + name only rather than throwing.
 */

import { normalizeGender, parseAgeRange, inferNationalityFromText } from './index'
import type { AvatarGender, VirtualAvatarAsset } from './types'

type Raw = Record<string, unknown>

function str(o: Raw, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return undefined
}

function toTags(o: Raw, ...keys: string[]): string[] {
  for (const k of keys) {
    const v = o[k]
    if (Array.isArray(v)) {
      const out = v.map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x ? str(x as Raw, 'Name', 'name', 'label', 'value') : undefined)).filter((s): s is string => !!s)
      if (out.length) return out
    }
    if (typeof v === 'string' && v.trim()) return v.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

/** Pull the asset id out of either a bare id field or an `asset://<id>` uri. */
function assetId(o: Raw): string | undefined {
  const direct = str(o, 'Id', 'id', 'AssetId', 'asset_id', 'assetId')
  if (direct) return direct
  const uri = str(o, 'URI', 'uri', 'Uri')
  if (uri?.startsWith('asset://')) return uri.slice('asset://'.length)
  return undefined
}

/** A preview image url — http(s)/data only (an `asset://` uri is not displayable). */
function previewUri(o: Raw): string | undefined {
  const u = str(o, 'CoverUrl', 'coverUrl', 'PreviewUrl', 'previewUrl', 'ImageUrl', 'imageUrl', 'URL', 'url', 'Url', 'thumbnail', 'Thumbnail')
  if (u && (/^https?:\/\//i.test(u) || u.startsWith('data:'))) return u
  return undefined
}

export function mapByteplusAssetToAvatar(raw: unknown): VirtualAvatarAsset | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Raw
  const id = assetId(o)
  if (!id) return null

  const name = str(o, 'Name', 'name', 'Title', 'title') ?? id
  const tags = toTags(o, 'Tags', 'tags', 'Labels', 'labels')
  // Profile / description text used to infer demographics when no explicit field.
  const profileText = [
    str(o, 'Gender', 'gender'),
    str(o, 'Age', 'age', 'AgeRange', 'age_range'),
    str(o, 'Nationality', 'nationality', 'Region', 'region', 'Ethnicity'),
    str(o, 'Profile', 'profile', 'Description', 'description'),
    ...tags,
  ].filter(Boolean).join(' ')

  const gender: AvatarGender = normalizeGender(str(o, 'Gender', 'gender') ?? profileText) ?? 'neutral'
  const age = parseAgeRange(str(o, 'Age', 'age', 'AgeRange', 'age_range') ?? profileText)
  const nationality = inferNationalityFromText(str(o, 'Nationality', 'nationality') ?? profileText) ?? undefined
  const uri = previewUri(o)

  return {
    id,
    name,
    ...(uri ? { uri } : {}),
    gender,
    ageMin: age?.min ?? 0,
    ageMax: age?.max ?? 0,
    ...(nationality ? { nationality } : {}),
    ...(tags.length ? { tags } : {}),
  }
}

/**
 * Map a raw response (array, or an object wrapping the array under common keys
 * like Result.Items / data / list) into VirtualAvatarAsset[]. Drops entries
 * with no resolvable id.
 */
export function mapByteplusAssets(response: unknown): VirtualAvatarAsset[] {
  const items = extractItems(response)
  return items.map(mapByteplusAssetToAvatar).filter((a): a is VirtualAvatarAsset => a != null)
}

function extractItems(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  if (!response || typeof response !== 'object') return []
  const o = response as Raw
  // Common envelopes: {Result:{Items:[]}}, {data:{list:[]}}, {Items:[]}, {data:[]}
  const candidates: unknown[] = [
    (o.Result as Raw | undefined)?.Items,
    (o.Result as Raw | undefined)?.Assets,
    (o.result as Raw | undefined)?.items,
    (o.data as Raw | undefined)?.list,
    (o.data as Raw | undefined)?.items,
    (o.data as Raw | undefined)?.Items,
    o.Items,
    o.items,
    o.list,
    o.data,
    o.assets,
  ]
  for (const c of candidates) if (Array.isArray(c)) return c
  return []
}
