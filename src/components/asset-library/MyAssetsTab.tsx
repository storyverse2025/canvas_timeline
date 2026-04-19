import { useMemo, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectDB, type ElementRole } from '@/stores/project-db'
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
        addElement({
          kind: 'image',
          role: 'unknown',
          name: f.name.replace(/\.[^.]+$/, ''),
          content: reader.result,
          description: '',
          source: 'manual',
        })
        toast.success(`已上传: ${f.name}`)
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
