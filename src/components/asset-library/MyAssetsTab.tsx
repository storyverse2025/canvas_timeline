import { useMemo, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectDB, type ElementRole } from '@/stores/project-db'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useViewStore } from '@/stores/view-store'
import { AssetCard } from './AssetCard'
import { CategoryFilter } from './CategoryFilter'

export function MyAssetsTab() {
  const [filter, setFilter] = useState<ElementRole | 'all'>('all')
  const elements = useProjectDB((s) => s.elements)
  const addElement = useProjectDB((s) => s.addElement)
  const fileRef = useRef<HTMLInputElement>(null)

  const manualAssets = useMemo(() => {
    const all = Object.values(elements).filter((e) => e.source === 'manual')
    if (filter === 'all') return all.sort((a, b) => b.createdAt - a.createdAt)
    return all.filter((e) => e.role === filter).sort((a, b) => b.createdAt - a.createdAt)
  }, [elements, filter])

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const dataUrl = reader.result
        const name = f.name.replace(/\.[^.]+$/, '')
        // Save to ProjectDB
        addElement({
          kind: 'image',
          role: 'unknown',
          name,
          content: dataUrl,
          description: '',
          source: 'manual',
        })
        // Also create a canvas node so it appears on the canvas
        const itemId = useCanvasItemStore.getState().addItem({
          kind: 'image',
          name,
          content: dataUrl,
        })
        // Place near center of current viewport
        const nodes = useCanvasStore.getState().nodes
        const maxY = nodes.length > 0
          ? Math.max(...nodes.map((n) => n.position.y + ((n.style?.height as number) ?? n.height ?? 160))) + 20
          : 50
        const nodeId = useCanvasStore.getState().addItemNode(itemId, 'image', { x: 50, y: maxY }, { width: 200, height: 200 })
        console.log('[AssetLibrary] Created canvas node:', nodeId, 'at y:', maxY, 'total nodes:', useCanvasStore.getState().nodes.length)
        toast.success(`已上传 ${f.name} → 画布已添加节点，请切到画布查看`)
      }
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  return (
    <div className="flex flex-col h-full">
      <CategoryFilter value={filter} onChange={setFilter} />
      <div className="px-2 pb-2">
        <button
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] rounded border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="w-3 h-3" /> 上传素材
        </button>
        <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" className="hidden" onChange={handleUpload} />
      </div>
      {manualAssets.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-4 text-center">
          暂无手动创建的资产<br />右键画布节点 →「创建资产」<br />或点击上方上传
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-2">
          <div className="grid grid-cols-2 gap-2">
            {manualAssets.map((el) => (
              <AssetCard key={el.id} element={el} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
