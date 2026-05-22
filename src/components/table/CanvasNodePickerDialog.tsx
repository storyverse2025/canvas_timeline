/**
 * CanvasNodePickerDialog
 *
 * The storyboard table no longer accepts file uploads. Instead, every media
 * slot opens this picker so the chosen URL is always backed by a canvas node
 * — keeping the table tightly bound to the canvas as a single source of truth.
 *
 * Users still upload their own media via the canvas (drag/drop or
 * NodeContextMenu), then pick it here.
 *
 * Filter rules (driven by the slot kind):
 *   image  → canvas image item-nodes  +  every asset (character/scene/prop/
 *            keyframe — assets are always image-backed)
 *   video  → canvas video item-nodes
 *   audio  → canvas audio item-nodes (new; users add audio to the canvas the
 *            same way they add images/videos)
 */

import { useMemo, useState } from 'react'
import { Image as ImageIcon, Video, Volume2, Search, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'
import { thumb } from '@/lib/thumb'

export type CanvasNodePickerKind = 'image' | 'video' | 'audio'

export interface PickedNode {
  nodeId: string
  url: string
  name: string
  source: 'item' | 'asset'
}

interface Props {
  open: boolean
  kind: CanvasNodePickerKind
  /** Optional dialog title override; defaults to a kind-aware label. */
  title?: string
  onClose: () => void
  onPick: (picked: PickedNode) => void
}

const KIND_LABEL: Record<CanvasNodePickerKind, string> = {
  image: '图片节点',
  video: '视频节点',
  audio: '音频节点',
}

const KIND_ICON = {
  image: ImageIcon,
  video: Video,
  audio: Volume2,
} as const

/**
 * Walk every canvas node and emit one PickedNode per node whose backing item
 * or asset matches the requested media kind.
 */
function collectMatchingNodes(kind: CanvasNodePickerKind): PickedNode[] {
  const nodes = useCanvasStore.getState().nodes
  const items = useCanvasItemStore.getState().items
  const assets = useAssetStore.getState().assets

  const out: PickedNode[] = []

  for (const n of nodes) {
    const data = n.data ?? {}
    const assetId = (data as { assetId?: string }).assetId
    const itemId = (data as { itemId?: string }).itemId

    if (assetId && kind === 'image') {
      // Assets are always image-backed (character / scene / prop / keyframe).
      const asset = assets.find((a) => a.id === assetId)
      if (asset?.imageUrl) {
        out.push({ nodeId: n.id, name: asset.name, url: asset.imageUrl, source: 'asset' })
      }
      continue
    }

    if (itemId) {
      const item = items[itemId]
      if (!item || !item.content) continue
      if (item.kind !== kind) continue
      out.push({ nodeId: n.id, name: item.name, url: item.content, source: 'item' })
    }
  }

  return out
}

export function CanvasNodePickerDialog({ open, kind, title, onClose, onPick }: Props) {
  const [filter, setFilter] = useState('')

  // Re-collect on every open so newly-added canvas nodes show up.
  const matches = useMemo(() => (open ? collectMatchingNodes(kind) : []), [open, kind])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return matches
    return matches.filter((m) => m.name.toLowerCase().includes(q))
  }, [matches, filter])

  const Icon = KIND_ICON[kind]
  const heading = title ?? `从画布选取${KIND_LABEL[kind]}`

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Icon className="w-4 h-4" />
            {heading}
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按名称过滤…"
            className="pl-7 text-xs"
            autoFocus
          />
        </div>

        {matches.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            画布上还没有{KIND_LABEL[kind]}。
            <br />
            先在画布拖入或生成一个{KIND_LABEL[kind]}，再回到这里选取。
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-xs text-muted-foreground">
            没有名称包含 "{filter}" 的{KIND_LABEL[kind]}。
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 max-h-[420px] overflow-auto pr-1">
            {filtered.map((m) => (
              <button
                key={m.nodeId}
                type="button"
                onClick={() => {
                  onPick(m)
                  onClose()
                }}
                className="group flex flex-col gap-1 rounded border border-border bg-background hover:border-primary hover:bg-accent text-left p-2"
                title={`${m.name} · node ${m.nodeId.slice(0, 6)}`}
              >
                <div className="relative h-24 w-full rounded bg-zinc-800/70 overflow-hidden flex items-center justify-center">
                  {kind === 'image' && (
                    <img src={thumb(m.url, 256)} alt={m.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  )}
                  {kind === 'video' && (
                    <video src={m.url} className="h-full w-full object-cover" muted preload="metadata" />
                  )}
                  {kind === 'audio' && <Volume2 className="w-6 h-6 text-zinc-500" />}
                  <span className="absolute bottom-1 right-1 text-[9px] px-1 py-0.5 rounded bg-black/60 text-white">
                    {m.source === 'asset' ? 'asset' : 'node'}
                  </span>
                </div>
                <div className="text-[11px] truncate">{m.name || '(未命名)'}</div>
                <div className="text-[9px] text-muted-foreground">{m.nodeId.slice(0, 6)}</div>
              </button>
            ))}
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-xs rounded border border-border hover:bg-accent inline-flex items-center gap-1"
          >
            <X className="w-3 h-3" /> 取消
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
