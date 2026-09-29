import type { SvBundle, SvProjectListResponse } from './types'

/**
 * Browser-side client for the read-only StoryVerse endpoints served by
 * `vite-storyverse-plugin.ts`. Both calls are GETs; the Supabase service-role
 * key stays in Node and never reaches this file.
 */

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: 'GET', signal })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error ?? `HTTP ${res.status}`
    throw new Error(msg)
  }
  return body as T
}

export function listStoryverseProjects(
  opts: { limit?: number; offset?: number; q?: string } = {},
  signal?: AbortSignal,
): Promise<SvProjectListResponse> {
  const p = new URLSearchParams()
  if (opts.limit) p.set('limit', String(opts.limit))
  if (opts.offset) p.set('offset', String(opts.offset))
  if (opts.q?.trim()) p.set('q', opts.q.trim())
  return getJson<SvProjectListResponse>(`/storyverse/projects?${p.toString()}`, signal)
}

/**
 * Fetch one project's full bundle. The server downloads every private-bucket
 * image into public/uploads/ during this call, so it can take a few seconds
 * on an asset-heavy project (and much longer with localizeVideos).
 */
export function fetchStoryverseProject(
  id: string,
  opts: { localizeVideos?: boolean } = {},
  signal?: AbortSignal,
): Promise<SvBundle> {
  const p = new URLSearchParams({ id })
  if (opts.localizeVideos) p.set('localizeVideos', '1')
  return getJson<SvBundle>(`/storyverse/project?${p.toString()}`, signal)
}
