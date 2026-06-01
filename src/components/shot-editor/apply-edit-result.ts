import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import type { CanvasItem } from '@/stores/canvas-item-store'
import type { StoryboardRow } from '@/types/storyboard'

function snapshotHead(item: CanvasItem) {
  return {
    content: item.content,
    prompt: item.prompt,
    refImages: item.refImages,
    refAudios: item.refAudios,
    provider: item.provider,
    model: item.model,
    timestamp: Date.now(),
  }
}

function findKeyframeNodeId(row: StoryboardRow): string | undefined {
  const canvas = useCanvasStore.getState()
  const items = useCanvasItemStore.getState().items

  if (row.keyframeNodeId && canvas.nodes.some((n) => n.id === row.keyframeNodeId)) {
    return row.keyframeNodeId
  }

  const oldImageUrl = row.keyframeUrl || row.reference_image
  if (!oldImageUrl) return undefined

  return canvas.nodes.find((node) => {
    const itemId = node.data?.itemId as string | undefined
    if (!itemId) return false
    const item = items[itemId]
    return item?.kind === 'image' && item.content === oldImageUrl
  })?.id
}

/**
 * Apply an edited image result from shot-editor tools.
 *
 * These results are keyframe variants, not beat-video outputs. Keep the
 * existing keyframe canvas node in place and push the previous keyframe head
 * into versions[] so the table/canvas do not grow a fake image node in the
 * Beat Video slot. Cute bug, very avoidable.
 */
export function appendKeyframeHistoryVersion(rowId: string, imageUrl: string): void {
  const row = useStoryboardStore.getState().rows.find((r) => r.id === rowId)
  if (!row || !imageUrl) return

  const keyframeNodeId = findKeyframeNodeId(row)
  const node = keyframeNodeId ? useCanvasStore.getState().nodes.find((n) => n.id === keyframeNodeId) : undefined
  const itemId = node?.data?.itemId as string | undefined
  const item = itemId ? useCanvasItemStore.getState().items[itemId] : undefined
  if (!itemId || item?.kind !== 'image') return

  const alreadyExists = item.content === imageUrl || (item.versions ?? []).some((v) => v.content === imageUrl)
  if (alreadyExists) return

  useCanvasItemStore.setState((state) => {
    const target = state.items[itemId]
    if (!target) return
    target.versions = [
      {
        content: imageUrl,
        prompt: target.prompt,
        refImages: target.refImages,
        refAudios: target.refAudios,
        provider: target.provider,
        model: target.model,
        timestamp: Date.now(),
      },
      ...(target.versions ?? []),
    ]
  })
}

export function applyEditResult(rowId: string, newImageUrl: string, editLabel: string) {
  const row = useStoryboardStore.getState().rows.find((r) => r.id === rowId)
  if (!row) return

  const keyframeNodeId = findKeyframeNodeId(row)
  const node = keyframeNodeId ? useCanvasStore.getState().nodes.find((n) => n.id === keyframeNodeId) : undefined
  const itemId = node?.data?.itemId as string | undefined
  const item = itemId ? useCanvasItemStore.getState().items[itemId] : undefined

  if (itemId && item?.kind === 'image') {
    const version = snapshotHead(item)
    useCanvasItemStore.setState((state) => {
      const target = state.items[itemId]
      if (!target) return
      target.versions = [version, ...(target.versions ?? [])]
      target.content = newImageUrl
      target.role = target.role ?? 'keyframe'
      target.name = target.name || `${row.shot_number}-${editLabel}`
    })

    useStoryboardStore.getState().updateRow(rowId, {
      keyframeNodeId,
      keyframeUrl: newImageUrl,
      reference_image: newImageUrl,
    })
    return
  }

  // Fallback for rows that have no keyframe node yet: create one in the
  // keyframe column area and bind it as the row keyframe. Still do not touch
  // beatVideoUrl / beatVideoNodeId.
  const newItemId = useCanvasItemStore.getState().addItem({
    kind: 'image',
    role: 'keyframe',
    name: `${row.shot_number}-${editLabel}`,
    content: newImageUrl,
  })
  const newNodeId = useCanvasStore.getState().addItemNode(newItemId, 'image', { x: 400, y: 50 }, { width: 280, height: 180 })
  useStoryboardStore.getState().updateRow(rowId, {
    keyframeNodeId: newNodeId,
    keyframeUrl: newImageUrl,
    reference_image: newImageUrl,
  })
}
