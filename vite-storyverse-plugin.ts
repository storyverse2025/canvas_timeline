import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

/**
 * Dev-server bridge to the StoryVerse production Supabase project — the same
 * database behind https://storyverse-monorepo-web.vercel.app/admin/projects.
 *
 * STRICTLY READ-ONLY. Every upstream call this plugin makes is a GET against
 * PostgREST (`/rest/v1/...`) or Storage (`/storage/v1/object/...`). There is no
 * code path here that issues POST / PATCH / PUT / DELETE upstream, and the
 * middlewares themselves reject any method other than GET, so a stray fetch
 * from the browser cannot turn into a write. The service-role key is read from
 * .env (via load-env.mjs) and never leaves Node.
 *
 *   GET /storyverse/projects?limit=&offset=&q=
 *       → { projects: [{ id, title, status, updatedAt, coverImageUrl,
 *                        episodes, frames, shots, assets }], total }
 *       Sorted by updated_at desc (活跃时间).
 *
 *   GET /storyverse/project?id=<uuid>&localizeVideos=0|1
 *       → SvBundle (see src/lib/storyverse-import/types.ts)
 *
 * Media handling: the `assets` storage bucket is PRIVATE, so images are
 * downloaded here with the service-role bearer and persisted to
 * public/uploads/ — exactly what the generation pipeline does for provider
 * URLs, so imported references behave like generated ones (same-origin, CORS-
 * clean, re-uploadable to Seedance/FAL). Files are content-addressed by
 * storage path, so re-importing a project reuses what's already on disk.
 *
 * Videos keep their stored signed URL by default (they are signed until 2031
 * and can run to hundreds of MB per project); pass localizeVideos=1 to pull
 * them down too. Either way `supabase.co` is in the asset-proxy allowlist so
 * timeline export can still read them.
 */

interface SupabaseEnv {
  url: string
  key: string
  bucket: string
}

function readEnv(): SupabaseEnv | null {
  const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const bucket = process.env.SUPABASE_BUCKET_NAME || 'assets'
  if (!url || !key) return null
  return { url, key, bucket }
}

/** GET against PostgREST. The ONLY verb this module ever sends upstream. */
async function restGet<T = Record<string, unknown>>(
  env: SupabaseEnv,
  table: string,
  query: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ rows: T[]; contentRange: string | null }> {
  const url = `${env.url}/rest/v1/${table}?${query}`
  const resp = await fetch(url, {
    method: 'GET',
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, ...extraHeaders },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`supabase ${table} HTTP ${resp.status}: ${body.slice(0, 300)}`)
  }
  return { rows: (await resp.json()) as T[], contentRange: resp.headers.get('content-range') }
}

/** PostgREST `in.(...)` list. Values are uuids from our own earlier reads. */
function inList(ids: readonly string[]): string {
  return `(${ids.map((i) => `"${i}"`).join(',')})`
}

/**
 * Page through a PostgREST query until it stops returning a full page.
 *
 * Supabase caps every response at `db-max-rows` (1000 by default) and does it
 * SILENTLY — asking for `limit=2000` just gets you 1000 rows and no warning.
 * Anything that could legitimately exceed that (per-page count tallies across
 * 40 projects, a 10-episode project's frames) has to walk offsets.
 */
const PAGE = 1000

async function restGetAll<T = Record<string, unknown>>(
  env: SupabaseEnv,
  table: string,
  query: string,
): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { rows } = await restGet<T>(env, table, `${query}&limit=${PAGE}&offset=${offset}`)
    out.push(...rows)
    if (rows.length < PAGE) return out
    // Guard against a pathological table walk; nothing here is that large.
    if (out.length >= 20000) return out
  }
}

/** Chunked + paged `id=in.(...)` fetch — URLs blow past server limits past a few hundred ids. */
async function restGetIn<T = Record<string, unknown>>(
  env: SupabaseEnv,
  table: string,
  column: string,
  ids: readonly string[],
  select: string,
  extraQuery = '',
): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  const out: T[] = []
  for (let i = 0; i < unique.length; i += 120) {
    const chunk = unique.slice(i, i + 120)
    out.push(...(await restGetAll<T>(env, table, `select=${select}&${column}=in.${inList(chunk)}${extraQuery}`)))
  }
  return out
}

// ─── storage → public/uploads/ ────────────────────────────────────────

