import { useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectDB, type ElementRole } from '@/stores/project-db'
import { cn } from '@/lib/utils'

const ROLES: { value: ElementRole; label: string }[] = [
  { value: 'character', label: '角色' },
  { value: 'scene', label: '场景' },
  { value: 'prop', label: '道具' },
  { value: 'keyframe', label: 'Keyframe' },
  { value: 'unknown', label: '其他' },
]

interface Props {
  itemName: string
  itemContent: string
  itemKind: 'image' | 'text'
  onClose: () => void
}

export function CreateAssetDialog({ itemName, itemContent, itemKind, onClose }: Props) {
  const [name, setName] = useState(itemName)
  const [role, setRole] = useState<ElementRole>('character')
  const [description, setDescription] = useState('')
  const addElement = useProjectDB((s) => s.addElement)

  const handleCreate = () => {
    if (!name.trim()) { toast.error('请输入名称'); return }
    addElement({
      kind: itemKind,
      role,
      name: name.trim(),
      content: itemContent,
      description: description.trim(),
      source: 'manual',
    })
    toast.success(`已创建资产: ${name.trim()}`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="w-[360px] bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">创建资产</span>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        {itemKind === 'image' && itemContent && (
          <img src={itemContent} alt="" className="h-20 w-full object-cover rounded border border-border" />
        )}

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">名称</label>
          <input
            className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">分类</label>
          <div className="flex gap-1.5 mt-1">
            {ROLES.map((r) => (
              <button
                key={r.value}
                className={cn(
                  'text-[10px] px-2.5 py-1 rounded border',
                  role === r.value ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground',
                )}
                onClick={() => setRole(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">描述 (可选)</label>
          <input
            className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="角色外貌、场景描述等"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>取消</button>
          <button className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90" onClick={handleCreate}>创建</button>
        </div>
      </div>
    </div>
  )
}
