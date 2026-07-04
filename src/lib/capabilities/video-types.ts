/**
 * Detect Seedance video generation type from inputs.
 *
 * Neo-AI's 4 video types (per Ark docs):
 * - TEXT_TO_VIDEO: text only
 * - IMAGE_TO_VIDEO (first frame): 1 image (role: first_frame)
 * - IMAGE_TO_VIDEO (first+last frame): 2 images (roles: first_frame + last_frame)
 * - REFERENCE_TO_VIDEO: 2-9 images (role: reference_image)
 * - UNIVERSAL_TO_VIDEO: mixed media (images + videos + audio)
 */

export type VideoGenType =
  | 'text-to-video'
  | 'image-to-video-first'
  | 'image-to-video-first-last'
  | 'reference-to-video'
  | 'universal-to-video'

export interface VideoInputs {
  images: string[]
  videos: string[]
  audios: string[]
  /** Explicit hint: "first-last" means treat 2 images as first+last frames,
   *  "reference" means treat images as reference images. */
  mode?: 'first-last' | 'reference'
}

export function detectVideoType(inputs: VideoInputs): VideoGenType {
  const hasVideo = inputs.videos.length > 0
  const hasAudio = inputs.audios.length > 0
  const imgCount = inputs.images.length

  if (hasVideo || hasAudio) return 'universal-to-video'
  if (imgCount === 0) return 'text-to-video'
  // mode:'reference' forces reference-to-video even for a single image — the
  // caller is adding extra reference media (e.g. asset:// virtual-avatar refs)
  // that can't be mixed with a literal first_frame role.
  if (imgCount === 1) return inputs.mode === 'reference' ? 'reference-to-video' : 'image-to-video-first'
  if (imgCount === 2 && inputs.mode !== 'reference') return 'image-to-video-first-last'
  return 'reference-to-video'
}

/**
 * Build Ark content parts for a given video gen type.
 * Returns the `content` array to send in the Seedance API request body.
 */
export function buildContentParts(
  prompt: string,
  inputs: VideoInputs,
  type: VideoGenType,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text: prompt || 'cinematic video' }]

  switch (type) {
    case 'text-to-video':
      // No media parts
      break

    case 'image-to-video-first':
      parts.push({
        type: 'image_url',
        image_url: { url: inputs.images[0] },
        role: 'first_frame',
      })
      break

    case 'image-to-video-first-last':
      parts.push({
        type: 'image_url',
        image_url: { url: inputs.images[0] },
        role: 'first_frame',
      })
      parts.push({
        type: 'image_url',
        image_url: { url: inputs.images[1] },
        role: 'last_frame',
      })
      break

    case 'reference-to-video':
      for (const url of inputs.images.slice(0, 9)) {
        parts.push({
          type: 'image_url',
          image_url: { url },
          role: 'reference_image',
        })
      }
      break

    case 'universal-to-video':
      for (const url of inputs.images.slice(0, 9)) {
        parts.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
      }
      for (const url of inputs.videos.slice(0, 3)) {
        parts.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
      }
      for (const url of inputs.audios.slice(0, 3)) {
        parts.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
      }
      break
  }

  return parts
}

function isSupportedRasterDataUrl(url: string): boolean {
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url.trim())
  if (!match) return false
  const payload = match[2]
  // Base64 length modulo 1 is always invalid; allow omitted padding for provider-tolerant payloads.
  return payload.length > 0 && payload.length % 4 !== 1
}

function isSeedanceImageUrl(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed.length <= 10) return false
  if (/^https?:\/\//i.test(trimmed)) return true
  return isSupportedRasterDataUrl(trimmed)
}

/** Filter image URLs to only Seedance-supported remote refs or raster data URLs. */
export function filterAccessible(urls: string[]): string[] {
  return urls.filter(isSeedanceImageUrl).map((u) => u.trim())
}
