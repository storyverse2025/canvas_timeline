import { useMemo, useState } from 'react'
import { X, Check, Image as ImageIcon, Music, Video as VideoIcon } from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'
import { cn } from '@/lib/utils'

export type AssetPickKind = 'image' | 'audio' | 'video'

export interface PickedAsset {
  url: string
  kind: AssetPickKind
}

interface AssetOption {
  id: string
  name: string
  url: string
  kind: AssetPickKind
  source: string // "画布" / "资产库" etc
}

interface Props {
  /** Callback receives picked assets WITH their kind, so the caller
   *  routes audio refs to audio_url inputs and image refs to image_url.
   *  (Voice / video nodes used to be silently excluded — see PR description.) */
  onSelect: (picked: PickedAsset[]) => void
  onClose: () => void
  /** If true, allow multi-select. Default: single */
  multi?: boolean
  /** Restrict the picker to a subset of kinds (default: all of image/audio/video). */
  allowedKinds?: ReadonlySet<AssetPickKind>
}

const KIND_BADGE: Record<AssetPickKind, { label: string; Icon: typeof ImageIcon }> = {
  image: { label: '图片', Icon: ImageIcon },
  audio: { label: '音色', Icon: Music },
  video: { label: '视频', Icon: VideoIcon },
}

export function AssetPickerDialog({ onSelect, onClose, multi = true, allowedKinds }: Props) {
  const canvasNodes = useCanvasStore((s) => s.nodes)
  const items = useCanvasItemStore((s) => s.items)
  const legacyAssets = useAssetStore((s) => s.assets)
  const [selected, setSelected] = useState<Map<string, AssetPickKind>>(new Map())

  const allowed = allowedKinds ?? new Set<AssetPickKind>(['image', 'audio', 'video'])

  const assets = useMemo<AssetOption[]>(() => {
    const result: AssetOption[] = []
    const seen = new Set<string>()
    const isAllowed = (k: AssetPickKind) => allowed.has(k)

    // From canvas item-store nodes — now includes audio + video, not just image.
    for (const node of canvasNodes) {
      const itemId = node.data?.itemId as string | undefined
      if (itemId) {
        const it = items[itemId]
        if (it && (it.kind === 'image' || it.kind === 'audio' || it.kind === 'video')
            && it.content && !seen.has(it.content) && isAllowed(it.kind)) {
          seen.add(it.content)
          result.push({ id: it.id, name: it.name, url: it.content, kind: it.kind, source: '画布' })
        }
      }
      const assetId = node.data?.assetId as string | undefined
      if (assetId) {
        const a = legacyAssets.find((x) => x.id === assetId)
        if (a?.imageUrl && !seen.has(a.imageUrl) && isAllowed('image')) {
          seen.add(a.imageUrl)
          result.push({ id: a.id, name: a.name, url: a.imageUrl, kind: 'image', source: a.type })
        }
      }
    }

    // Also include item-store items not on canvas (image/audio/video).
    for (const it of Object.values(items)) {
      if ((it.kind === 'image' || it.kind === 'audio' || it.kind === 'video')
          && it.content && !seen.has(it.content) && isAllowed(it.kind)) {
        seen.add(it.content)
        result.push({ id: it.id, name: it.name, url: it.content, kind: it.kind, source: '未在画布' })
      }
    }

    return result
  }, [canvasNodes, items, legacyAssets, allowed])

  const toggle = (url: string, kind: AssetPickKind) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(url)) next.delete(url)
      else if (multi) next.set(url, kind)
      else { next.clear(); next.set(url, kind) }
      return next
    })
  }

  const handleConfirm = () => {
    onSelect(Array.from(selected, ([url, kind]) => ({ url, kind })))
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[600px] max-w-full max-h-[80vh] bg-card border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-medium">选择画布资产 ({selected.size} 已选)</span>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-3">
          {assets.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-xs text-muted-foreground">
              画布上还没有可用资产
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {assets.map((a) => {
                const isSelected = selected.has(a.url)
                const KindIcon = KIND_BADGE[a.kind].Icon
                return (
                  <button
                    key={a.id}
                    className={cn(
                      'relative rounded border-2 overflow-hidden transition-colors text-left',
                      isSelected ? 'border-primary' : 'border-border hover:border-foreground/30',
                    )}
                    onClick={() => toggle(a.url, a.kind)}
                  >
                    {a.kind === 'image' ? (
                      <img src={a.url} alt={a.name} className="w-full aspect-square object-cover" />
                    ) : (
                      <div className="w-full aspect-square bg-muted/40 flex items-center justify-center">
                        <KindIcon className="w-8 h-8 text-muted-foreground" />
                      </div>
                    )}
                    <div className="p-1 text-[9px] truncate">
                      <div className="font-medium truncate flex items-center gap-1">
                        <KindIcon className="w-2.5 h-2.5 opacity-60 shrink-0" />
                        <span className="truncate">{a.name}</span>
                      </div>
                      <div className="text-muted-foreground">{KIND_BADGE[a.kind].label} · {a.source}</div>
                    </div>
                    {isSelected && (
                      <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                        <Check className="w-3 h-3" />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>取消</button>
          <button
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
            disabled={selected.size === 0}
            onClick={handleConfirm}
          >添加 {selected.size} 个</button>
        </div>
      </div>
    </div>
  )
}