const EXT_BY_TYPE: Array<[RegExp, string]> = [
  [/jpeg|jpg/i, '.jpg'],
  [/webp/i, '.webp'],
  [/gif/i, '.gif'],
  [/mp4/i, '.mp4'],
  [/webm/i, '.webm'],
  [/quicktime|mov/i, '.mov'],
  [/png/i, '.png'],
]

function extFor(storagePath: string, contentType: string): string {
  const fromPath = storagePath.match(/\.([a-z0-9]{2,5})(?:$|\?)/i)?.[1]
  if (fromPath) return `.${fromPath.toLowerCase()}`
  for (const [re, ext] of EXT_BY_TYPE) if (re.test(contentType)) return ext
  return '.png'
}

/**
 * Extract the in-bucket object path from a stored signed URL, e.g.
 * `https://x.supabase.co/storage/v1/object/sign/assets/a/b/c.png?token=…`
 * → `a/b/c.png`. Returns '' for anything that isn't a signed bucket URL.
 */
export function storagePathFromSignedUrl(url: string, bucket = 'assets'): string {
  if (!url) return ''
  const m = url.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/]+)\/([^?]+)/)
  if (!m) return ''
  if (m[1] !== bucket) return ''
  try {
    return decodeURIComponent(m[2])
  } catch {
    return m[2]
  }
}

const uploadsDir = () => join(process.cwd(), 'public', 'uploads')

/**
 * Download one private-bucket object to public/uploads/ and return its
 * `/uploads/sv-<hash><ext>` path. Content-addressed by storage path, so a
 * second import of the same project is a no-op on disk.
 *
 * Best effort: on any failure returns '' and the caller falls back to
 * whatever remote URL it already had.
 */
