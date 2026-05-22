/**
 * Per-IP server-side session snapshot — belt-and-braces backup for the
 * IDB-persisted Zustand stores.
 *
 * Motivation: even after hardening the IDB adapter
 * (src/lib/storage/idb-storage.ts), the user lost everything after
 * laptop sleep mid-generation. Browser tabs sometimes get discarded
 * during long sleep + memory pressure, and in-flight IDB writes don't
 * always make it to disk on resume. Mirroring the snapshot server-side
 * means the next page load (same machine, same network) can fall back
 * to whatever the server has when IDB comes up empty.
 *
 * Endpoints
 *   GET  /local-session              → current caller's snapshot
 *                                       { snapshot|null, savedAt|null }
 *   POST /local-session              → save caller's snapshot
 *                                       (accepts gzip via Content-Encoding)
 *                                       returns { savedAt, bytesIn, bytesUncompressed }
 *   GET  /local-session/list         → all sessions on disk (for the picker UI)
 *                                       [{ id, ip, savedAt, sizeBytes, previewTitle }, …]
 *   GET  /local-session/by-id/<id>   → snapshot for a specific session id
 *                                       (id = the hashed-IP filename prefix)
 *
 * Storage: public/sessions/<sha256(ip).slice(0,16)>.json
 *   File content also embeds the raw IP + a derived preview title so
 *   the picker UI can show which session is which without forcing the
 *   user to read a 16-char hex blob. Acceptable for a local dev tool;
 *   production deployments should swap to a cookie-based session token.
 */

import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

const SESSIONS_DIR_PARTS = ['public', 'sessions']

function sessionsDir(): string {
  return join(process.cwd(), ...SESSIONS_DIR_PARTS)
}

function clientIp(req: IncomingMessage): string {
  // x-forwarded-for is set by reverse proxies (nginx upstream). Take the
  // first hop — that's the real client. Fall back to socket address.
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? '0.0.0.0'
}

function idForIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16)
}

