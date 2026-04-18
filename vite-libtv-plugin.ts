import type { Plugin } from 'vite'
import { spawn } from 'child_process'
import path from 'path'

const SKILL_DIR = path.resolve(__dirname, '.claude/skills/libtv-skill/scripts')

function runPython(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('python3', [path.join(SKILL_DIR, script), ...args], {
      env: { ...process.env, LIBTV_ACCESS_KEY: process.env.LIBTV_ACCESS_KEY ?? '' },
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

async function readJson(req: import('http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

export function libtvPlugin(): Plugin {
  return {
    name: 'libtv-api',
    configureServer(server) {
      server.middlewares.use('/libtv/generate', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end('POST only'); return
        }
        try {
          const body = await readJson(req)
          const prompt: string = body.prompt ?? ''
          const sessionId: string | undefined = body.sessionId
          if (!prompt.trim()) {
            res.statusCode = 400; res.end(JSON.stringify({ error: 'prompt required' })); return
          }
          const args = [prompt]
          if (sessionId) args.push('--session-id', sessionId)
          const r = await runPython('create_session.py', args)
          res.setHeader('Content-Type', 'application/json')
          if (r.code !== 0) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: r.stderr || 'python failed', stdout: r.stdout }))
            return
          }
          res.end(r.stdout)
        } catch (e: any) {
          res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message ?? e) }))
        }
      })

      server.middlewares.use('/libtv/session', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://x')
          const sid = url.searchParams.get('id')
          if (!sid) { res.statusCode = 400; res.end(JSON.stringify({ error: 'id required' })); return }
          const r = await runPython('query_session.py', [sid])
          res.setHeader('Content-Type', 'application/json')
          if (r.code !== 0) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: r.stderr, stdout: r.stdout }))
            return
          }
          res.end(r.stdout)
        } catch (e: any) {
          res.statusCode = 500; res.end(JSON.stringify({ error: String(e?.message ?? e) }))
        }
      })
    },
  }
}
