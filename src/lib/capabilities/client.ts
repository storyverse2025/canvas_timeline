import type { CapabilityRequest, CapabilityResponse } from './types'

export async function runCapability(req: CapabilityRequest): Promise<CapabilityResponse> {
  const res = await fetch('/capabilities/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const raw = await res.text()
  let data: (CapabilityResponse & { error?: string }) | null = null
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`非 JSON 响应 (HTTP ${res.status}): ${raw.slice(0, 200).replace(/<[^>]+>/g, '').trim()}`)
  }
  if (!res.ok || data?.error) throw new Error(data?.error ?? `capability error: ${res.status}`)
  if (!data) throw new Error('empty response')
  return data
}
