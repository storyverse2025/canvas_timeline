/**
 * Virtual Avatar Library — catalog source.
 *
 * The real avatar ids/URIs live in Volcengine's experience center
 * (https://www.volcengine.com/docs/82379/2223965) and are NOT bundled here:
 * the set changes over time and there is no confirmed public list API on the
 * BytePlus 海外 endpoint. To populate the catalog without a code change, set
 * `VITE_VIRTUAL_AVATAR_CATALOG` to a JSON array of `VirtualAvatarAsset`, or
 * call `setAvatarCatalogOverride()` at runtime.
 *
 * Shape of one entry:
 *   {
 *     "id": "<platform asset id>",
 *     "name": "图片1",
 *     "uri": "https://.../avatar.png",
 *     "gender": "female",
 *     "ageMin": 20, "ageMax": 30,
 *     "nationality": "chinese",
 *     "tags": ["long-hair", "casual"]
 *   }
 */

import type { VirtualAvatarAsset } from './types'

/**
 * Built-in catalog. Intentionally empty — no fabricated asset ids ship.
 * Populate via env (`VITE_VIRTUAL_AVATAR_CATALOG`) or
 * `setAvatarCatalogOverride()` once real avatar ids are known.
 */
export const BUILTIN_VIRTUAL_AVATARS: readonly VirtualAvatarAsset[] = []

let runtimeOverride: VirtualAvatarAsset[] | null = null

/**
 * Replace the catalog at runtime (e.g. after fetching from a config service).
 * Pass `null` to clear the override and fall back to env + builtin.
 */
export function setAvatarCatalogOverride(catalog: VirtualAvatarAsset[] | null): void {
  runtimeOverride = catalog
}

function parseEnvCatalog(): VirtualAvatarAsset[] {
  const raw = import.meta.env?.VITE_VIRTUAL_AVATAR_CATALOG
  if (!raw || typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as VirtualAvatarAsset[]) : []
  } catch {
    console.warn('[virtual-avatar-library] VITE_VIRTUAL_AVATAR_CATALOG is not valid JSON — ignoring')
    return []
  }
}

/**
 * The active catalog: runtime override wins, then env JSON, then builtin.
 * Matcher functions default to this but accept an explicit catalog for tests.
 */
export function loadAvatarCatalog(): VirtualAvatarAsset[] {
  if (runtimeOverride) return runtimeOverride
  const env = parseEnvCatalog()
  if (env.length > 0) return env
  return [...BUILTIN_VIRTUAL_AVATARS]
}
