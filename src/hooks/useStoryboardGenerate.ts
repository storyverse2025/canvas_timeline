import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { toast } from 'sonner'
import { runCapability } from '@/lib/capabilities/client'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useAssetStore } from '@/stores/asset-store'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import type { StoryboardRow, ElementSlot } from '@/types/storyboard'
import type { AssetType } from '@/types/asset'

/**
 * Resolve a slot to the canvas node that should feed the keyframe.
 *
 * Priority:
 *   1. Existing canvas node referenced by `slot.nodeId`.
 *   2. Asset in the asset store whose imageUrl matches `slot.image`
 *      — if so, reuse (or create) its on-canvas AssetNode so the keyframe
 *      visibly derives from the asset node.
 *   3. Asset in the asset store whose name/description fuzzily matches the
 *      slot's text (only if the slot has no image).
 *   4. Existing image item node on the canvas with the same image content.
 *   5. Fallback: create a new image/text item node.
 *
 * Returns `{ nodeId, imageUrl }` so callers can both wire the edge and
 * collect the canonical reference image URL.
 */
function resolveSlotNode(
  slot: ElementSlot,
  preferredTypes: AssetType[],
  label: string,
  baseX: number,
  baseY: number,
): { nodeId: string; imageUrl: string } {
  const canvas = useCanvasStore.getState()
  const assetStore = useAssetStore.getState()

  // 1. Honor existing slot.nodeId if the node still exists.
  if (slot.nodeId) {
    const existing = canvas.nodes.find((n) => n.id === slot.nodeId)
    if (existing) {
      const assetId = existing.data?.assetId as string | undefined
      const url = assetId
        ? assetStore.getAssetById(assetId)?.imageUrl ?? slot.image
        : slot.image
      return { nodeId: existing.id, imageUrl: url || '' }
    }
  }

  if (!slot.image && !slot.description) return { nodeId: '', imageUrl: '' }

  // 2. Match against an asset in the asset store by image URL.
  let asset = slot.image
    ? assetStore.assets.find((a) => a.imageUrl && a.imageUrl === slot.image)
    : undefined

  // 3. Fall back to name/description match (preferred kinds first).
  if (!asset && slot.description) {
    const desc = slot.description.trim().toLowerCase()
    if (desc) {
      for (const kind of preferredTypes) {
        asset = assetStore.assets.find((a) => {
          if (a.type !== kind) return false
          const n = (a.name ?? '').trim().toLowerCase()
          const d = (a.description ?? '').trim().toLowerCase()
          return (n && (desc.includes(n) || n.includes(desc))) ||
                 (d && (desc.includes(d) || d.includes(desc)))
        })
        if (asset) break
      }
    }
  }

  if (asset) {
    const existing = canvas.getNodeByAssetId(asset.id)
    if (existing) {
      return { nodeId: existing.id, imageUrl: asset.imageUrl ?? slot.image }
    }
    const nodeId = canvas.addNode(asset.id, { x: baseX, y: baseY })
    return { nodeId, imageUrl: asset.imageUrl ?? slot.image }
  }

  // 4. Look for an existing image item node with the same content.
  if (slot.image) {
    const items = useCanvasItemStore.getState().items
    for (const node of canvas.nodes) {
      const itemId = node.data?.itemId as string | undefined
      if (!itemId) continue
      const item = items[itemId]
      if (item?.kind === 'image' && item.content === slot.image) {
        return { nodeId: node.id, imageUrl: slot.image }
      }
    }
  }

  // 5. Create a new item node (image if we have one, else text).
  const kind = slot.image ? 'image' : 'text'
  const itemId = useCanvasItemStore.getState().addItem({
    kind,
    name: label,
    content: slot.image || slot.description,
  })
  const nodeId = useCanvasStore.getState().addItemNode(
    itemId, kind,
    { x: baseX, y: baseY },
    kind === 'image' ? { width: 160, height: 120 } : { width: 200, height: 100 },
  )
  return { nodeId, imageUrl: slot.image }
}

/**
 * Build the ordered list of role-bound reference images for a keyframe row.
 * Returns one entry per non-empty slot, in a stable order, so the prompt
 * labels ("image1", "image2", …) line up with the inputs array.
 */
interface SlotRef {
  role: string                 // human label, e.g. "角色1"
  description: string          // slot's text description, used in prompt
  preferredTypes: AssetType[]  // asset kinds to prefer when matching
  slotKey: 'character1' | 'character2' | 'prop1' | 'prop2' | 'scene'
  slot: ElementSlot
}

function collectSlotRefs(row: StoryboardRow): SlotRef[] {
  const slots: SlotRef[] = [
    { role: '角色1', slotKey: 'character1', slot: row.character1, preferredTypes: ['character'], description: row.character1?.description ?? '' },
    { role: '角色2', slotKey: 'character2', slot: row.character2, preferredTypes: ['character'], description: row.character2?.description ?? '' },
    { role: '道具1', slotKey: 'prop1',      slot: row.prop1,      preferredTypes: ['prop'],      description: row.prop1?.description ?? '' },
    { role: '道具2', slotKey: 'prop2',      slot: row.prop2,      preferredTypes: ['prop'],      description: row.prop2?.description ?? '' },
    { role: '场景',  slotKey: 'scene',      slot: row.scene,      preferredTypes: ['scene', 'keyframe'], description: row.scene?.description ?? '' },
  ]
  return slots.filter((s) => !!s.slot?.image || !!s.slot?.description)
}

