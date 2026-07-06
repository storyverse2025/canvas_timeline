/**
 * Local 开白 registry — the digital assets THIS canvas_timeline instance
 * registered (CreateAsset) from its OWN generated character images.
 *
 * This is deliberately SEPARATE from the shared BytePlus account list
 * (`fetchByteplusAssets` → ListAssets). The account is used by many people;
 * their assets are strangers' faces we never want to pick. Here we only ever
 * surface the characters the user generated + 开白'd inside canvas_timeline.
 *
 * Persisted in localStorage so it survives reloads. Populated automatically
 * whenever auto-registration succeeds (art-director-agent) and by the manual
 * "register this image" flows. Consumers:
 *   - ByteplusAssetPickerDialog (node 绿盾) lists THESE, not the account.
 *   - resolveShootAvatarRefs merges these into the shoot's asset pool so a
 *     name→asset binding resolves even when the shared account list is stale,
 *     huge, or IAM-blocked.
 */

import type { ByteplusAsset } from '@/lib/byteplus-asset-library'

const KEY = 'byteplus-openbai-registry-v1'

export interface LocalByteplusAsset {
  /** BytePlus Asset_Id — shipped downstream as `asset://<id>`. */
  id: string
  /** Character name at registration time (canonical matching key source). */
  name: string
  /** Same-origin /uploads/ thumbnail of the registered image (for the picker). */
  previewUrl?: string
  /** Active (usable in generation) vs Processing/Failed. Only Active ones match. */
  active: boolean
  createdAt: number
  /** Project the asset was registered from (for optional per-project filtering). */
  projectId?: string
}

function read(): LocalByteplusAsset[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr)
      ? (arr.filter((e) => e && typeof (e as LocalByteplusAsset).id === 'string') as LocalByteplusAsset[])
      : []
  } catch {
    return []
  }
}

function write(list: LocalByteplusAsset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* localStorage quota / unavailable — non-fatal, registry is best-effort */
  }
}

/** All registered assets, newest first. */
export function listLocalByteplusAssets(): LocalByteplusAsset[] {
  return read().sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Upsert by asset id. Re-registering the same id refreshes name / preview /
 * active but keeps the original createdAt so ordering is stable.
 */
export function recordLocalByteplusAsset(
  entry: Omit<LocalByteplusAsset, 'createdAt'> & { createdAt?: number },
): void {
  if (!entry.id) return
  const list = read()
  const idx = list.findIndex((e) => e.id === entry.id)
  const rec: LocalByteplusAsset = {
    id: entry.id,
    name: entry.name,
    previewUrl: entry.previewUrl,
    active: entry.active,
    createdAt: idx >= 0 ? list[idx]!.createdAt : (entry.createdAt ?? Date.now()),
    projectId: entry.projectId,
  }
  if (idx >= 0) list[idx] = rec
  else list.push(rec)
  write(list)
}

export function removeLocalByteplusAsset(id: string): void {
  write(read().filter((e) => e.id !== id))
}

/**
 * Adapt a registry entry to the shared `ByteplusAsset` shape so it drops
 * straight into `matchAssetsToCharacters` and the picker UI. Non-active
 * entries map to status 'Processing' so the matcher (Active-only) skips them.
 */
export function toByteplusAsset(e: LocalByteplusAsset): ByteplusAsset {
  return {
    id: e.id,
    name: e.name,
    assetType: 'Image',
    status: e.active ? 'Active' : 'Processing',
    groupId: '',
    previewUrl: e.previewUrl,
  }
}

/** Convenience: the registry as ByteplusAsset[] (for matching / listing). */
export function listLocalByteplusAssetsAsByteplus(): ByteplusAsset[] {
  return listLocalByteplusAssets().map(toByteplusAsset)
}