function sessionFilePath(req: IncomingMessage): string {
  return join(sessionsDir(), `${idForIp(clientIp(req))}.json`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024 // 100 MB hard ceiling per session

/** Best-effort title for the picker — peeks at project-db's script.text
 *  or the first canvas item name. Pure string operations on the stored
 *  snapshot, so we don't have to keep a separate index. */
function derivePreviewTitle(snapshot: Record<string, string>): string {
  try {
    const proj = snapshot['project-db']
    if (proj) {
      const parsed = JSON.parse(proj) as { state?: { script?: { text?: string } } }
      const text = parsed.state?.script?.text?.replace(/\s+/g, ' ').trim()
      if (text) return text.slice(0, 60) + (text.length > 60 ? '…' : '')
    }
  } catch { /* fall through */ }
  try {
    const items = snapshot['canvas-item-store']
    if (items) {
      const parsed = JSON.parse(items) as { state?: { items?: Record<string, { name?: string }> } }
      const first = Object.values(parsed.state?.items ?? {})[0]
      if (first?.name) return first.name
    }
  } catch { /* fall through */ }
  return '(Untitled session)'
}

interface SessionFileShape {
  snapshot: Record<string, string>
  savedAt: string
  ip?: string
  previewTitle?: string
}

interface SessionListItem {
  id: string
  ip: string
  savedAt: string
  sizeBytes: number
  previewTitle: string
}

function readSessionFile(file: string): SessionFileShape | null {
  try {
    const raw = readFileSync(file, 'utf8')
    return JSON.parse(raw) as SessionFileShape
  } catch {
    return null
  }
}

/** Sidecar metadata file path. Stored as `<id>.meta.json` next to the
 *  main snapshot. Listing the picker UI parses only the tiny sidecars
 *  instead of the 50 MB snapshot bodies. */
function metaFilePath(snapshotFile: string): string {
  return snapshotFile.replace(/\.json$/, '.meta.json')
}

/**
 * Write a separate JSON file containing only the listing metadata.
 * Done synchronously immediately after the snapshot itself is written,
 * so the picker's GET /list never has to read the heavy snapshot to
 * pull out savedAt / ip / previewTitle / size.
 */
function writeSidecarMeta(snapshotFile: string, meta: Omit<SessionListItem, 'sizeBytes'> & { sizeBytes: number }): void {
  try {
    writeFileSync(metaFilePath(snapshotFile), JSON.stringify(meta), 'utf8')
  } catch { /* best-effort; list falls back to full parse if missing */ }
}

function readSidecarMeta(snapshotFile: string): SessionListItem | null {
  const mf = metaFilePath(snapshotFile)
  if (!existsSync(mf)) return null
  try {
    return JSON.parse(readFileSync(mf, 'utf8')) as SessionListItem
  } catch {
    return null
  }
}

function listAllSessions(): SessionListItem[] {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []
  const out: SessionListItem[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue
    const full = join(dir, name)
    const stat = statSync(full)
    const id = name.replace(/\.json$/, '')

    // Fast path: sidecar metadata. No big-file parse.
    const sidecar = readSidecarMeta(full)
    if (sidecar) {
      out.push({ ...sidecar, id, sizeBytes: stat.size })
      continue
    }

    // Slow legacy path: read + parse the full snapshot to back-fill
    // metadata for files written before the sidecar existed. Once we
    // see one, we eagerly write the sidecar so the next /list is fast.
    const data = readSessionFile(full)
    if (!data || !data.snapshot) continue
    const item: SessionListItem = {
      id,
      ip: data.ip ?? '(unknown)',
      savedAt: data.savedAt ?? stat.mtime.toISOString(),
      sizeBytes: stat.size,
      previewTitle: data.previewTitle ?? derivePreviewTitle(data.snapshot),
    }
    writeSidecarMeta(full, item)
    out.push(item)
  }
  out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  return out
}

export function sessionSnapshotPlugin(): Plugin {
  return {
    name: 'session-snapshot',
    configureServer(server) {
      // Make sure the sessions dir exists once at startup so we never
      // have to mkdir mid-request.
      try { mkdirSync(sessionsDir(), { recursive: true }) } catch { /* best-effort */ }

      server.middlewares.use('/local-session', async (req, res) => {
        // Sub-routes off /local-session — order matters: /list before /by-id
        // before bare /local-session so prefixes don't shadow each other.
        const url = req.url ?? '/'

        if (req.method === 'GET' && (url === '/list' || url.startsWith('/list?'))) {
          try {
            sendJson(res, 200, { sessions: listAllSessions() })
          } catch (e) {
            sendJson(res, 500, { error: `list failed: ${(e as Error).message}` })
          }
          return
        }

        const byIdMatch = url.match(/^\/by-id\/([a-f0-9]{1,64})(?:\?.*)?$/i)
        if (req.method === 'GET' && byIdMatch) {
          const id = byIdMatch[1]
          const file = join(sessionsDir(), `${id}.json`)
          if (!existsSync(file)) { sendJson(res, 404, { error: 'session not found' }); return }
          const data = readSessionFile(file)
          if (!data) { sendJson(res, 500, { error: 'session unreadable' }); return }
          sendJson(res, 200, { snapshot: data.snapshot, savedAt: data.savedAt })
          return
        }

        const file = sessionFilePath(req)

        if (req.method === 'GET') {
          if (!existsSync(file)) {
            console.log(`[session] GET miss (no file) ip=${clientIp(req)}`)
            sendJson(res, 200, { snapshot: null, savedAt: null })
            return
          }
          const stat = statSync(file)
          const data = readSessionFile(file)
          if (!data) { sendJson(res, 500, { error: 'session unreadable' }); return }
          // Per-store size breakdown so we can spot the bloated one in
          // the dev console. Inline data URLs in canvas-item-store have
          // been the single biggest source of memory pressure on the
          // client (4K base64 images stayed in the snapshot forever).
          const sizes: string[] = []
          for (const [k, v] of Object.entries(data.snapshot ?? {})) {
            const len = typeof v === 'string' ? v.length : JSON.stringify(v).length
            sizes.push(`${k}=${(len/1024).toFixed(0)}KB`)
          }
          console.log(`[session] GET serving ${(stat.size/1024).toFixed(0)}KB savedAt=${data.savedAt} :: ${sizes.join(' ')}`)
          sendJson(res, 200, { snapshot: data.snapshot, savedAt: data.savedAt })
          return
        }

        if (req.method === 'POST') {
          try {
            const buf = await readBody(req)
            if (buf.length > MAX_SNAPSHOT_BYTES) {
              sendJson(res, 413, { error: `snapshot too large (${buf.length} bytes > ${MAX_SNAPSHOT_BYTES})` })
              return
            }
            // Client may gzip-compress to fit under nginx's body limit
            // (default 50 MB, raised to 200 MB here, but compression
            // still buys 5-10× headroom for big canvases).
            let rawJson: string
            const encoding = (req.headers['content-encoding'] ?? '').toString().toLowerCase()
            if (encoding === 'gzip') {
              const { gunzipSync } = await import('zlib')
              rawJson = gunzipSync(buf).toString('utf8')
            } else {
              rawJson = buf.toString('utf8')
            }
            const json = JSON.parse(rawJson) as { snapshot?: Record<string, string> }
            if (!json.snapshot || typeof json.snapshot !== 'object') {
              sendJson(res, 400, { error: 'body must be { snapshot: { storeName: jsonString, ... } }' })
              return
            }

            // Per-store size breakdown + inline-data-URL guard. If any
            // canvas-item-store payload still contains `data:image/...`
            // base64 content, log a loud warning — those were the
            // smoking gun for a 4GB Chrome OOM (4 items × ~2-14MB
            // each → 19MB snapshot → ~40MB after parse + duplicate
            // copies → blown heap). We don't reject (the client may
            // still legitimately store small data URLs for icons /
            // SVGs), but we make the diagnostic loud.
            const sizes: string[] = []
            let inlineCount = 0
            let inlineBytes = 0
            for (const [k, v] of Object.entries(json.snapshot)) {
              if (typeof v !== 'string') continue
              sizes.push(`${k}=${(v.length/1024).toFixed(0)}KB`)
              if (k === 'canvas-item-store' || k === 'asset-store') {
                // Count occurrences of inline `data:image/` content.
                // Match the canvas-item-store JSON structure: `"content":"data:image/..."`
                const matches = v.match(/"content"\s*:\s*"data:image\/[^"]{1000,}/g)
                if (matches) {
                  inlineCount += matches.length
                  inlineBytes += matches.reduce((s, m) => s + m.length, 0)
                }
              }
            }
            console.log(`[session] POST ${(rawJson.length/1024).toFixed(0)}KB :: ${sizes.join(' ')}`)
            if (inlineCount > 0) {
              console.warn(`[session] ⚠️  ${inlineCount} inline data: URL(s) in store payload (~${(inlineBytes/1024/1024).toFixed(1)}MB) — these blow up client heap on next rehydrate. Migration to /uploads/ should run on next load.`)
            }

            // SHRINK PROTECTION: refuse to clobber an existing fat
            // snapshot with a tiny one unless the client explicitly
            // opts in. User reported a real-world data loss where a
            // 53 MB snapshot got overwritten by a 1.5 KB one because
            // some render fired a backup before Zustand had hydrated.
            // Threshold: incoming is < 25% of existing AND existing
            // is > 100 KB. Override with header `x-allow-shrink: 1`
            // (used by the Session picker's explicit "Load this"
            // action, which intends to replace).
            const allowShrink = (req.headers['x-allow-shrink'] ?? '').toString() === '1'
            if (!allowShrink && existsSync(file)) {
              const prevStat = statSync(file)
              if (prevStat.size > 100 * 1024 && rawJson.length < prevStat.size * 0.25) {
                sendJson(res, 409, {
                  error: `shrink-overwrite blocked: incoming ${rawJson.length}B would replace existing ${prevStat.size}B (>4× shrink). Send x-allow-shrink:1 to force.`,
                  existingSize: prevStat.size,
                  incomingSize: rawJson.length,
                })
                return
              }
            }

            const ip = clientIp(req)
            const out: SessionFileShape = {
              snapshot: json.snapshot,
              savedAt: new Date().toISOString(),
              ip,
              previewTitle: derivePreviewTitle(json.snapshot),
            }
            writeFileSync(file, JSON.stringify(out), 'utf8')
            // Sidecar for the picker's /list — avoids re-parsing the
            // 50 MB snapshot on every listing.
            const stat = statSync(file)
            writeSidecarMeta(file, {
              id: file.split('/').pop()!.replace(/\.json$/, ''),
              ip, savedAt: out.savedAt, previewTitle: out.previewTitle ?? '',
              sizeBytes: stat.size,
            })
            sendJson(res, 200, { savedAt: out.savedAt, bytesIn: buf.length, bytesUncompressed: rawJson.length })
          } catch (e) {
            sendJson(res, 500, { error: `session write failed: ${(e as Error).message}` })
          }
          return
        }

        sendJson(res, 405, { error: 'GET or POST only' })
      })
    },
  }
}
