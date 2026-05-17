/**
 * BytePlus Ark digital-asset / 开白 client.
 *
 * Used by the keyframe-privacy-block fallback chain in
 * src/hooks/useStoryboardGenerate.ts:
 *
 *   1. Seedance text-to-video rejects keyframe with
 *      InputImageSensitiveContentDetected.PrivacyInformation
 *   2. We register each character reference image as a BytePlus digital
 *      asset (this module), wait for status === 'Active'
 *   3. Reshoot Seedance with the original keyframe + asset_id list as
 *      invited_images so the moderator sees the characters as approved
 *   4. If THIS still fails (or registration fails), the caller falls back
 *      to the existing 2D-stylization keyframe regen.
 *
 * ## Endpoint constants
 *
 * The exact BytePlus REST shape for digital-asset CRUD is not publicly
 * documented for the Bearer-auth /api/v3 surface; the canonical workflow
 * (CreateAsset/CreateAssetGroup) uses AK/SK-signed Volcano OpenAPI. This
 * client targets the BEST-GUESS BytePlus REST path
 * `/api/v3/contents/digital_assets` (matching how chat lives at
 * `/api/v3/chat/completions` and content tasks live at
 * `/api/v3/contents/generations/tasks`). The paths are env-overridable so
 * we can correct them without a code change once the real endpoint is
 * confirmed.
 *
 * When the endpoint returns 401/404/etc., the caller treats the whole
 * fallback step as failed and proceeds to 2D stylization. No silent
 * swallowing — we throw a typed error with the upstream status.
 */

const CREATE_PATH = import.meta.env?.VITE_BYTEPLUS_ASSET_CREATE_PATH ?? '/byteplus-asset/contents/digital_assets'
const POLL_PATH_PREFIX = import.meta.env?.VITE_BYTEPLUS_ASSET_POLL_PREFIX ?? '/byteplus-asset/contents/digital_assets'
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 60_000

export class ByteplusAssetError extends Error {
  status: number
  body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'ByteplusAssetError'
    this.status = status
    this.body = body
  }
}

interface CreateAssetResponse {
  id?: string
  asset_id?: string
  status?: string
}

interface PollAssetResponse {
  id?: string
  asset_id?: string
  status?: string
}

function extractAssetId(r: CreateAssetResponse | PollAssetResponse): string | undefined {
  return r.id ?? r.asset_id
}

/**
 * Submit an image URL to BytePlus digital-asset registration.
 * Returns the asset id (status may still be 'reviewing' — poll separately).
 */
export async function createDigitalAsset(imageUrl: string): Promise<{ assetId: string; status: string }> {
  const res = await fetch(CREATE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      asset_type: 'image',
      // Conservative defaults — Pose can be overridden once we confirm what
      // BytePlus actually requires; rights_assumption is informational and
      // mirrors the workflow described in
      // skills/byteplus-seedance-digital-asset-open-whitelist/SKILL.md.
      rights_assumption: 'user/company-authorized character reference',
    }),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new ByteplusAssetError(
      `BytePlus createDigitalAsset failed: ${res.status} ${res.statusText}`,
      res.status,
      bodyText.slice(0, 500),
    )
  }
  const parsed = JSON.parse(bodyText) as CreateAssetResponse
  const assetId = extractAssetId(parsed)
  if (!assetId) {
    throw new ByteplusAssetError(
      'BytePlus createDigitalAsset returned no id',
      res.status,
      bodyText.slice(0, 500),
    )
  }
  return { assetId, status: parsed.status ?? 'reviewing' }
}

/** GET one asset; return its current status. */
export async function getDigitalAsset(assetId: string): Promise<{ assetId: string; status: string }> {
  const res = await fetch(`${POLL_PATH_PREFIX}/${encodeURIComponent(assetId)}`)
  const bodyText = await res.text()
  if (!res.ok) {
    throw new ByteplusAssetError(
      `BytePlus getDigitalAsset(${assetId}) failed: ${res.status}`,
      res.status,
      bodyText.slice(0, 500),
    )
  }
  const parsed = JSON.parse(bodyText) as PollAssetResponse
  return { assetId: extractAssetId(parsed) ?? assetId, status: parsed.status ?? 'unknown' }
}

const TERMINAL_OK = new Set(['active', 'Active', 'ACTIVE'])
const TERMINAL_FAIL = new Set(['failed', 'rejected', 'Failed', 'Rejected', 'FAILED', 'REJECTED'])

/**
 * Submit + poll an image URL until its review reaches a terminal state.
 * Returns the asset id on Active; throws on rejection or timeout.
 */
export async function registerAndWait(imageUrl: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const { assetId, status: initial } = await createDigitalAsset(imageUrl)
  if (TERMINAL_OK.has(initial)) return assetId
  if (TERMINAL_FAIL.has(initial)) {
    throw new ByteplusAssetError(`BytePlus asset ${assetId} immediately rejected (status=${initial})`, 200, '')
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS
  // First-iteration sleep is small to handle fast approvals; subsequent
  // iterations use POLL_INTERVAL_MS.
  let delay = 500
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new ByteplusAssetError('aborted', 0, '')
    await new Promise((r) => setTimeout(r, delay))
    delay = POLL_INTERVAL_MS
    const { status } = await getDigitalAsset(assetId)
    if (TERMINAL_OK.has(status)) return assetId
    if (TERMINAL_FAIL.has(status)) {
      throw new ByteplusAssetError(`BytePlus asset ${assetId} rejected on review (status=${status})`, 200, '')
    }
  }
  throw new ByteplusAssetError(
    `BytePlus asset ${assetId} did not reach Active within ${POLL_TIMEOUT_MS}ms`,
    0,
    '',
  )
}

/**
 * Register multiple character refs in parallel. Returns the subset that
 * successfully reached Active — the caller decides whether a partial
 * result is enough to retry the shoot or whether to fall back entirely.
 */
export async function registerCharacterRefs(
  imageUrls: string[],
): Promise<{ approved: string[]; rejected: Array<{ imageUrl: string; reason: string }> }> {
  const results = await Promise.allSettled(imageUrls.map((u) => registerAndWait(u)))
  const approved: string[] = []
  const rejected: Array<{ imageUrl: string; reason: string }> = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') approved.push(r.value)
    else rejected.push({ imageUrl: imageUrls[i], reason: String((r.reason as Error)?.message ?? r.reason) })
  })
  return { approved, rejected }
}
