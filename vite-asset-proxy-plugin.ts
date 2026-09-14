import type { Plugin } from 'vite'

// Hosts that hand out signed video/image URLs but don't set CORS, so the
// browser can't fetch them for canvas-based export (timeline合拼视频).
// Anything matching this regex can be proxied via /asset-proxy?url=<encoded>.
const ALLOWED_HOST_RE = /(?:^|\.)(?:volces\.com|bytepluses\.com|bytedanceapi\.com|byteimg\.com|byteoss\.com|fal\.media|fal\.run)$/i

// Hop-by-hop or origin-specific headers we should not forward to the client.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'access-control-allow-credentials',
])

export function assetProxyPlugin(): Plugin {
  return {
    name: 'asset-proxy',
    configureServer(server) {
      server.middlewares.use('/asset-proxy', async (req, res) => {
        try {
          const incoming = new URL(req.url ?? '', 'http://x')
          const targetRaw = incoming.searchParams.get('url')
          if (!targetRaw) {
            res.statusCode = 400
            res.end('missing ?url=')
            return
          }
          let target: URL
          try {
            target = new URL(targetRaw)
          } catch {
            res.statusCode = 400
            res.end('invalid url')
            return
          }
          if (target.protocol !== 'https:' && target.protocol !== 'http:') {
            res.statusCode = 400
            res.end('unsupported protocol')
            return
          }
          if (!ALLOWED_HOST_RE.test(target.hostname)) {
            res.statusCode = 403
            res.end(`host not allowed: ${target.hostname}`)
            return
          }

          // Pass through Range so HTMLVideoElement can seek/stream.
          const fwdHeaders: Record<string, string> = {}
          const range = req.headers['range']
          if (typeof range === 'string') fwdHeaders['range'] = range

          const upstream = await fetch(target.toString(), {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: fwdHeaders,
            redirect: 'follow',
          })

          res.statusCode = upstream.status
          upstream.headers.forEach((v, k) => {
            if (STRIPPED_RESPONSE_HEADERS.has(k.toLowerCase())) return
            res.setHeader(k, v)
          })
          // Permissive CORS — this proxy is dev-only and gated by hostname allowlist.
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Content-Type')
          res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') ?? 'bytes')

          if (!upstream.body || req.method === 'HEAD') {
            res.end()
            return
          }
          // Stream the body. Node 18+ fetch returns a Web ReadableStream.
          const reader = upstream.body.getReader()
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value && value.byteLength) res.write(Buffer.from(value))
          }
          res.end()
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e)
          if (!res.headersSent) {
            res.statusCode = 502
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(`asset-proxy error: ${msg}`)
          } else {
            try { res.end() } catch { /* noop */ }
          }
        }
      })
    },
  }
}
