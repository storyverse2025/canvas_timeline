import type { CapabilityInput, CapabilityRequest, CapabilityResponse } from './types'

/**
 * Inputs whose `url` is a `data:` URL big enough to risk pushing the JSON
 * request body past nginx's `client_max_body_size` (currently 50m). When
 * the user reports `非 JSON 响应 (HTTP 413): Request Entity Too Large`,
 * it's almost always one of these.
 *
 * Anything larger than this gets uploaded via `/uploads/save` first and
 * swapped for the returned hosted URL, so the request body stays small.
 * 256KB is a conservative threshold — typical 1024×1024 PNG keyframes
 * land in the 1-4MB range as base64 data URLs and would otherwise stack
 * up fast across 5+ ref images per keyframe request.
 */
const INLINE_DATA_URL_LIMIT_BYTES = 256 * 1024

/**
 * Upload one data URL to the server's static-uploads endpoint and return
 * the hosted path. Throws on upload failure so the caller can fall back
 * to sending the data URL inline (the request might still squeak under
 * the body limit if nothing else is big).
 */
async function uploadDataUrl(dataUrl: string): Promise<string> {
  const res = await fetch('/uploads/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  })
  if (!res.ok) throw new Error(`uploads/save HTTP ${res.status}`)
  const json = (await res.json()) as { url?: string; error?: string }
  if (!json.url) throw new Error(json.error ?? 'uploads/save: no url')
  return json.url
}

/**
 * Pre-flight: walk every input, replace big inline data URLs with hosted
 * URLs so the JSON body the browser POSTs to `/capabilities/run` stays
 * small enough for nginx + the vite middleware to accept.
 */
async function normalizeLargeDataUrls(inputs: CapabilityInput[]): Promise<CapabilityInput[]> {
  return Promise.all(
    inputs.map(async (input) => {
      if (!input.url) return input
      if (!input.url.startsWith('data:')) return input
      // Rough byte count from the base64 payload length.
      const m = input.url.match(/^data:[^;]+;base64,(.+)$/)
      const approxBytes = m ? Math.floor(m[1].length * 0.75) : input.url.length
      if (approxBytes < INLINE_DATA_URL_LIMIT_BYTES) return input
      try {
        const hostedUrl = await uploadDataUrl(input.url)
        return { ...input, url: hostedUrl }
      } catch (e) {
        // Couldn't upload — keep the data URL and hope the request still
        // fits. Caller will get a meaningful 413 if it doesn't.
        // eslint-disable-next-line no-console
        console.warn('[runCapability] data-url upload failed; sending inline:', (e as Error).message)
        return input
      }
    }),
  )
}

export async function runCapability(req: CapabilityRequest): Promise<CapabilityResponse> {
  const normalized: CapabilityRequest = {
    ...req,
    inputs: await normalizeLargeDataUrls(req.inputs),
  }
  const res = await fetch('/capabilities/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalized),
  })
  const raw = await res.text()

  // nginx returns 413 with a plain HTML body when client_max_body_size is
  // exceeded. The default error from the JSON.parse path below ("非 JSON
  // 响应 (HTTP 413)…") is technically accurate but unhelpful; this branch
  // tells the user *why* and suggests the fix.
  if (res.status === 413) {
    throw new Error(
      `请求体超过反代上限 (HTTP 413 Request Entity Too Large)。常见原因：` +
        `某个输入是大尺寸的 data:URL（截图、画布粘贴图）。我们已尝试自动上传 >256KB 的 data URL，` +
        `若仍然失败，请把图片先存到画布节点（自动走 /uploads/save）或调高 nginx client_max_body_size。`,
    )
  }

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
