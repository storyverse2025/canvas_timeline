import { useMemo, useState } from 'react'
import { X, Check } from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useAssetStore } from '@/stores/asset-store'
import { cn } from '@/lib/utils'

interface AssetOption {
  id: string
  name: string
  url: string
  source: string // "画布" / "资产库" etc
}

interface Props {
  onSelect: (urls: string[]) => void
  onClose: () => void
  /** If true, allow multi-select. Default: single */
  multi?: boolean
}

export function AssetPickerDialog({ onSelect, onClose, multi = true }: Props) {
  const canvasNodes = useCanvasStore((s) => s.nodes)
  const items = useCanvasItemStore((s) => s.items)
  const legacyAssets = useAssetStore((s) => s.assets)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const assets = useMemo<AssetOption[]>(() => {
    const result: AssetOption[] = []
    const seen = new Set<string>()

    // From canvas item-store nodes
    for (const node of canvasNodes) {
      const itemId = node.data?.itemId as string | undefined
      if (itemId) {
        const it = items[itemId]
        if (it?.kind === 'image' && it.content && !seen.has(it.content)) {
          seen.add(it.content)
          result.push({ id: it.id, name: it.name, url: it.content, source: '画布' })
        }
      }
      const assetId = node.data?.assetId as string | undefined
      if (assetId) {
        const a = legacyAssets.find((x) => x.id === assetId)
        if (a?.imageUrl && !seen.has(a.imageUrl)) {
          seen.add(a.imageUrl)
          result.push({ id: a.id, name: a.name, url: a.imageUrl, source: a.type })
        }
      }
    }

    // Also include item-store items not on canvas
    for (const it of Object.values(items)) {
      if (it.kind === 'image' && it.content && !seen.has(it.content)) {
        seen.add(it.content)
        result.push({ id: it.id, name: it.name, url: it.content, source: '未在画布' })
      }
    }

    return result
  }, [canvasNodes, items, legacyAssets])

  const toggle = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else if (multi) next.add(url)
      else { next.clear(); next.add(url) }
      return next
    })
  }

  const handleConfirm = () => {
    onSelect(Array.from(selected))
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
              画布上还没有图片资产
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {assets.map((a) => {
                const isSelected = selected.has(a.url)
                return (
                  <button
                    key={a.id}
                    className={cn(
                      'relative rounded border-2 overflow-hidden transition-colors',
                      isSelected ? 'border-primary' : 'border-border hover:border-foreground/30',
                    )}
                    onClick={() => toggle(a.url)}
                  >
                    <img src={a.url} alt={a.name} className="w-full aspect-square object-cover" />
                    <div className="p-1 text-[9px] truncate text-left">
                      <div className="font-medium truncate">{a.name}</div>
                      <div className="text-muted-foreground">{a.source}</div>
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
          >添加 {selected.size} 张</button>
        </div>
      </div>
    </div>
  )
}