export function useStoryboardGenerate() {
  const updateRow = useStoryboardStore((s) => s.updateRow)
  const startTask = useLibtvTasksStore((s) => s.startTask)
  const updateTask = useLibtvTasksStore((s) => s.updateTask)

  const generateKeyframe = useCallback(async (row: StoryboardRow) => {
    const baseDescription = [
      row.storyboard_prompts,
      row.visual_description,
      row.lighting_atmosphere,
      row.emotion_mood,
      row.emotion_atmosphere,
      row.character_motivation ? `character motivation: ${row.character_motivation}` : '',
      row.character_psychology ? `inner psychology: ${row.character_psychology}` : '',
      row.performance_guidance ? `performance guidance: ${row.performance_guidance}` : '',
      row.shot_size ? `${row.shot_size} shot` : '',
    ].filter(Boolean).join('. ')
    if (!baseDescription.trim()) { toast.error('缺少画面描述或分镜提示词'); return }

    const taskId = uuid()
    startTask({ id: taskId, nodeId: `sb-kf-${row.id}`, itemId: row.id, prompt: 'Keyframe' })
    updateTask(taskId, { status: 'polling' })
    updateRow(row.id, { status: 'in_progress' })

    // Compute canvas placement for new nodes up front so the resolver
    // can place freshly-created asset/item nodes near the keyframe.
    const rows = useStoryboardStore.getState().rows
    const rowIdx = rows.findIndex((r) => r.id === row.id)
    const baseX = 400
    const baseY = rowIdx * 300

    // Resolve every populated slot to a real canvas node (asset node preferred),
    // collect the canonical image URL for each one, and keep them in stable
    // order so the prompt's "imageN" labels match the inputs array.
    const slotRefs = collectSlotRefs(row)
    const offsetByKey: Record<SlotRef['slotKey'], number> = {
      character1: -140, character2: -70, prop1: 70, prop2: 140, scene: 0,
    }
    const refs: Array<{ role: string; description: string; nodeId: string; imageUrl: string; slotKey: SlotRef['slotKey']; slot: ElementSlot }> = []
    for (const sr of slotRefs) {
      const { nodeId, imageUrl } = resolveSlotNode(
        sr.slot, sr.preferredTypes,
        `${sr.role}-${row.shot_number}`,
        baseX - 300, baseY + offsetByKey[sr.slotKey],
      )
      if (!nodeId && !imageUrl) continue
      refs.push({ role: sr.role, description: sr.description, nodeId, imageUrl, slotKey: sr.slotKey, slot: sr.slot })
    }
    // Include row.reference_image as a tail "image" entry only if it's not
    // already represented by one of the slot images.
    if (row.reference_image && !refs.some((r) => r.imageUrl === row.reference_image)) {
      refs.push({
        role: '参考', description: '', nodeId: '',
        imageUrl: row.reference_image, slotKey: 'scene', slot: { image: row.reference_image, description: '', nodeId: '' },
      })
    }

    // Build prompt: base description + ordered "imageN" legend.
    const imageInputs = refs.filter((r) => r.imageUrl)
    const legend = imageInputs.length
      ? `Reference images (use them as labeled):\n` +
        imageInputs.map((r, i) =>
          `- image${i + 1} = ${r.role}${r.description ? ` (${r.description})` : ''}`
        ).join('\n')
      : ''
    const prompt = legend ? `${baseDescription}\n\n${legend}` : baseDescription

    try {
      const result = await runCapability({
        capability: 'text-to-image',
        inputs: [
          { kind: 'text', text: prompt },
          ...imageInputs.map((r) => ({ kind: 'image' as const, url: r.imageUrl })),
        ],
        params: { aspect: '16:9' },
      })

      const url = result.outputs[0]?.url
      if (!url) throw new Error('no keyframe result')

      const kfItemId = useCanvasItemStore.getState().addItem({
        kind: 'image',
        name: `KF-${row.shot_number}`,
        content: url,
        prompt,
      })
      const kfNodeId = useCanvasStore.getState().addItemNode(
        kfItemId, 'image',
        { x: baseX, y: baseY },
        { width: 280, height: 180 },
      )

      // Wire edges from each resolved ref node into the keyframe and persist
      // the resolved nodeId back into the slot so future regens reuse it.
      const updatedSlots: Partial<Pick<StoryboardRow, 'character1' | 'character2' | 'prop1' | 'prop2' | 'scene'>> = {}
      for (const r of refs) {
        if (!r.nodeId) continue
        useCanvasStore.getState().addEdge(r.nodeId, kfNodeId)
        if (r.slotKey && r.role !== '参考') {
          updatedSlots[r.slotKey] = { ...r.slot, nodeId: r.nodeId, image: r.imageUrl || r.slot.image }
        }
      }

      updateRow(row.id, {
        keyframeUrl: url,
        reference_image: url,
        keyframeNodeId: kfNodeId,
        status: 'done',
        ...updatedSlots,
      })
      updateTask(taskId, { status: 'done', resultUrl: url, resultKind: 'image' })
      toast.success(`Keyframe ${row.shot_number} 生成完成`)
    } catch (e) {
      updateRow(row.id, { status: 'todo' })
      updateTask(taskId, { status: 'failed', error: String((e as Error).message ?? e) })
      toast.error('Keyframe 生成失败', { description: String((e as Error).message).slice(0, 200) })
    }
  }, [updateRow, startTask, updateTask])

  const generateBeatVideo = useCallback(async (row: StoryboardRow) => {
    const baseDescription = [
      row.motion_prompts,
      row.visual_description,
      row.character_actions,
      row.emotion_mood,
      row.emotion_atmosphere,
      row.character_motivation ? `character motivation: ${row.character_motivation}` : '',
      row.character_psychology ? `inner psychology: ${row.character_psychology}` : '',
      row.performance_guidance ? `performance guidance: ${row.performance_guidance}` : '',
      row.lighting_atmosphere,
      row.shot_size ? `${row.shot_size} shot` : '',
    ].filter(Boolean).join('. ')
    if (!baseDescription.trim() && !row.keyframeUrl) { toast.error('缺少运动提示词或 keyframe'); return }

    const taskId = uuid()
    startTask({ id: taskId, nodeId: `sb-bv-${row.id}`, itemId: row.id, prompt: 'Beat Video' })
    updateTask(taskId, { status: 'polling' })

    try {
      // Ordered, labeled references — keyframe first (most important),
      // then per-role slots, then loose reference image.
      type BvRef = { role: string; description: string; url: string }
      const bvRefs: BvRef[] = []
      const pushRef = (role: string, description: string, url: string | undefined) => {
        if (!url) return
        if (bvRefs.some((r) => r.url === url)) return
        bvRefs.push({ role, description, url })
      }
      pushRef('Keyframe', '', row.keyframeUrl)
      pushRef('角色1', row.character1?.description ?? '', row.character1?.image)
      pushRef('角色2', row.character2?.description ?? '', row.character2?.image)
      pushRef('道具1', row.prop1?.description ?? '',      row.prop1?.image)
      pushRef('道具2', row.prop2?.description ?? '',      row.prop2?.image)
      pushRef('场景',  row.scene?.description ?? '',      row.scene?.image)
      pushRef('参考',  '',                                row.reference_image)

      const legend = bvRefs.length
        ? `Reference images (use them as labeled):\n` +
          bvRefs.map((r, i) =>
            `- image${i + 1} = ${r.role}${r.description ? ` (${r.description})` : ''}`
          ).join('\n')
        : ''
      const prompt = legend
        ? `${baseDescription || 'cinematic motion'}\n\n${legend}`
        : baseDescription || 'cinematic motion'

      const result = await runCapability({
        capability: 'text-to-video',
        inputs: [
          { kind: 'text', text: prompt },
          ...bvRefs.map((r) => ({ kind: 'image' as const, url: r.url })),
        ],
        params: {
          duration: String(Math.min(Math.max(Math.round(row.duration), 5), 10)),
          aspect: '16:9',
        },
      })

      const url = result.outputs[0]?.url
      if (!url) throw new Error('no video result')

      // Create beat video node on canvas, connected to keyframe
      const rows = useStoryboardStore.getState().rows
      const rowIdx = rows.findIndex((r) => r.id === row.id)
      const baseX = 750
      const baseY = rowIdx * 300

      const vidItemId = useCanvasItemStore.getState().addItem({
        kind: 'image', // renders in image node (video URL displayed)
        name: `BV-${row.shot_number}`,
        content: url,
        prompt,
      })
      const vidNodeId = useCanvasStore.getState().addItemNode(
        vidItemId, 'image',
        { x: baseX, y: baseY },
        { width: 360, height: 200 },
      )

      // Connect keyframe → beat video
      if (row.keyframeNodeId) {
        useCanvasStore.getState().addEdge(row.keyframeNodeId, vidNodeId)
      }

      updateRow(row.id, { beatVideoUrl: url, beatVideoNodeId: vidNodeId })
      updateTask(taskId, { status: 'done', resultUrl: url, resultKind: 'video' })
      toast.success(`Beat Video ${row.shot_number} 生成完成`)
    } catch (e) {
      updateTask(taskId, { status: 'failed', error: String((e as Error).message ?? e) })
      toast.error('Beat Video 生成失败', { description: String((e as Error).message).slice(0, 200) })
    }
  }, [updateRow, startTask, updateTask])

  return { generateKeyframe, generateBeatVideo }
}
