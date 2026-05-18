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
 *   GET  /local-session   → { snapshot: { [storeName]: stringifiedJson, ... } | null, savedAt: ISO | null }
 *   POST /local-session   → body { snapshot: { ... } }, returns { savedAt }
 *
 * Storage: public/sessions/<sha256(ip).slice(0,16)>.json
 *   IP-derived hash so we don't write the raw IP to disk. Hash is
 *   8 bytes / 16 hex chars — collisions are vanishingly unlikely for a
 *   handful of local devs, plenty of room for solo / small-team use.
 *
 * Caveats (called out in PR)
 *   - Multiple devices behind the same NAT (e.g. home router) share one
 *     session bucket. Last-writer-wins. For a single dev that's fine;
 *     production would want a cookie-based session token instead.
 *   - The snapshot is whatever the client POSTs. We don't try to merge
 *     across stores — too risky to interleave half-snapshots.
 */

import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'fs'
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

function sessionFilePath(req: IncomingMessage): string {
  const ip = clientIp(req)
  const id = createHash('sha256').update(ip).digest('hex').slice(0, 16)
  return join(sessionsDir(), `${id}.json`)
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

export function sessionSnapshotPlugin(): Plugin {
  return {
    name: 'session-snapshot',
    configureServer(server) {
      // Make sure the sessions dir exists once at startup so we never
      // have to mkdir mid-request.
      try { mkdirSync(sessionsDir(), { recursive: true }) } catch { /* best-effort */ }

      server.middlewares.use('/local-session', async (req, res) => {
        const file = sessionFilePath(req)

        if (req.method === 'GET') {
          if (!existsSync(file)) {
            sendJson(res, 200, { snapshot: null, savedAt: null })
            return
          }
          try {
            const raw = readFileSync(file, 'utf8')
            const stat = statSync(file)
            const parsed = JSON.parse(raw) as { snapshot: Record<string, string>; savedAt?: string }
            sendJson(res, 200, {
              snapshot: parsed.snapshot ?? null,
              savedAt: parsed.savedAt ?? stat.mtime.toISOString(),
            })
          } catch (e) {
            sendJson(res, 500, { error: `session read failed: ${(e as Error).message}` })
          }
          return
        }

        if (req.method === 'POST') {
          try {
            const buf = await readBody(req)
            if (buf.length > MAX_SNAPSHOT_BYTES) {
              sendJson(res, 413, { error: `snapshot too large (${buf.length} bytes > ${MAX_SNAPSHOT_BYTES})` })
              return
            }
            const json = JSON.parse(buf.toString('utf8')) as { snapshot?: Record<string, string> }
            if (!json.snapshot || typeof json.snapshot !== 'object') {
              sendJson(res, 400, { error: 'body must be { snapshot: { storeName: jsonString, ... } }' })
              return
            }
            const savedAt = new Date().toISOString()
            writeFileSync(file, JSON.stringify({ snapshot: json.snapshot, savedAt }), 'utf8')
            sendJson(res, 200, { savedAt })
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
