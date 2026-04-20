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
  if (imgCount === 1) return 'image-to-video-first'
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

/** Filter URLs to only http(s) and data: URLs that remote APIs can access. */
export function filterAccessible(urls: string[]): string[] {
  return urls.filter((u) => u && u.length > 10 && (/^https?:\/\//i.test(u) || u.startsWith('data:')))
}
