import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useStoryboardStore } from '@/stores/storyboard-store'

function getItemContentByNodeId(nodeId: string): string | undefined {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
  if (!node?.data?.itemId) return undefined
  const item = useCanvasItemStore.getState().items[node.data.itemId]
  return item?.content
}

/**
 * Canvas→Table sync: when a canvas item (referenced by a storyboard row) changes,
 * propagate the URL back to the storyboard row so the table stays current.
 */
let _subscribed = false
export function initCanvasStoryboardSync() {
  if (_subscribed) return
  _subscribed = true

  let prevItems = useCanvasItemStore.getState().items
  useCanvasItemStore.subscribe((state) => {
    if (state.items === prevItems) return
    prevItems = state.items

    const rows = useStoryboardStore.getState().rows
    const updateRow = useStoryboardStore.getState().updateRow

    for (const row of rows) {
      if (row.keyframeNodeId) {
        const content = getItemContentByNodeId(row.keyframeNodeId)
        if (content && content !== row.keyframeUrl) {
          updateRow(row.id, { keyframeUrl: content })
        }
      }
      if (row.beatVideoNodeId) {
        const content = getItemContentByNodeId(row.beatVideoNodeId)
        if (content && content !== row.beatVideoUrl) {
          updateRow(row.id, { beatVideoUrl: content })
        }
      }
      for (const slotKey of ['character1', 'character2', 'prop1', 'prop2', 'scene'] as const) {
        const slot = row[slotKey]
        if (slot?.nodeId) {
          const content = getItemContentByNodeId(slot.nodeId)
          if (content && content !== slot.image) {
            updateRow(row.id, { [slotKey]: { ...slot, image: content } })
          }
        }
      }
    }
  })
}
