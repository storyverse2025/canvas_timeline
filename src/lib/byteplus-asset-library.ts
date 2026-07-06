/**
 * BytePlus private digital-asset library (真人开白资产) — client side.
 *
 * The account's pre-registered, review-approved (Status=Active) assets are
 * the ONLY sanctioned way to put a real person into Seedance output: their
 * `asset://<Asset_Id>` URI goes into the generation request as a
 * reference_image content part ("Private digital assets library" doc —
 * `content.<modal>_url.url` = `asset://<Asset_Id>`). Whitelisting is NOT
 * transitive: a photoreal keyframe that merely *contains* the approved face
 * still trips InputImageSensitiveContentDetected.PrivacyInformation, so the
 * approved asset must ride along as its own asset:// part on EVERY shoot,
 * not as a post-block retry.
 *
 * This module lists the assets (via the dev server's AK/SK-signed
 * /capabilities/byteplus-assets endpoint), matches storyboard characters to
 * them by name, and emits VirtualAvatarShootRef entries the cinematographer
 * already knows how to ship (asset:// parts + 虚拟人像 legend lines).
 */

import { canonicalCharacterName } from '@/lib/virtual-avatar-library'
import type { VirtualAvatarShootRef } from '@/lib/agents/cinematographer-agent'

export interface ByteplusAsset {
  id: string
  name: string
  assetType: string
  status: string
  groupId: string
  /** Permanent same-origin /uploads/ copy of the asset image, persisted
   *  server-side (the raw ListAssets URL is signed and expires ~12h).
   *  Absent when the download failed — the asset still matches/ships. */
  previewUrl?: string
}

const LIST_ENDPOINT = '/capabilities/byteplus-assets'
const CACHE_TTL_MS = 5 * 60 * 1000

let cache: { at: number; assets: ByteplusAsset[] } | null = null

/** Test hook: reset the module-level list cache. */
export function _resetByteplusAssetCache(): void {
  cache = null
}

/**
 * Fetch the account's digital assets, cached for a few minutes (the list
 * only changes when someone registers a new 真人资产 in the console).
 * `force` bypasses the cache — the asset-library dialog's refresh button
 * uses it right after the user registers something in the console.
 * Throws on transport/IAM errors — callers decide whether that's fatal.
 */
export async function fetchByteplusAssets(opts: { force?: boolean } = {}): Promise<ByteplusAsset[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.assets
  const res = await fetch(LIST_ENDPOINT)
  const body = (await res.json()) as { assets?: ByteplusAsset[]; error?: string }
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `byteplus-assets HTTP ${res.status}`)
  }
  cache = { at: Date.now(), assets: body.assets ?? [] }
  return cache.assets
}

/**
 * Match character slots to Active image assets.
 *
 * Priority per character:
 *   1. Explicit binding (canonical character name → asset id) from the
 *      资产库 dialog's 点选分配 — in practice REQUIRED for most accounts,
 *      because console-registered asset Names are machine hashes
 *      ("keyframe_4fcae3d7"), not character names.
 *   2. Canonical-name match (first comma-segment, parentheticals stripped,
 *      lowercased, containment both ways) — "艾琳 (Erin) — 凌乱的黑色短发"
 *      matches an asset renamed to "艾琳" or "艾琳真人参考".
 *
 * Each asset is used at most once (two characters never collapse onto the
 * same registered person). Pure — unit-tested directly.
 *
 * The bindings map is shared with characterAvatarBindings: avatar-library
 * ids and BytePlus asset ids live in one map, and each consumer only acts
 * on ids it recognizes (resolveAvatarsForCharacters checks its catalog;
 * this checks the listed assets), so the two never fight.
 */
export function matchAssetsToCharacters(
  characters: Array<{ slotLabel: string; name?: string | null }>,
  assets: ByteplusAsset[],
  bindings: Record<string, string> = {},
): VirtualAvatarShootRef[] {
  const usable = assets.filter(
    (a) => a.id && a.status.toLowerCase() === 'active' && a.assetType.toLowerCase() === 'image',
  )
  const usableById = new Map(usable.map((a) => [a.id, a]))
  const used = new Set<string>()
  const out: VirtualAvatarShootRef[] = []
  for (const ch of characters) {
    const raw = ch.name?.trim()
    if (!raw) continue
    const key = canonicalCharacterName(raw)
    if (!key) continue
    const boundId = bindings[key]
    const bound = boundId && !used.has(boundId) ? usableById.get(boundId) : undefined
    const hit = bound ?? usable.find((a) => {
      if (used.has(a.id)) return false
      const an = canonicalCharacterName(a.name)
      return Boolean(an) && (an === key || an.includes(key) || key.includes(an))
    })
    if (!hit) continue
    used.add(hit.id)
    out.push({
      assetUri: `asset://${hit.id}`,
      characterName: raw.split(/[,，。\n]/)[0]?.trim() || raw,
      slotLabel: ch.slotLabel,
    })
  }
  return out
}

/**
 * Merge registered-asset matches with any other avatar refs, one ref per
 * character (canonical name), registered assets winning — an explicitly
 * 开白'd real person beats a library avatar for the same character.
 */
export function mergeAvatarRefs(
  byteplusRefs: VirtualAvatarShootRef[],
  otherRefs: VirtualAvatarShootRef[],
): VirtualAvatarShootRef[] {
  const seen = new Set(byteplusRefs.map((r) => canonicalCharacterName(r.characterName)))
  return [
    ...byteplusRefs,
    ...otherRefs.filter((r) => !seen.has(canonicalCharacterName(r.characterName))),
  ]
}
