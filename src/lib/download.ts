/**
 * Trigger a browser download for a canvas item's URL.
 *
 * - data: URLs → click an <a download> directly (no fetch).
 * - http(s) URLs → fetch as Blob, wrap in object URL, then click. This
 *   bypasses CORS issues that prevent <a download> from working on
 *   cross-origin remote URLs.
 *
 * The filename is sanitized for OS-illegal chars and gets a sensible
 * extension inferred from (1) the URL path, (2) the blob's content-type,
 * or (3) a per-kind default (.png / .mp4 / .mp3).
 */

export type DownloadKind = 'image' | 'video' | 'audio'

const KIND_DEFAULT_EXT: Record<DownloadKind, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'mp3',
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
}

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g

function sanitizeFilename(name: string): string {
  return name.replace(ILLEGAL_FILENAME_CHARS, '_').trim() || 'download'
}

function extFromUrl(url: string): string | undefined {
  // Strip query/hash before reading the extension.
  const pathOnly = url.split(/[?#]/)[0] ?? ''
  const match = /\.([a-zA-Z0-9]{2,5})$/.exec(pathOnly)
  return match?.[1]?.toLowerCase()
}

function extFromMime(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined
  const ct = contentType.split(';')[0]!.trim().toLowerCase()
  return MIME_TO_EXT[ct]
}

function buildDownloadName(baseName: string, ext: string): string {
  const sanitizedBase = sanitizeFilename(baseName)
  // If the user-supplied base already ends with the right extension, don't double it.
  if (sanitizedBase.toLowerCase().endsWith(`.${ext}`)) return sanitizedBase
  // Strip any other trailing extension so we don't end up with "Alice.jpg.png".
  const withoutExt = sanitizedBase.replace(/\.[a-zA-Z0-9]{2,5}$/, '')
  return `${withoutExt}.${ext}`
}

function clickDownload(href: string, filename: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  // The anchor doesn't need to be in the DOM for click() to trigger
  // download, but Safari is happier when it is.
  document.body.appendChild(a)
  try {
    a.click()
  } finally {
    a.remove()
  }
}

// Exported for tests.
export {
  KIND_DEFAULT_EXT,
  MIME_TO_EXT,
  sanitizeFilename,
  extFromUrl,
  extFromMime,
  buildDownloadName,
}

/**
 * Public entry point.
 *
 * @param url       The canvas item content (data: or http(s):).
 * @param baseName  Filename without extension (we add one).
 * @param kind      Used to pick a default extension when the URL + blob
 *                  content-type don't reveal one. Optional — defaults to 'image'.
 */
export async function downloadFromUrl(
  url: string,
  baseName: string,
  kind: DownloadKind = 'image',
): Promise<void> {
  if (!url || !url.trim()) throw new Error('downloadFromUrl: empty url')

  // data: URLs need no fetch.
  if (url.startsWith('data:')) {
    const mimeMatch = /^data:([^;,]+)/.exec(url)
    const ext = extFromMime(mimeMatch?.[1]) ?? KIND_DEFAULT_EXT[kind]
    clickDownload(url, buildDownloadName(baseName, ext))
    return
  }

  // Remote URL: fetch as blob to bypass CORS download restrictions.
  let response: Response
  try {
    response = await fetch(url)
  } catch (e) {
    throw new Error(`downloadFromUrl: fetch failed (${(e as Error).message})`)
  }
  if (!response.ok) {
    throw new Error(`downloadFromUrl: fetch failed (HTTP ${response.status})`)
  }
  const blob = await response.blob()
  const ext =
    extFromUrl(url) ??
    extFromMime(response.headers.get('content-type')) ??
    KIND_DEFAULT_EXT[kind]
  const objectUrl = URL.createObjectURL(blob)
  try {
    clickDownload(objectUrl, buildDownloadName(baseName, ext))
  } finally {
    // Defer revoke so the browser can finish the download.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
  }
}
