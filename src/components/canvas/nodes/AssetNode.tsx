import { memo, useState, useCallback, useRef } from 'react'
import { Handle, Position } from '@xyflow/react'
import { User, MapPin, Package, Film, ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Asset, AssetType } from '@/types/asset'
import { useAssetStore } from '@/stores/asset-store'

export interface AssetNodeData extends Asset {
  assetId: string;
}

const TYPE_CONFIG: Record<AssetType, { label: string; color: string; Icon: React.ElementType }> = {
  character: { label: '角色', color: 'border-violet-500 bg-violet-500/10', Icon: User },
  scene:     { label: '场景', color: 'border-emerald-500 bg-emerald-500/10', Icon: MapPin },
  prop:      { label: '物品', color: 'border-amber-500 bg-amber-500/10', Icon: Package },
  keyframe:  { label: '关键帧', color: 'border-blue-500 bg-blue-500/10', Icon: Film },
}

interface Props {
  data: AssetNodeData;
  selected: boolean;
}

export const AssetNode = memo(function AssetNode({ data, selected }: Props) {
  const updateAsset = useAssetStore((s) => s.updateAsset)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(data.name)
  const inputRef = useRef<HTMLInputElement>(null)

  const cfg = TYPE_CONFIG[data.type] ?? TYPE_CONFIG.character
  const { Icon } = cfg

  const startEdit = useCallback(() => {
    setEditName(data.name)
    setEditing(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [data.name])

  const commitEdit = useCallback(() => {
    setEditing(false)
    if (editName.trim() && editName !== data.name) {
      updateAsset(data.assetId, { name: editName.trim() })
    }
  }, [editName, data.name, data.assetId, updateAsset])

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('asset-id', data.assetId)
    e.dataTransfer.setData('asset-type', data.type)
    e.dataTransfer.effectAllowed = 'copy'
  }, [data.assetId, data.type])

  return (
    <div
      className={cn(
        'w-[140px] rounded-lg border-2 shadow-md transition-all duration-150 cursor-grab active:cursor-grabbing',
        cfg.color,
        selected && 'ring-2 ring-white ring-offset-1 ring-offset-background'
      )}
      draggable
      onDragStart={handleDragStart}
    >
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-muted-foreground" />

      {/* Thumbnail */}
      <div className="w-full h-[80px] rounded-t-md overflow-hidden bg-black/20 flex items-center justify-center">
        {data.imageUrl ? (
          <img src={data.imageUrl} alt={data.name} className="w-full h-full object-cover" />
        ) : (
          <Icon className="w-8 h-8 text-muted-foreground/50" />
        )}
        {data.status === 'generating' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="px-2 py-1.5">
        <span className="inline-flex items-center gap-0.5 text-[9px] font-medium opacity-70 mb-0.5">
          <Icon className="w-2.5 h-2.5" />
          {cfg.label}
        </span>

        {editing ? (
          <input
            ref={inputRef}
            className="w-full text-xs bg-background/80 border border-border rounded px-1 py-0.5 outline-none"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') { setEditing(false) } }}
          />
        ) : (
          <div
            className="text-xs font-medium text-foreground truncate cursor-text"
            onDoubleClick={startEdit}
            title={data.name}
          >
            {data.name || <span className="opacity-40 italic">unnamed</span>}
          </div>
        )}

        {data.description && !editing && (
          <div className="text-[10px] text-muted-foreground truncate mt-0.5" title={data.description}>
            {data.description}
          </div>
        )}
      </div>

      {/* No image placeholder indicator */}
      {!data.imageUrl && (
        <div className="px-2 pb-1.5">
          <div className="flex items-center gap-1 text-[9px] text-muted-foreground/50">
            <ImageIcon className="w-2.5 h-2.5" /> 无图片
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-muted-foreground" />
    </div>
  )
})
