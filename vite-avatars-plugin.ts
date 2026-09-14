import type { Plugin } from 'vite'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'

/**
 * Dev-server endpoints for the virtual-avatar (虚拟人像库) character picker.
 *
 * BytePlus exposes NO public list API for its platform avatar library — the
 * avatars live behind the authenticated Model Playground. So the catalog is
 * stored locally (populated by scraping the user's logged-in session, or by
 * pasting entries in the picker) and served from here:
 *
 *   GET  /virtual-avatars/list    → { avatars: VirtualAvatarAsset[] }
 *   POST /virtual-avatars/import  → { avatars } | { replace?, avatars } → persist
 *
 * The catalog file is a plain JSON array of VirtualAvatarAsset
 * (src/lib/virtual-avatar-library/types.ts). Stored gitignored so real avatar
 * ids don't get committed.
 */

const CATALOG_PATH = path.resolve(process.cwd(), 'public', 'virtual-avatars.json')

interface AvatarEntry {
  id: string
  name?: string
  uri?: string
  gender?: string
  ageMin?: number
  ageMax?: number
  nationality?: string
  tags?: string[]
}

function readCatalog(): AvatarEntry[] {
  if (!existsSync(CATALOG_PATH)) return []
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Keep only well-formed entries (must have an id). De-dupe by id, last wins. */
function sanitize(entries: unknown): AvatarEntry[] {
  if (!Array.isArray(entries)) return []
  const byId = new Map<string, AvatarEntry>()
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const id = (e as AvatarEntry).id
    if (typeof id !== 'string' || !id.trim()) continue
    byId.set(id, e as AvatarEntry)
  }
  return [...byId.values()]
}

async function readJson(req: import('http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

// ─── cURL scraping (avatar library, user's logged-in session) ──────────
// We re-issue a pasted cURL via fetch() rather than shelling out, so a pasted
// string can't inject shell commands. Only the parsed url/method/headers/body
// are used.

interface ParsedCurl {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** Tokenize a shell-ish command respecting single/double quotes. */
function tokenizeCurl(input: string): string[] {
  const out: string[] = []
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) {
    out.push(m[1] ?? (m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3]!))
  }
  return out
}

function parseCurl(curl: string): ParsedCurl {
  const tokens = tokenizeCurl(curl.replace(/\\\n/g, ' ').trim())
  let url = ''
  let method = ''
  let body: string | undefined
  const headers: Record<string, string> = {}
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'curl') continue
    if (t === '-X' || t === '--request') { method = tokens[++i] ?? method }
    else if (t === '-H' || t === '--header') {
      const h = tokens[++i] ?? ''
      const idx = h.indexOf(':')
      if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      body = tokens[++i]
    } else if (t === '-b' || t === '--cookie') {
      headers['cookie'] = tokens[++i] ?? ''
    } else if (t.startsWith('http://') || t.startsWith('https://')) {
      url = t
    }
    // other flags (-s, --compressed, --location, ...) are ignored
  }
  if (!method) method = body ? 'POST' : 'GET'
  return { url, method, headers, body }
}

const PAGE_KEYS = ['PageNumber', 'pageNumber', 'pageNum', 'PageNo', 'pageNo', 'page', 'Page']

/** Generic item extractor for pagination "is this page empty?" checks. */
function extractItemsLoose(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  const o = data as Record<string, unknown>
  const r = o.Result as Record<string, unknown> | undefined
  const d = o.data as Record<string, unknown> | undefined
  for (const c of [r?.Items, r?.Assets, d?.list, d?.items, d?.Items, o.Items, o.items, o.list, o.data, o.assets]) {
    if (Array.isArray(c)) return c
  }
  return []
}

/** Run a parsed cURL, auto-incrementing a page field in the JSON body if present. */
async function runScrape(curl: string, maxPages = 50): Promise<{ items: unknown[]; pages: number }> {
  const p = parseCurl(curl)
  if (!p.url) throw new Error('could not parse a URL from the cURL')

  let bodyObj: Record<string, unknown> | null = null
  if (p.body) { try { bodyObj = JSON.parse(p.body) } catch { bodyObj = null } }
  const pageKey = bodyObj ? PAGE_KEYS.find((k) => typeof bodyObj![k] === 'number') : undefined

  const items: unknown[] = []
  let pages = 0
  for (let page = 1; page <= (pageKey ? maxPages : 1); page++) {
    if (bodyObj && pageKey) bodyObj[pageKey] = page
    const res = await fetch(p.url, {
      method: p.method,
      headers: p.headers,
      body: p.method === 'GET' ? undefined : (bodyObj ? JSON.stringify(bodyObj) : p.body),
    })
    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`upstream ${res.status}: ${txt.slice(0, 300)}`)
    }
    const data = await res.json()
    const batch = extractItemsLoose(data)
    pages = page
    if (batch.length === 0) break
    items.push(...batch)
    if (!pageKey) break
  }
  return { items, pages }
}

export function avatarsPlugin(): Plugin {
  return {
    name: 'virtual-avatars-api',
    configureServer(server) {
      server.middlewares.use('/virtual-avatars/list', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ avatars: readCatalog() }))
      })

      server.middlewares.use('/virtual-avatars/import', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return }
        res.setHeader('Content-Type', 'application/json')
        try {
          const body = await readJson(req)
          const incoming = sanitize(body.avatars)
          if (incoming.length === 0) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'no valid avatars (each needs a string id)' }))
            return
          }
          // replace = swap the whole catalog; otherwise merge (incoming wins on id).
          const merged = body.replace
            ? incoming
            : sanitize([...readCatalog(), ...incoming])
          writeFileSync(CATALOG_PATH, JSON.stringify(merged, null, 2))
          res.end(JSON.stringify({ ok: true, count: merged.length, added: incoming.length }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String((e as Error)?.message ?? e) }))
        }
      })

      // Run a pasted cURL (the avatar-list request from the user's logged-in
      // Model Playground) and return the RAW items. The client maps them with
      // the tested mapByteplusAssets() and POSTs to /import — keeping the
      // shape-mapping in unit-tested TS rather than duplicated here.
      server.middlewares.use('/virtual-avatars/scrape', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return }
        res.setHeader('Content-Type', 'application/json')
        try {
          const body = await readJson(req)
          const curl = typeof body.curl === 'string' ? body.curl : ''
          if (!curl.trim()) { res.statusCode = 400; res.end(JSON.stringify({ error: 'curl required' })); return }
          const { items, pages } = await runScrape(curl)
          res.end(JSON.stringify({ ok: true, items, pages }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String((e as Error)?.message ?? e) }))
        }
      })
    },
  }
}
