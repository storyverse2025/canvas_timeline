import JSZip from 'jszip'
import type { StoryboardRow } from '@/types/storyboard'

export interface ExportItem {
  shotNumber: string
  type: 'keyframe' | 'beat-video'
  url: string
  filename: string
}

/** Collect exportable media URLs from storyboard rows. */
export function collectExportItems(rows: StoryboardRow[], includeKeyframes: boolean, includeVideos: boolean): ExportItem[] {
  const items: ExportItem[] = []
  for (const r of rows) {
    if (includeKeyframes && (r.keyframeUrl || r.reference_image)) {
      const url = r.keyframeUrl || r.reference_image
      const ext = url.includes('.mp4') ? 'mp4' : url.includes('.webp') ? 'webp' : 'jpg'
      items.push({
        shotNumber: r.shot_number,
        type: 'keyframe',
        url,
        filename: `${r.shot_number}_keyframe.${ext}`,
      })
    }
    if (includeVideos && r.beatVideoUrl) {
      items.push({
        shotNumber: r.shot_number,
        type: 'beat-video',
        url: r.beatVideoUrl,
        filename: `${r.shot_number}_beat_video.mp4`,
      })
    }
  }
  return items
}

/** Fetch a URL and return as ArrayBuffer. Uses server proxy for cross-origin URLs. */
async function fetchAsBuffer(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('data:')) {
    const base64 = url.split(',')[1]
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }
  // For external URLs, proxy through our server to avoid CORS
  if (/^https?:\/\//i.test(url) && !url.startsWith(window.location.origin)) {
    const res = await fetch('/capabilities/proxy-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (!res.ok) throw new Error(`proxy download failed: ${res.status}`)
    return res.arrayBuffer()
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
  return res.arrayBuffer()
}

/** Package selected items into a zip and trigger download via server. */
export async function exportAsZip(
  items: ExportItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (items.length === 0) throw new Error('没有可导出的内容')

  // Send URLs to server for packaging — avoids CORS and insecure blob issues
  const res = await fetch('/capabilities/export-zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: items.map((i) => ({ url: i.url, filename: i.filename })),
    }),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => 'export failed')
    throw new Error(err)
  }

  const data = await res.json() as { url: string }
  // Download the server-generated zip file
  const a = document.createElement('a')
  a.href = data.url
  a.download = `storyverse-export-${Date.now()}.zip`
  a.click()
}
