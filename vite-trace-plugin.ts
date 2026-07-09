/**
 * Trace store (HarnessX D8 observability) — append-only JSONL sink for
 * capability-invocation traces emitted by src/lib/capabilities/client.ts.
 *
 * Endpoints
 *   POST /traces/append           → append one trace record (fire-and-forget
 *                                   from callers; always 200 unless body is
 *                                   unparseable — a broken trace must never
 *                                   break a generation)
 *   GET  /traces/query?runId=&caseId=&source=&since=&limit=
 *                                 → filtered rows, newest-last (Digester input)
 *   GET  /traces/harness-version  → { sha, branch, dirty } of the working tree
 *
 * Storage: evolution/traces/traces-YYYYMMDD.jsonl (gitignored). The trace
 * store only ever grows — AEGIS ships or rejects harness edits, but the
 * evidence is kept either way.
 */

import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

const TRACES_DIR_PARTS = ['evolution', 'traces']
const MAX_BODY_BYTES = 10 * 1024 * 1024

function tracesDir(): string {
  return join(process.cwd(), ...TRACES_DIR_PARTS)
}

function traceFileForToday(): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return join(tracesDir(), `traces-${stamp}.jsonl`)
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

/** Resolved lazily per request (cheap) so traces stamped mid-evolution pick
 *  up the candidate checkout, not the sha at server boot. */
function harnessVersion(): { sha: string; branch: string; dirty: boolean } {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0
    return { sha, branch, dirty }
  } catch {
    return { sha: 'unknown', branch: 'unknown', dirty: false }
  }
}

interface TraceRow {
  ts?: number
  runId?: string
  caseId?: string
  source?: string
  [k: string]: unknown
}

function queryTraces(params: URLSearchParams): TraceRow[] {
  const dir = tracesDir()
  if (!existsSync(dir)) return []
  const runId = params.get('runId')
  const caseId = params.get('caseId')
  const source = params.get('source')
  const since = Number(params.get('since') ?? 0)
  const limit = Math.min(Number(params.get('limit') ?? 2000), 20000)

  const out: TraceRow[] = []
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let row: TraceRow
      try {
        row = JSON.parse(line) as TraceRow
      } catch {
        continue
      }
      if (runId && row.runId !== runId) continue
      if (caseId && row.caseId !== caseId) continue
      if (source && row.source !== source) continue
      if (since && (row.ts ?? 0) < since) continue
      out.push(row)
    }
  }
  return out.slice(-limit)
}

export function tracePlugin(): Plugin {
  return {
    name: 'evolution-traces',
    configureServer(server) {
      try { mkdirSync(tracesDir(), { recursive: true }) } catch { /* best-effort */ }

      server.middlewares.use('/traces', async (req, res) => {
        const url = req.url ?? '/'

        if (req.method === 'POST' && (url === '/append' || url.startsWith('/append?'))) {
          try {
            const buf = await readBody(req)
            if (buf.length > MAX_BODY_BYTES) {
              sendJson(res, 200, { ok: false, error: 'trace too large, dropped' })
              return
            }
            const row = JSON.parse(buf.toString('utf8')) as TraceRow
            if (!row.ts) row.ts = Date.now()
            if (!row.harnessVersion) row.harnessVersion = harnessVersion()
            appendFileSync(traceFileForToday(), JSON.stringify(row) + '\n', 'utf8')
            sendJson(res, 200, { ok: true })
          } catch (e) {
            // Traces are best-effort: report but never 5xx (sendBeacon
            // callers ignore the response anyway).
            sendJson(res, 200, { ok: false, error: (e as Error).message })
          }
          return
        }

        if (req.method === 'GET' && (url === '/harness-version' || url.startsWith('/harness-version?'))) {
          sendJson(res, 200, harnessVersion())
          return
        }

        if (req.method === 'GET' && (url === '/query' || url.startsWith('/query?'))) {
          try {
            const params = new URLSearchParams(url.split('?')[1] ?? '')
            sendJson(res, 200, { traces: queryTraces(params) })
          } catch (e) {
            sendJson(res, 500, { error: (e as Error).message })
          }
          return
        }

        sendJson(res, 405, { error: 'unknown /traces route' })
      })
    },
  }
}
