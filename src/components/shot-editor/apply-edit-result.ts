import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'

/**
 * Apply an edited image result: update storyboard row + create canvas node linked from old image.
 */
export function applyEditResult(rowId: string, newImageUrl: string, editLabel: string) {
  const row = useStoryboardStore.getState().rows.find((r) => r.id === rowId)
  if (!row) return

  const oldImageUrl = row.keyframeUrl || row.reference_image

  // 1. Update storyboard row
  useStoryboardStore.getState().updateRow(rowId, {
    keyframeUrl: newImageUrl,
    reference_image: newImageUrl,
  })

  // 2. Create new canvas node for the edited image
  const newItemId = useCanvasItemStore.getState().addItem({
    kind: 'image',
    name: `${row.shot_number}-${editLabel}`,
    content: newImageUrl,
  })

  // Find old canvas node (by matching old image URL)
  let oldNodeId: string | undefined
  if (oldImageUrl) {
    const nodes = useCanvasStore.getState().nodes
    const items = useCanvasItemStore.getState().items
    for (const node of nodes) {
      const itemId = node.data?.itemId as string | undefined
      if (!itemId) continue
      const item = items[itemId]
      if (item?.content === oldImageUrl) {
        oldNodeId = node.id
        break
      }
    }
  }

  // Position new node to the right of old node, or at default position
  const oldNode = oldNodeId ? useCanvasStore.getState().nodes.find((n) => n.id === oldNodeId) : undefined
  const pos = oldNode
    ? { x: oldNode.position.x + ((oldNode.style?.width as number) ?? oldNode.width ?? 280) + 60, y: oldNode.position.y }
    : { x: 400, y: 50 }

  const newNodeId = useCanvasStore.getState().addItemNode(newItemId, 'image', pos, { width: 280, height: 180 })

  // 3. Connect old node → new node
  if (oldNodeId) {
    useCanvasStore.getState().addEdge(oldNodeId, newNodeId)
  }
}
