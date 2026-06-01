import type { StoryboardRow } from '@/types/storyboard'
import type { CanvasItem, CanvasItemRole } from '@/stores/canvas-item-store'

export interface KeyframeHistoryEntry {
  id: string
  content: string
  name: string
  role?: CanvasItemRole
  createdAt: number
  sourceItemId: string
  isStoredVersion: boolean
}

function matchesShot(item: CanvasItem, namePrefix: string): boolean {
  if (item.kind !== 'image') return false
  if (item.role !== 'keyframe' && item.role !== 'keyframe-clean') return false
  const n = item.name ?? ''
  return n === namePrefix || n.startsWith(`${namePrefix}-`) || n.startsWith(`${namePrefix} `)
}

export function collectKeyframeHistory(row: StoryboardRow, allItems: Record<string, CanvasItem>): KeyframeHistoryEntry[] {
  const namePrefix = `KF-${row.shot_number}`
  const entries: KeyframeHistoryEntry[] = []

  for (const item of Object.values(allItems)) {
    if (!matchesShot(item, namePrefix)) continue
    if (item.content) {
      entries.push({
        id: item.id,
        content: item.content,
        name: item.name,
        role: item.role,
        createdAt: item.createdAt ?? 0,
        sourceItemId: item.id,
        isStoredVersion: false,
      })
    }
    for (const [index, version] of (item.versions ?? []).entries()) {
      if (!version.content) continue
      entries.push({
        id: `${item.id}:v${index}`,
        content: version.content,
        name: `${item.name} · v${index + 1}`,
        role: item.role,
        createdAt: version.timestamp ?? 0,
        sourceItemId: item.id,
        isStoredVersion: true,
      })
    }
  }

  const seen = new Set<string>()
  return entries
    .sort((a, b) => {
      const aCurrent = a.content === row.keyframeUrl || a.content === row.reference_image
      const bCurrent = b.content === row.keyframeUrl || b.content === row.reference_image
      if (aCurrent !== bCurrent) return aCurrent ? -1 : 1
      return b.createdAt - a.createdAt
    })
    .filter((entry) => {
      if (seen.has(entry.content)) return false
      seen.add(entry.content)
      return true
    })
}
