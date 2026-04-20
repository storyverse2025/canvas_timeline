import { PROVIDERS } from './registry'
import type { GenerateRequest, GenerateResponse, ProviderId } from './types'

export type ProviderAvailability = Record<ProviderId, boolean>

let availabilityCache: ProviderAvailability | null = null

export async function fetchAvailability(): Promise<ProviderAvailability> {
  if (availabilityCache) return availabilityCache
  const res = await fetch('/providers/available')
  availabilityCache = (await res.json()) as ProviderAvailability
  return availabilityCache
}

export function clearAvailabilityCache() { availabilityCache = null }

export async function callProvider(req: GenerateRequest): Promise<GenerateResponse> {
  const res = await fetch('/providers/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const raw = await res.text()
  let data: (GenerateResponse & { error?: string }) | null = null
  try { data = JSON.parse(raw) } catch {
    // Gateway/timeout returned HTML — surface the HTTP status instead of the parse error
    throw new Error(`网关返回非 JSON（可能超时，HTTP ${res.status}）: ${raw.slice(0, 200).replace(/<[^>]+>/g, '').trim()}`)
  }
  if (!res.ok || data?.error) throw new Error(data?.error ?? `provider error: ${res.status}`)
  if (!data) throw new Error('empty response')
  return data
}

export async function optimizePrompt(args: {
  prompt: string;
  kind: 'image' | 'video';
  aspect?: string;
  duration?: number;
  /** "seedance-universal" = generate @图片1/@图片2 style prompt for Seedance multi-ref video */
  mode?: 'default' | 'seedance-universal';
  refImages?: string[];
}): Promise<{ prompt: string }> {
  const res = await fetch('/providers/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  const raw = await res.text()
  try {
    const data = JSON.parse(raw) as { prompt?: string; error?: string }
    if (!res.ok || data.error) throw new Error(data.error ?? `optimize error: ${res.status}`)
    if (!data.prompt) throw new Error('empty optimize response')
    return { prompt: data.prompt }
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`非 JSON 响应 (HTTP ${res.status})`)
    throw e
  }
}

export function defaultModel(providerId: ProviderId, kind: 'image' | 'video' | 'audio') {
  const p = PROVIDERS.find((x) => x.id === providerId)
  if (!p) return undefined
  // Prefer one whose label flags it as default (e.g. Seedance Fast)
  const flagged = p.models.find((m) => m.kind === kind && /默认|default/i.test(m.label))
  return flagged ?? p.models.find((m) => m.kind === kind)
}
