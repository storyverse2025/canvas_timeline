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

function listAllSessions(): SessionListItem[] {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []
  const out: SessionListItem[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const full = join(dir, name)
    const stat = statSync(full)
    const data = readSessionFile(full)
    if (!data || !data.snapshot) continue
    out.push({
      id: name.replace(/\.json$/, ''),
      ip: data.ip ?? '(unknown)',
      savedAt: data.savedAt ?? stat.mtime.toISOString(),
      sizeBytes: stat.size,
      previewTitle: data.previewTitle ?? derivePreviewTitle(data.snapshot),
    })
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
            sendJson(res, 200, { snapshot: null, savedAt: null })
            return
          }
          const data = readSessionFile(file)
          if (!data) { sendJson(res, 500, { error: 'session unreadable' }); return }
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
            const ip = clientIp(req)
            const out: SessionFileShape = {
              snapshot: json.snapshot,
              savedAt: new Date().toISOString(),
              ip,
              previewTitle: derivePreviewTitle(json.snapshot),
            }
            writeFileSync(file, JSON.stringify(out), 'utf8')
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
