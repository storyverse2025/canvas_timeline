import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { toast } from 'sonner'
import { runCapability } from '@/lib/capabilities/client'
import { getCapability } from '@/lib/capabilities/registry'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useProjectDB } from '@/stores/project-db'
import type { CapabilityInput } from '@/lib/capabilities/types'

export interface RunCapabilityArgs {
  capabilityId: string
  nodeId: string
  itemId: string
  params?: Record<string, unknown>
  extraInputs?: CapabilityInput[]
}

export function useCapability() {
  const startTask = useLibtvTasksStore((s) => s.startTask)
  const updateTask = useLibtvTasksStore((s) => s.updateTask)

  return useCallback(async (args: RunCapabilityArgs) => {
    const cap = getCapability(args.capabilityId)
    if (!cap) { toast.error(`未知能力: ${args.capabilityId}`); return }

    const item = useCanvasItemStore.getState().items[args.itemId]
    if (!item) { toast.error('节点数据不存在'); return }

    const taskId = uuid()
    startTask({ id: taskId, nodeId: args.nodeId, itemId: args.itemId, prompt: `${cap.label}` })
    updateTask(taskId, { status: 'polling' })

    try {
      // Build inputs from the source node only (no automatic upstream gathering —
      // the dialog already composed prompt + refs before calling us).
      const inputs: CapabilityInput[] = []

      // Source node content
      if (item.kind === 'image' && item.content) {
        if (/\.(mp4|webm|mov)(\?|$)/i.test(item.content)) {
          inputs.push({ kind: 'video', url: item.content })
        } else {
          inputs.push({ kind: 'image', url: item.content })
        }
      }
      if (item.kind === 'text' && item.content) {
        inputs.push({ kind: 'text', text: item.content })
      }

      // Extra inputs from dialog (prompt text, ref images, etc.)
      if (args.extraInputs) inputs.push(...args.extraInputs)

      const result = await runCapability({
        capability: args.capabilityId,
        inputs,
        params: args.params,
      })

      if (!result.outputs.length) throw new Error('no output')

      // Create a new downstream node for each output (batch-image returns multiple)
      const srcNode = useCanvasStore.getState().nodes.find((n) => n.id === args.nodeId)
      const pos = srcNode?.position ?? { x: 0, y: 0 }
      const srcW = (srcNode?.style?.width as number) ?? srcNode?.width ?? 280
      const nodeGap = 20

      for (let i = 0; i < result.outputs.length; i++) {
        const output = result.outputs[i]
        if (output.kind === 'text') {
          const newItemId = useCanvasItemStore.getState().addItem({
            kind: 'text',
            name: cap.label,
            content: output.text ?? '',
          })
          const newNodeId = useCanvasStore.getState().addItemNode(
            newItemId, 'text',
            { x: pos.x + srcW + 60, y: pos.y + i * (200 + nodeGap) },
            { width: 300, height: 200 },
          )
          useCanvasStore.getState().addEdge(args.nodeId, newNodeId)
        } else {
          const newItemId = useCanvasItemStore.getState().addItem({
            kind: 'image',
            name: result.outputs.length > 1 ? `${cap.label} ${i + 1}` : cap.label,
            content: output.url ?? '',
          })
          const size = output.kind === 'video'
            ? { width: 360, height: 200 }
            : { width: 280, height: 200 }
          const newNodeId = useCanvasStore.getState().addItemNode(
            newItemId, 'image',
            { x: pos.x + srcW + 60 + i * (280 + nodeGap), y: pos.y },
            size,
          )
          useCanvasStore.getState().addEdge(args.nodeId, newNodeId)
        }
      }

      const output = result.outputs[0]
      updateTask(taskId, { status: 'done', resultUrl: output.url ?? '', resultKind: (output.kind === 'video' ? 'video' : 'image') as 'image' | 'video' })
      // Log to generation history
      useProjectDB.getState().addHistoryEntry({
        capability: args.capabilityId,
        prompt: inputs.filter((i) => i.kind === 'text').map((i) => i.text ?? '').join(' '),
        inputs,
        params: args.params ?? {},
        resultUrl: output.url,
        resultKind: output.kind as 'image' | 'video' | 'audio' | 'text',
        status: 'done',
      })
      toast.success(`${cap.label} 完成`)
    } catch (e) {
      updateTask(taskId, { status: 'failed', error: String((e as Error).message ?? e) })
      useProjectDB.getState().addHistoryEntry({
        capability: args.capabilityId,
        prompt: '',
        inputs: [],
        params: args.params ?? {},
        resultKind: cap.outputKind as 'image' | 'video' | 'audio' | 'text',
        status: 'failed',
        error: String((e as Error).message ?? e),
      })
      toast.error(`${cap.label} 失败`, { description: String((e as Error).message).slice(0, 240) })
    }
  }, [startTask, updateTask])
}
