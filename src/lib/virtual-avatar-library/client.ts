/**
 * Browser-side client for the virtual-avatar catalog served by
 * vite-avatars-plugin (`/virtual-avatars/*`). Fetching also pushes the list
 * into the in-memory override so the matcher / resolver (which read
 * `loadAvatarCatalog()` synchronously at generation time) see the same data.
 */

import { setAvatarCatalogOverride } from './data'
import { mapByteplusAssets } from './import-mapping'
import type { VirtualAvatarAsset } from './types'

/** GET the stored catalog and prime the runtime override. */
export async function fetchAvatarCatalog(): Promise<VirtualAvatarAsset[]> {
  const res = await fetch('/virtual-avatars/list')
  if (!res.ok) throw new Error(`avatar list failed: ${res.status}`)
  const data = (await res.json()) as { avatars?: VirtualAvatarAsset[] }
  const avatars = Array.isArray(data.avatars) ? data.avatars : []
  setAvatarCatalogOverride(avatars)
  return avatars
}

/** Persist avatars to the catalog file (merge by id, or replace the whole set). */
export async function importAvatars(
  avatars: VirtualAvatarAsset[],
  opts: { replace?: boolean } = {},
): Promise<{ count: number; added: number }> {
  const res = await fetch('/virtual-avatars/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatars, replace: opts.replace ?? false }),
  })
  if (!res.ok) throw new Error(`avatar import failed: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * Scrape the BytePlus avatar library by replaying a cURL copied from the user's
 * logged-in Model Playground. The server re-issues it (with pagination) and
 * returns raw items; we map them with the tested mapper and replace the catalog.
 */
export async function scrapeAvatarsFromCurl(
  curl: string,
): Promise<{ count: number; added: number; scraped: number }> {
  const res = await fetch('/virtual-avatars/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ curl }),
  })
  if (!res.ok) throw new Error(`scrape failed: ${res.status} ${await res.text()}`)
  const { items } = (await res.json()) as { items: unknown[] }
  const mapped = mapByteplusAssets(items)
  if (mapped.length === 0) {
    throw new Error(`抓到 ${items.length} 条但 0 个可识别头像 — 响应结构未匹配，把一条样本发我调映射`)
  }
  const r = await importAvatars(mapped, { replace: true })
  return { ...r, scraped: items.length }
}
