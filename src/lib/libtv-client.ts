export interface CreateSessionResp {
  projectUuid?: string;
  sessionId: string;
  projectUrl?: string;
  error?: string;
}

export interface SessionMessage {
  messageId?: string;
  role?: string;
  status?: string;
  type?: string;
  content?: unknown;
  createdAt?: number | string;
  [k: string]: unknown;
}

export interface QuerySessionResp {
  sessionId?: string;
  messages?: SessionMessage[];
  error?: string;
  [k: string]: unknown;
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const raw = await res.text()
  try { return JSON.parse(raw) as T }
  catch { throw new Error(`非 JSON 响应 (HTTP ${res.status}): ${raw.slice(0, 200).replace(/<[^>]+>/g, '').trim()}`) }
}

export async function libtvGenerate(prompt: string, sessionId?: string): Promise<CreateSessionResp> {
  const res = await fetch('/libtv/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, sessionId }),
  })
  return parseJsonOrThrow<CreateSessionResp>(res)
}

export async function libtvQuery(sessionId: string): Promise<QuerySessionResp> {
  const res = await fetch(`/libtv/session?id=${encodeURIComponent(sessionId)}`)
  return parseJsonOrThrow<QuerySessionResp>(res)
}

const URL_RE = /https?:\/\/[^\s"\\]+?\.(?:mp4|webm|mov|png|jpe?g|webp|gif)(?:\?[^\s"\\]*)?/gi
const SKIP_HOSTS = /example\.com|placeholder/i

/** Best-effort: walk the unstructured message payload and surface the last real media URL. */
export function extractMediaUrl(resp: QuerySessionResp): { url: string; kind: 'image' | 'video' } | null {
  const msgs = resp.messages ?? []
  const urls: { url: string; kind: 'image' | 'video' }[] = []
  const visit = (v: unknown) => {
    if (v == null) return
    if (typeof v === 'string') {
      const matches = v.match(URL_RE)
      if (!matches) return
      for (const u of matches) {
        if (SKIP_HOSTS.test(u)) continue
        const kind: 'image' | 'video' = /\.(mp4|webm|mov)/i.test(u) ? 'video' : 'image'
        urls.push({ url: u, kind })
      }
      return
    }
    if (Array.isArray(v)) { v.forEach(visit); return }
    if (typeof v === 'object') { Object.values(v as Record<string, unknown>).forEach(visit) }
  }
  msgs.forEach(visit)
  return urls[urls.length - 1] ?? null
}