async function localizeStorageObject(env: SupabaseEnv, storagePath: string): Promise<string> {
  if (!storagePath) return ''
  const hash = createHash('sha1').update(storagePath).digest('hex').slice(0, 24)
  const dir = uploadsDir()
  mkdirSync(dir, { recursive: true })
  const guessed = extFor(storagePath, '')
  const guessedName = `sv-${hash}${guessed}`
  if (existsSync(join(dir, guessedName))) return `/uploads/${guessedName}`
  try {
    const resp = await fetch(
      `${env.url}/storage/v1/object/${env.bucket}/${storagePath.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'GET', headers: { apikey: env.key, Authorization: `Bearer ${env.key}` } },
    )
    if (!resp.ok) {
      console.warn(`[storyverse] storage ${resp.status} for ${storagePath.slice(-60)}`)
      return ''
    }
    const ext = extFor(storagePath, resp.headers.get('content-type') ?? '')
    const filename = `sv-${hash}${ext}`
    const target = join(dir, filename)
    if (!existsSync(target)) {
      writeFileSync(target, Buffer.from(await resp.arrayBuffer()))
    }
    return `/uploads/${filename}`
  } catch (e) {
    console.warn(`[storyverse] storage error for ${storagePath.slice(-60)}: ${(e as Error).message}`)
    return ''
  }
}

/** Run `jobs` with at most `limit` in flight. Order-preserving results. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Localize a batch of storage paths, de-duplicated, returning path → /uploads url.
 * One shared map so a scene image referenced by 12 rows downloads once.
 */
async function localizeMany(env: SupabaseEnv, paths: readonly string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))]
  const urls = await pool(unique, 6, (p) => localizeStorageObject(env, p))
  const map: Record<string, string> = {}
  unique.forEach((p, i) => { if (urls[i]) map[p] = urls[i] })
  return map
}

// ─── row shapes coming back from PostgREST ───────────────────────────

interface DbProject { id: string; title: string | null; status: string | null; updated_at: string | null; created_at: string | null; cover_image_url: string | null }
interface DbEpisode { id: string; episode_number: number | null; title: string | null; summary: string | null }
interface DbFrame {
  id: string; episode_id: string | null; frame_number: number | null
  description: string | null; shot_type: string | null; prompt: string | null
  image_url: string | null; reference_image_urls: unknown
  duration_seconds: number | null; active_version_id: string | null; active_prompt_version_id: string | null
}
interface DbShot {
  id: string; frame_id: string | null; episode_id: string | null
  prompt: string | null; display_prompt: string | null; dialogue: string | null
  video_url: string | null; duration_seconds: number | null; active_prompt_version_id: string | null
}
interface DbAsset { id: string; category: string | null; name: string | null; canonical_prompt: string | null; active_version_id: string | null }
interface DbAssetVersion { id: string; asset_id: string | null; storage_path: string | null; legacy_image_url: string | null }
interface DbFrameVersion { id: string; image_url: string | null }
interface DbPromptVersion { id: string; plain_text: string | null }
interface DbScript { episode_id: string | null; content: string | null; updated_at: string | null }

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Read-only guard: these endpoints answer GET and nothing else. */
function requireGet(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET') return true
  sendJson(res, 405, { error: 'read-only endpoint: GET only' })
  return false
}

async function handleProjects(env: SupabaseEnv, req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url ?? '', 'http://x')
  const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit')) || 60))
  const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0)
  const q = (u.searchParams.get('q') ?? '').trim()

  // `is_deleted` is NOT NULL DEFAULT false on every table we read, so a plain
  // equality filter is exact — no need for the `or=(is.null,eq.false)` dance.
  const filters = ['is_deleted=eq.false']
  if (q) filters.push(`title=ilike.*${encodeURIComponent(q).replace(/\*/g, '')}*`)

  const { rows: projects, contentRange } = await restGet<DbProject>(
    env,
    'projects',
    `select=id,title,status,updated_at,created_at,cover_image_url&${filters.join('&')}` +
      `&order=updated_at.desc.nullslast&limit=${limit}&offset=${offset}`,
    { Prefer: 'count=estimated' },
  )

  const ids = projects.map((p) => p.id)
  // Counts for just this page: four bulk id-only reads, tallied here. The
  // PostgREST embedded-aggregate form (`episodes(count)`) statement-timeouts
  // on this database, so it is deliberately not used.
  const tally = async (table: string, extra = '') => {
    if (!ids.length) return {} as Record<string, number>
    const rows = await restGetIn<{ project_id: string }>(env, table, 'project_id', ids, 'project_id', extra)
    const counts: Record<string, number> = {}
    for (const r of rows) counts[r.project_id] = (counts[r.project_id] ?? 0) + 1
    return counts
  }
  // `frames` / `shots` count ROWS; `frameImages` / `shotVideos` count the ones
  // that actually carry media. Plenty of upstream projects went straight from
  // reference images to video and never rendered a storyboard frame, so the
  // list has to show both numbers — otherwise "13 分镜" sets the expectation of
  // 13 storyboard images that the database simply does not have.
  const [eps, frames, frameImages, shots, shotVideos, assets] = await Promise.all([
    tally('episodes', '&is_deleted=eq.false'),
    tally('storyboard_frames', '&is_deleted=eq.false'),
    tally('storyboard_frames', '&is_deleted=eq.false&image_url=not.is.null'),
    tally('shots'),
    tally('shots', '&video_url=not.is.null'),
    tally('assets', '&is_deleted=eq.false'),
  ])

  sendJson(res, 200, {
    projects: projects.map((p) => ({
      id: p.id,
      title: p.title ?? '(未命名项目)',
      status: p.status ?? '',
      updatedAt: p.updated_at ?? p.created_at ?? '',
      createdAt: p.created_at ?? '',
      coverImageUrl: p.cover_image_url ?? '',
      episodes: eps[p.id] ?? 0,
      frames: frames[p.id] ?? 0,
      frameImages: frameImages[p.id] ?? 0,
      shots: shots[p.id] ?? 0,
      shotVideos: shotVideos[p.id] ?? 0,
      assets: assets[p.id] ?? 0,
    })),
    total: Number(contentRange?.split('/')?.[1]) || null,
    limit,
    offset,
  })
}

async function handleProject(env: SupabaseEnv, req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url ?? '', 'http://x')
  const id = (u.searchParams.get('id') ?? '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    sendJson(res, 400, { error: 'missing or malformed ?id=<uuid>' })
    return
  }
  const localizeVideos = u.searchParams.get('localizeVideos') === '1'
  const started = Date.now()

  const [{ rows: projectRows }, episodes, frames, shots, assets, scripts] =
    await Promise.all([
      restGet<DbProject>(env, 'projects', `select=id,title,status,updated_at,created_at&id=eq.${id}`),
      restGetAll<DbEpisode>(env, 'episodes', `select=id,episode_number,title,summary&project_id=eq.${id}&is_deleted=eq.false&order=episode_number.asc`),
      restGetAll<DbFrame>(env, 'storyboard_frames', `select=id,episode_id,frame_number,description,shot_type,prompt,image_url,reference_image_urls,duration_seconds,active_version_id,active_prompt_version_id&project_id=eq.${id}&is_deleted=eq.false&order=frame_number.asc`),
      restGetAll<DbShot>(env, 'shots', `select=id,frame_id,episode_id,prompt,display_prompt,dialogue,video_url,duration_seconds,active_prompt_version_id&project_id=eq.${id}&order=id.asc`),
      restGetAll<DbAsset>(env, 'assets', `select=id,category,name,canonical_prompt,active_version_id&project_id=eq.${id}&is_deleted=eq.false&order=category.asc`),
      restGetAll<DbScript>(env, 'scripts', `select=episode_id,content,updated_at&project_id=eq.${id}&order=episode_id.asc`),
    ])

  const project = projectRows[0]
  if (!project) {
    sendJson(res, 404, { error: `project ${id} not found` })
    return
  }

  // Asset images live behind active_version_id → asset_versions.storage_path.
  // Fetch EVERY version, not just the active one: a frame's reference images
  // point at whatever version was current when it was composed, and 13% of all
  // reference URLs upstream resolve to a superseded version. Indexing only
  // active versions silently dropped those references (empty 角色/道具/场景
  // slots on rows whose storyboard clearly used an image).
  const assetVersions = await restGetIn<DbAssetVersion>(
    env, 'asset_versions', 'asset_id', assets.map((a) => a.id),
    'id,asset_id,storage_path,legacy_image_url',
  )
  const versionById = new Map(assetVersions.map((v) => [v.id, v]))
  const assetById = new Map(assets.map((a) => [a.id, a]))
  /** storage path → the asset it belongs to, across ALL of its versions. */
  const assetByPath = new Map<string, DbAsset>()
  for (const v of assetVersions) {
    if (!v.storage_path || !v.asset_id) continue
    const a = assetById.get(v.asset_id)
    if (a) assetByPath.set(v.storage_path, a)
  }

  // Frames whose image_url is null may still have an active version carrying one.
  const frameVersions = await restGetIn<DbFrameVersion>(
    env, 'storyboard_frame_versions', 'id',
    frames.filter((f) => !f.image_url).map((f) => f.active_version_id ?? '').filter(Boolean),
    'id,image_url',
  )
  const frameVersionById = new Map(frameVersions.map((v) => [v.id, v]))

  // Active prompt versions win over the denormalized `prompt` columns.
  const promptVersions = await restGetIn<DbPromptVersion>(
    env, 'prompt_versions', 'id',
    [...frames.map((f) => f.active_prompt_version_id ?? ''), ...shots.map((s) => s.active_prompt_version_id ?? '')].filter(Boolean),
    'id,plain_text',
  )
  const promptTextById = new Map(promptVersions.map((p) => [p.id, p.plain_text ?? '']))

  // ─── collect every storage path we want on disk ───
  const assetPaths: string[] = []
  for (const a of assets) {
    const v = a.active_version_id ? versionById.get(a.active_version_id) : undefined
    if (v?.storage_path) assetPaths.push(v.storage_path)
  }
  const framePaths: string[] = []
  const frameImageUrl = (f: DbFrame): string =>
    f.image_url || (f.active_version_id ? frameVersionById.get(f.active_version_id)?.image_url ?? '' : '')
  for (const f of frames) {
    const p = storagePathFromSignedUrl(frameImageUrl(f), env.bucket)
    if (p) framePaths.push(p)
  }
  // Every distinct reference image the storyboard actually used — including
  // superseded asset versions, which have no other route onto the canvas.
  const refPaths: string[] = []
  for (const f of frames) {
    const urls = Array.isArray(f.reference_image_urls) ? (f.reference_image_urls as unknown[]) : []
    for (const u of urls) {
      if (typeof u !== 'string') continue
      const p = storagePathFromSignedUrl(u, env.bucket)
      if (p) refPaths.push(p)
    }
  }
  const videoPaths: string[] = []
  if (localizeVideos) {
    for (const s of shots) {
      const p = storagePathFromSignedUrl(s.video_url ?? '', env.bucket)
      if (p) videoPaths.push(p)
    }
  }
  const localized = await localizeMany(env, [...assetPaths, ...framePaths, ...refPaths, ...videoPaths])

  // ─── shape the bundle ───
  const episodeById = new Map(episodes.map((e) => [e.id, e]))
  const shotsByFrame = new Map<string, DbShot>()
  for (const s of shots) {
    if (!s.frame_id) continue
    // Several shot rows can point at one frame; keep the one with a video.
    const prev = shotsByFrame.get(s.frame_id)
    if (!prev || (!prev.video_url && s.video_url)) shotsByFrame.set(s.frame_id, s)
  }

  const outAssets = assets.map((a) => {
    const v = a.active_version_id ? versionById.get(a.active_version_id) : undefined
    const storagePath = v?.storage_path ?? ''
    return {
      id: a.id,
      category: a.category ?? '',
      name: a.name ?? '(未命名素材)',
      prompt: a.canonical_prompt ?? '',
      storagePath,
      imageUrl: (storagePath && localized[storagePath]) || v?.legacy_image_url || '',
    }
  })

  const outRows = frames.map((f) => {
    const shot = shotsByFrame.get(f.id)
    const ep = f.episode_id ? episodeById.get(f.episode_id) : undefined
    const refUrls = Array.isArray(f.reference_image_urls) ? (f.reference_image_urls as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const kfPath = storagePathFromSignedUrl(frameImageUrl(f), env.bucket)
    const videoPath = storagePathFromSignedUrl(shot?.video_url ?? '', env.bucket)
    const references = refUrls.map((raw) => {
      const path = storagePathFromSignedUrl(raw, env.bucket)
      const asset = path ? assetByPath.get(path) : undefined
      return {
        path,
        // Localized when we could download it; otherwise the stored signed URL
        // (valid for years) so the image still shows rather than vanishing.
        url: (path && localized[path]) || raw,
        assetId: asset?.id ?? '',
        assetName: asset?.name ?? '',
        assetCategory: asset?.category ?? '',
        /** False when this is a superseded version of the asset. */
        isActiveVersion: Boolean(asset && asset.active_version_id
          && versionById.get(asset.active_version_id)?.storage_path === path),
      }
    })
    return {
      frameId: f.id,
      shotId: shot?.id ?? '',
      episodeNumber: ep?.episode_number ?? 1,
      episodeTitle: ep?.title ?? '',
      frameNumber: f.frame_number ?? 0,
      shotType: f.shot_type ?? '',
      description: f.description ?? '',
      framePrompt: (f.active_prompt_version_id ? promptTextById.get(f.active_prompt_version_id) : '') || f.prompt || '',
      shotPrompt: (shot?.active_prompt_version_id ? promptTextById.get(shot.active_prompt_version_id) : '') || shot?.prompt || '',
      displayPrompt: shot?.display_prompt ?? '',
      dialogue: shot?.dialogue ?? '',
      durationSeconds: shot?.duration_seconds ?? f.duration_seconds ?? 0,
      keyframeUrl: (kfPath && localized[kfPath]) || frameImageUrl(f) || '',
      videoUrl: (videoPath && localized[videoPath]) || shot?.video_url || '',
      references,
    }
  })
  outRows.sort((a, b) => a.episodeNumber - b.episodeNumber || a.frameNumber - b.frameNumber)

  const scriptByEpisode = new Map<string, DbScript>()
  for (const s of scripts) {
    if (!s.episode_id) continue
    const prev = scriptByEpisode.get(s.episode_id)
    if (!prev || (s.updated_at ?? '') > (prev.updated_at ?? '')) scriptByEpisode.set(s.episode_id, s)
  }

  sendJson(res, 200, {
    project: {
      id: project.id,
      title: project.title ?? '(未命名项目)',
      status: project.status ?? '',
      updatedAt: project.updated_at ?? '',
    },
    episodes: episodes.map((e) => ({
      id: e.id,
      number: e.episode_number ?? 1,
      title: e.title ?? '',
      summary: e.summary ?? '',
      script: (e.id && scriptByEpisode.get(e.id)?.content) || '',
    })),
    assets: outAssets,
    rows: outRows,
    stats: {
      localizedFiles: Object.keys(localized).length,
      videosLocalized: localizeVideos,
      elapsedMs: Date.now() - started,
    },
  })
}

export function storyversePlugin(): Plugin {
  return {
    name: 'storyverse-import',
    configureServer(server) {
      const guard = (
        handler: (env: SupabaseEnv, req: IncomingMessage, res: ServerResponse) => Promise<void>,
      ) => async (req: IncomingMessage, res: ServerResponse) => {
        if (!requireGet(req, res)) return
        const env = readEnv()
        if (!env) {
          sendJson(res, 503, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env' })
          return
        }
        try {
          await handler(env, req, res)
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e)
          console.error('[storyverse]', msg)
          if (!res.headersSent) sendJson(res, 502, { error: msg })
          else try { res.end() } catch { /* noop */ }
        }
      }

      server.middlewares.use('/storyverse/projects', guard(handleProjects))
      server.middlewares.use('/storyverse/project', guard(handleProject))
    },
  }
}
