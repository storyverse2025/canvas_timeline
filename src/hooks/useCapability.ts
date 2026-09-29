import { useCallback } from 'react'
import { logAction } from '@/lib/client-log'
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
  /** false → do not ship the node's own content as an input (re-shoot). */
  includeSourceContent?: boolean
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

      // Source node content. Skipped for a re-shoot (includeSourceContent: false):
      // the node's own previous OUTPUT would otherwise ship as an extra
      // reference_video — it blew the reference-video budget and, once its signed
      // TOS link expired, made the provider hang on a fetch it could never do.
      const dialogRefs = new Set((args.extraInputs ?? []).map((i) => i.url).filter(Boolean) as string[])
      const includeSource = args.includeSourceContent !== false
      if (includeSource && (item.kind === 'image' || item.kind === 'video') && item.content && !dialogRefs.has(item.content)) {
        if (item.kind === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(item.content)) {
          inputs.push({ kind: 'video', url: item.content })
        } else {
          inputs.push({ kind: 'image', url: item.content })
        }
      }
      if (includeSource && item.kind === 'audio' && item.content && !dialogRefs.has(item.content)) {
        inputs.push({ kind: 'audio', url: item.content })
      }
      if (includeSource && item.kind === 'text' && item.content) {
        inputs.push({ kind: 'text', text: item.content })
      }

      // Extra inputs from dialog (prompt text, ref images, etc.), deduped.
      const seenUrls = new Set(inputs.map((i) => i.url).filter(Boolean) as string[])
      for (const extra of args.extraInputs ?? []) {
        if (extra.url && seenUrls.has(extra.url)) continue
        if (extra.url) seenUrls.add(extra.url)
        inputs.push(extra)
      }

      logAction('capability.run', {
        capability: args.capabilityId,
        params: args.params,
        inputs: inputs.map((i) => (i.kind === 'text' ? `text(${(i.text ?? '').length})` : `${i.kind}=${i.url ?? ''}`)),
      })
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

      // If we're regenerating from an existing beat-video item, inherit the
      // role + BV-<shot> naming so the new sibling can be ⭐-promoted from
      // the canvas (same UX as the keyframe pattern).
      const srcItem = args.itemId ? useCanvasItemStore.getState().items[args.itemId] : undefined
      const inheritBeatVideoRole = srcItem?.role === 'beat-video'

      // Record what this generation actually received, so the node's Edit panel
      // ("Seedance 实际输入") and any later regen start from the same inputs
      // instead of an empty set.
      const urlsOfKind = (kind: 'image' | 'video' | 'audio') =>
        inputs.filter((i) => i.kind === kind && i.url).map((i) => i.url as string)
      const usedInputs = {
        prompt: inputs.filter((i) => i.kind === 'text').map((i) => i.text ?? '').join('\n').trim() || undefined,
        refImages: urlsOfKind('image'),
        refVideos: urlsOfKind('video'),
        refAudios: urlsOfKind('audio'),
        provider: args.params?.provider as string | undefined,
        model: args.params?.model as string | undefined,
        genParams: Object.fromEntries(
          Object.entries(args.params ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
        ),
      }

      // A capability that returns roles is describing a graph, not a list: the
      // shots feed the final cut, so they are wired to it rather than all
      // hanging off the source. Everything else keeps the flat fan-out.
      const shotNodeIds: string[] = []
      let finalNodeId: string | null = null
      const shotCount = result.outputs.filter((o) => o.role === 'shot').length
      let shotIndex = 0

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
          const isVideoOutput = output.kind === 'video'
          const newItemId = useCanvasItemStore.getState().addItem({
            kind: isVideoOutput ? 'video' : 'image',
            ...(isVideoOutput && inheritBeatVideoRole
              ? { role: 'beat-video', name: srcItem!.name }   // preserve "BV-S1"
              : { name: output.label ?? (result.outputs.length > 1 ? `${cap.label} ${i + 1}` : cap.label) }),
            content: output.url ?? '',
            ...usedInputs,
          })
          const size = isVideoOutput
            ? { width: 360, height: 200 }
            : { width: 280, height: 200 }
          // Shots stack in a column between the source and the final cut, so
          // the film reads left to right: source -> storyboard + shots -> final.
          let at = { x: pos.x + srcW + 60 + i * (280 + nodeGap), y: pos.y }
          if (output.role === 'shot') {
            at = { x: pos.x + srcW + 380, y: pos.y + shotIndex * (200 + nodeGap) }
            shotIndex += 1
          } else if (output.role === 'final') {
            at = { x: pos.x + srcW + 820, y: pos.y + Math.max(0, (shotCount - 1) / 2) * (200 + nodeGap) }
          } else if (output.role === 'storyboard') {
            at = { x: pos.x + srcW + 60, y: pos.y }
          }
          const newNodeId = useCanvasStore.getState().addItemNode(
            newItemId, isVideoOutput ? 'video' : 'image', at, size,
          )
          if (output.role === 'shot') {
            shotNodeIds.push(newNodeId)
            useCanvasStore.getState().addEdge(args.nodeId, newNodeId)
          } else if (output.role === 'final') {
            finalNodeId = newNodeId
          } else {
            useCanvasStore.getState().addEdge(args.nodeId, newNodeId)
          }
        }
      }

      // The final cut is fed by its shots, not by the image the run started from.
      if (finalNodeId) {
        const sources = shotNodeIds.length ? shotNodeIds : [args.nodeId]
        for (const s of sources) useCanvasStore.getState().addEdge(s, finalNodeId)
      }

      const output = result.outputs.find((o) => o.role === 'final') ?? result.outputs[0]
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
