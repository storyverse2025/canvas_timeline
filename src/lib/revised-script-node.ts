/**
 * "最终扩写剧本" canvas node — the post-doctor revision of the script.
 *
 * After script-agent's expand-script dossier returns `post_doctor_revised_script`,
 * the director pipeline persists that revised script into
 * `useProjectDB.script.optimizedText` AND spawns a text canvas node so the
 * user can see (and edit) the revised baseline directly on the canvas.
 *
 * Idempotent: re-running optimize updates the existing node's content rather
 * than spawning a duplicate. Identified by `role === 'script'` on the
 * canvas-item-store entry.
 */

import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'

const REVISED_SCRIPT_NODE_ROLE = 'script' as const
const REVISED_SCRIPT_NODE_NAME = '最终扩写剧本'
const NODE_POS = { x: 400, y: 20 }
const NODE_SIZE = { width: 480, height: 360 }

/**
 * Find-or-create the text canvas node carrying the revised script. Returns
 * the node id. Updates the content on every call so re-running optimize
 * keeps the canvas in sync.
 *
 * The node content is the raw revised script text only — revision notes
 * are surfaced separately in the chat-bridge progress trace and the
 * pipeline UI's step result, not appended to the canvas body. This keeps
 * the canvas node clean for the user to edit (no boilerplate to strip
 * before manual revisions land in downstream agents).
 */
export function ensureRevisedScriptCanvasNode(
  revisedText: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _revisionNotes: string[] = [],
): string | null {
  const trimmed = revisedText.trim()
  if (!trimmed) return null

  const content = trimmed

  const itemStore = useCanvasItemStore.getState()
  const existing = Object.values(itemStore.items).find(
    (it) =>
      it.kind === 'text' &&
      // Match either explicit role or legacy name-based items so the node
      // remains stable across renames.
      ((it as { role?: string }).role === REVISED_SCRIPT_NODE_ROLE ||
        it.name.includes(REVISED_SCRIPT_NODE_NAME)),
  )

  let itemId: string
  if (existing) {
    itemId = existing.id
    if (existing.content !== content || existing.name !== REVISED_SCRIPT_NODE_NAME) {
      itemStore.updateItem(itemId, { content, name: REVISED_SCRIPT_NODE_NAME })
    }
  } else {
    itemId = itemStore.addItem({
      kind: 'text',
      name: REVISED_SCRIPT_NODE_NAME,
      content,
      role: REVISED_SCRIPT_NODE_ROLE,
    })
  }

  // Make sure a canvas node exists pointing at this item.
  const canvas = useCanvasStore.getState()
  const existingNode = canvas.nodes.find(
    (n) => (n.data as { itemId?: string }).itemId === itemId,
  )
  if (existingNode) return existingNode.id

  return canvas.addItemNode(itemId, 'text', NODE_POS, NODE_SIZE)
}
