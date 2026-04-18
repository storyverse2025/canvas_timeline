import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { toast } from 'sonner'
import { libtvGenerate, libtvQuery, extractMediaUrl } from '@/lib/libtv-client'
import { callProvider } from '@/lib/providers/client'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import type { ProviderId, MediaKind } from '@/lib/providers/types'

/**
 * Ensure refImages are reachable by remote provider servers:
 * - '/samples/x.png' → 'http(s)://<origin>/samples/x.png'
 * - reject data: URLs for providers that don't accept them (Doubao video)
 */
function normalizeRefImages(urls: string[] | undefined): { refs: string[]; skipped: string[] } {
  if (!urls?.length) return { refs: [], skipped: [] }
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const refs: string[] = []
  const skipped: string[] = []
  for (const u of urls) {
    if (!u) continue
    let abs = u
    if (u.startsWith('/')) abs = origin + u
    if (/^https?:\/\//i.test(abs) || abs.startsWith('data:')) { refs.push(abs); continue }
    skipped.push(u)
  }
  return { refs, skipped }
}

const POLL_INTERVAL_MS = 4000
const POLL_TIMEOUT_MS = 10 * 60 * 1000

export interface GenerateArgs {
  nodeId: string;
  itemId: string;
  prompt: string;
  provider?: ProviderId;
  model?: string;
  refImages?: string[];
  aspect?: string;
  duration?: number;
  /** If set and differs from the source item kind, a new downstream node is created. */
  targetKind?: MediaKind;
}

/**
 * Ensure the generation result lands on the right node:
 * - If the source node is already the correct kind → write back to it.
 * - Otherwise spawn a new node, connect source → new, return new ids.
 */
function resolveTargetNode(args: GenerateArgs): { nodeId: string; itemId: string } {
  const targetKind = args.targetKind
  if (!targetKind || targetKind === 'audio') return { nodeId: args.nodeId, itemId: args.itemId }

  const srcItem = useCanvasItemStore.getState().items[args.itemId]
  if (srcItem && srcItem.kind === targetKind) return { nodeId: args.nodeId, itemId: args.itemId }

  // Spawn a new image/video node downstream of the source.
  const srcNode = useCanvasStore.getState().nodes.find((n) => n.id === args.nodeId)
  const basePos = srcNode?.position ?? { x: 0, y: 0 }
  const srcW = (srcNode?.style?.width as number) ?? srcNode?.width ?? 280
  const srcH = (srcNode?.style?.height as number) ?? srcNode?.height ?? 200
  const newPos = { x: basePos.x + srcW + 60, y: basePos.y }
  const size = targetKind === 'video' ? { width: 360, height: 200 } : { width: 280, height: 200 }

  // Canvas only has 'image' / 'text' node types today — render videos inside the image node
  // (the ImageCanvasNode renders `<img>`; for MP4 URLs the browser shows a broken icon, so we
  // route videos through image nodes visually for now, but the item itself is tagged `image`
  // so the downstream workflow still works. Content URL is the video URL.)
  const canvasKind: 'image' | 'text' = targetKind === 'video' ? 'image' : 'image'
  const newItemId = useCanvasItemStore.getState().addItem({
    kind: canvasKind,
    name: targetKind === 'video' ? '生成视频' : '生成图片',
    content: '',
  })
  const newNodeId = useCanvasStore.getState().addItemNode(newItemId, canvasKind, newPos, size)
  useCanvasStore.getState().addEdge(args.nodeId, newNodeId)
  return { nodeId: newNodeId, itemId: newItemId }
}

export function useLibtvGenerate() {
  const startTask = useLibtvTasksStore((s) => s.startTask)
  const updateTask = useLibtvTasksStore((s) => s.updateTask)
  const updateItem = useCanvasItemStore((s) => s.updateItem)

  return useCallback(async (args: GenerateArgs) => {
    const target = resolveTargetNode(args)
    const taskId = uuid()
    startTask({ id: taskId, nodeId: target.nodeId, itemId: target.itemId, prompt: args.prompt })

    const provider: ProviderId = args.provider ?? 'libtv'
    const fail = (msg: string) => {
      updateTask(taskId, { status: 'failed', error: msg })
      toast.error('生成失败', { description: msg.slice(0, 240) })
    }

    try {
      if (provider === 'libtv') {
        const created = await libtvGenerate(args.prompt)
        if (created.error || !created.sessionId) return fail(created.error ?? 'no sessionId')
        updateTask(taskId, { sessionId: created.sessionId, status: 'polling' })
        const first = await libtvQuery(created.sessionId)
        const baseline = extractMediaUrl(first)?.url

        const deadline = Date.now() + POLL_TIMEOUT_MS
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          const q = await libtvQuery(created.sessionId)
          const media = extractMediaUrl(q)
          if (media && media.url !== baseline) {
            updateItem(target.itemId, {
              content: media.url,
              prompt: args.prompt,
              refImages: args.refImages,
              provider: args.provider,
              model: args.model,
            })
            updateTask(taskId, { status: 'done', resultUrl: media.url, resultKind: media.kind })
            return
          }
        }
        return fail('timeout')
      }

      updateTask(taskId, { status: 'polling' })
      const { refs, skipped } = normalizeRefImages(args.refImages)
      if (skipped.length > 0) {
        toast.warning(`已跳过 ${skipped.length} 张无法提供给远端的参考图`, {
          description: '本地路径或 data: URL 无法被云端 API 访问',
        })
      }
      const r = await callProvider({
        provider,
        model: args.model ?? '',
        prompt: args.prompt,
        refImages: refs,
        aspect: args.aspect,
        duration: args.duration,
      })
      updateItem(target.itemId, {
        content: r.url,
        prompt: args.prompt,
        refImages: args.refImages,
        provider: args.provider,
        model: args.model,
      })
      updateTask(taskId, { status: 'done', resultUrl: r.url, resultKind: r.kind })
      toast.success(r.kind === 'video' ? '视频生成完成' : '图片生成完成')
    } catch (e) {
      fail(String((e as Error).message ?? e))
    }
  }, [startTask, updateTask, updateItem])
}
