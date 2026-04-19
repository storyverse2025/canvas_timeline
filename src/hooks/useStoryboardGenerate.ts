import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { toast } from 'sonner'
import { runCapability } from '@/lib/capabilities/client'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import type { StoryboardRow } from '@/types/storyboard'

/**
 * Find or create a canvas node for an element slot (character, prop, scene).
 * Returns the nodeId. If a node already exists with that nodeId, reuse it.
 */
function ensureElementNode(
  slotImage: string,
  slotDesc: string,
  slotNodeId: string,
  label: string,
  baseX: number,
  baseY: number,
): string {
  if (slotNodeId) {
    const existing = useCanvasStore.getState().nodes.find((n) => n.id === slotNodeId)
    if (existing) return slotNodeId
  }
  if (!slotImage && !slotDesc) return ''

  const kind = slotImage ? 'image' : 'text'
  const itemId = useCanvasItemStore.getState().addItem({
    kind,
    name: label,
    content: slotImage || slotDesc,
  })
  const nodeId = useCanvasStore.getState().addItemNode(
    itemId, kind,
    { x: baseX, y: baseY },
    kind === 'image' ? { width: 160, height: 120 } : { width: 200, height: 100 },
  )
  return nodeId
}

export function useStoryboardGenerate() {
  const updateRow = useStoryboardStore((s) => s.updateRow)
  const startTask = useLibtvTasksStore((s) => s.startTask)
  const updateTask = useLibtvTasksStore((s) => s.updateTask)

  const generateKeyframe = useCallback(async (row: StoryboardRow) => {
    const prompt = [
      row.storyboard_prompts,
      row.visual_description,
      row.lighting_atmosphere,
      row.emotion_mood,
      row.shot_size ? `${row.shot_size} shot` : '',
    ].filter(Boolean).join('. ')
    if (!prompt.trim()) { toast.error('缺少画面描述或分镜提示词'); return }

    const taskId = uuid()
    startTask({ id: taskId, nodeId: `sb-kf-${row.id}`, itemId: row.id, prompt: 'Keyframe' })
    updateTask(taskId, { status: 'polling' })
    updateRow(row.id, { status: 'in_progress' })

    try {
      // Collect reference images from element slots
      const refImages = [
        row.character1?.image, row.character2?.image,
        row.prop1?.image, row.prop2?.image,
        row.scene?.image, row.reference_image,
      ].filter((u): u is string => !!u && u.length > 0)

      const result = await runCapability({
        capability: 'text-to-image',
        inputs: [
          { kind: 'text', text: prompt },
          ...refImages.map((url) => ({ kind: 'image' as const, url })),
        ],
        params: { aspect: '16:9' },
      })

      const url = result.outputs[0]?.url
      if (!url) throw new Error('no keyframe result')

      // Create keyframe node on canvas
      const rows = useStoryboardStore.getState().rows
      const rowIdx = rows.findIndex((r) => r.id === row.id)
      const baseX = 400
      const baseY = rowIdx * 300

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

      // Ensure element nodes and connect them to the keyframe
      const elementSlots = [
        { slot: row.character1, label: `角色1-${row.shot_number}`, offsetY: -140 },
        { slot: row.character2, label: `角色2-${row.shot_number}`, offsetY: -70 },
        { slot: row.prop1, label: `道具1-${row.shot_number}`, offsetY: 70 },
        { slot: row.prop2, label: `道具2-${row.shot_number}`, offsetY: 140 },
        { slot: row.scene, label: `场景-${row.shot_number}`, offsetY: 0 },
      ]
      const updatedSlots: Record<string, { image: string; description: string; nodeId: string }> = {}
      for (const { slot, label, offsetY } of elementSlots) {
        if (!slot?.image && !slot?.description) continue
        const elNodeId = ensureElementNode(
          slot.image, slot.description, slot.nodeId,
          label, baseX - 300, baseY + offsetY,
        )
        if (elNodeId) {
          useCanvasStore.getState().addEdge(elNodeId, kfNodeId)
          // Update the slot's nodeId in the row
          const slotKey = elementSlots.find((e) => e.label === label)
          if (label.startsWith('角色1')) updatedSlots.character1 = { ...slot, nodeId: elNodeId }
          else if (label.startsWith('角色2')) updatedSlots.character2 = { ...slot, nodeId: elNodeId }
          else if (label.startsWith('道具1')) updatedSlots.prop1 = { ...slot, nodeId: elNodeId }
          else if (label.startsWith('道具2')) updatedSlots.prop2 = { ...slot, nodeId: elNodeId }
          else if (label.startsWith('场景')) updatedSlots.scene = { ...slot, nodeId: elNodeId }
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
    const prompt = [
      row.motion_prompts,
      row.visual_description,
      row.character_actions,
      row.emotion_mood,
      row.lighting_atmosphere,
      row.shot_size ? `${row.shot_size} shot` : '',
    ].filter(Boolean).join('. ')
    if (!prompt.trim() && !row.keyframeUrl) { toast.error('缺少运动提示词或 keyframe'); return }

    const taskId = uuid()
    startTask({ id: taskId, nodeId: `sb-bv-${row.id}`, itemId: row.id, prompt: 'Beat Video' })
    updateTask(taskId, { status: 'polling' })

    try {
      // Collect all available reference images from the row:
      // keyframe first (most important), then reference, characters, props, scene
      const refImages: string[] = [
        row.keyframeUrl,
        row.reference_image,
        row.character1?.image,
        row.character2?.image,
        row.prop1?.image,
        row.prop2?.image,
        row.scene?.image,
      ].filter((u): u is string => !!u && u.length > 0)

      const result = await runCapability({
        capability: 'text-to-video',
        inputs: [
          { kind: 'text', text: prompt || 'cinematic motion' },
          ...refImages.map((url) => ({ kind: 'image' as const, url })),
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
