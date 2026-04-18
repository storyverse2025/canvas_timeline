import { useState, useCallback } from 'react'
import { User, MapPin, Package, Film, ImageIcon, Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useAssetStore } from '@/stores/asset-store'
import { useViewStore } from '@/stores/view-store'
import { useTimelineStore } from '@/stores/timeline-store'
import type { Asset, AssetType } from '@/types/asset'

const TYPE_META: Record<AssetType, { label: string; Icon: React.ElementType; badge: string }> = {
  character: { label: '角色',  Icon: User,    badge: 'bg-violet-500/20 text-violet-300 border-violet-500/30' },
  scene:     { label: '场景',  Icon: MapPin,  badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  prop:      { label: '物品',  Icon: Package, badge: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  keyframe:  { label: '关键帧', Icon: Film,    badge: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
}

const ASSET_TYPE_ORDER: AssetType[] = ['character', 'scene', 'prop', 'keyframe']

function InlineEditCell({
  value,
  onSave,
  multiline = false,
}: {
  value: string
  onSave: (v: string) => void
  multiline?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const commit = () => {
    setEditing(false)
    if (draft !== value) onSave(draft)
  }

  if (editing) {
    if (multiline) {
      return (
        <textarea
          className="w-full min-h-[40px] text-xs bg-background/80 border border-border rounded px-1.5 py-1 outline-none resize-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          autoFocus
        />
      )
    }
    return (
      <input
        className="w-full text-xs bg-background/80 border border-border rounded px-1.5 py-1 outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        autoFocus
      />
    )
  }

  return (
    <div
      className="text-xs cursor-text hover:bg-white/5 rounded px-1 py-0.5 min-h-[22px]"
      onDoubleClick={() => { setDraft(value); setEditing(true) }}
      title="双击编辑"
    >
      {value || <span className="text-muted-foreground/40 italic">双击编辑...</span>}
    </div>
  )
}

function AssetRow({ asset }: { asset: Asset }) {
  const updateAsset = useAssetStore((s) => s.updateAsset)
  const selectedAssetIds = useViewStore((s) => s.selectedAssetIds)
  const setSelectedAssetIds = useViewStore((s) => s.setSelectedAssetIds)
  const getItemsForAsset = useTimelineStore((s) => s.getItemsForAsset)

  const isSelected = selectedAssetIds.includes(asset.id)
  const meta = TYPE_META[asset.type]
  const { Icon } = meta
  const clipCount = getItemsForAsset(asset.id).length

  return (
    <TableRow
      className={cn(
        'cursor-pointer transition-colors group',
        isSelected && 'bg-primary/10 hover:bg-primary/15'
      )}
      onClick={() => setSelectedAssetIds([asset.id])}
    >
      {/* Thumbnail */}
      <TableCell className="w-12 py-1.5 pl-3 pr-1">
        <div className="w-10 h-10 rounded overflow-hidden bg-white/5 flex items-center justify-center shrink-0">
          {asset.imageUrl ? (
            <img src={asset.imageUrl} alt={asset.name} className="w-full h-full object-cover" />
          ) : (
            <Icon className="w-4 h-4 text-muted-foreground/40" />
          )}
        </div>
      </TableCell>

      {/* Type */}
      <TableCell className="w-20 py-1.5">
        <span className={cn('inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-medium', meta.badge)}>
          <Icon className="w-2.5 h-2.5" />
          {meta.label}
        </span>
      </TableCell>

      {/* Name */}
      <TableCell className="min-w-[120px] py-1.5">
        <InlineEditCell
          value={asset.name}
          onSave={(v) => updateAsset(asset.id, { name: v })}
        />
      </TableCell>

      {/* Description */}
      <TableCell className="min-w-[180px] py-1.5">
        <InlineEditCell
          value={asset.description ?? ''}
          onSave={(v) => updateAsset(asset.id, { description: v })}
          multiline
        />
      </TableCell>

      {/* Timeline clips */}
      <TableCell className="w-20 py-1.5 text-center">
        {clipCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Link2 className="w-3 h-3" />
            {clipCount}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground/30">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}

export function AssetTable() {
  const assets = useAssetStore((s) => s.assets)
  const [typeFilter, setTypeFilter] = useState<AssetType | 'all'>('all')
  const [search, setSearch] = useState('')

  const filtered = assets.filter((a) => {
    if (typeFilter !== 'all' && a.type !== typeFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q)
    }
    return true
  })

  const grouped = ASSET_TYPE_ORDER.map((type) => ({
    type,
    assets: filtered.filter((a) => a.type === type),
  })).filter((g) => g.assets.length > 0)

  const showAll = typeFilter === 'all'

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <Input
          placeholder="搜索资产..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs w-48"
        />
        <div className="flex items-center gap-1 ml-2">
          {(['all', ...ASSET_TYPE_ORDER] as const).map((t) => {
            const isActive = typeFilter === t
            const meta = t !== 'all' ? TYPE_META[t] : null
            return (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={cn(
                  'px-2 py-1 text-[11px] rounded transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
                )}
              >
                {t === 'all' ? '全部' : meta?.label}
              </button>
            )
          })}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {filtered.length} 个资产
        </span>
      </div>

      {/* Table */}
      <ScrollArea className="flex-1">
        {assets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground/50 gap-3">
            <ImageIcon className="w-10 h-10" />
            <p className="text-sm">暂无资产</p>
            <p className="text-xs">在画布标签页添加角色、场景、物品或关键帧</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground/50 text-sm">
            无匹配结果
          </div>
        ) : (
          <div className="px-2 py-2">
            {showAll ? (
              grouped.map(({ type, assets: grpAssets }) => {
                const meta = TYPE_META[type]
                const { Icon } = meta
                return (
                  <div key={type} className="mb-6">
                    <div className="flex items-center gap-2 px-2 mb-1">
                      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">{meta.label}</span>
                      <span className="text-[10px] text-muted-foreground/50">({grpAssets.length})</span>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent border-border/50">
                          <TableHead className="w-12 text-[10px] py-1">图片</TableHead>
                          <TableHead className="w-20 text-[10px] py-1">类型</TableHead>
                          <TableHead className="text-[10px] py-1">名称</TableHead>
                          <TableHead className="text-[10px] py-1">描述</TableHead>
                          <TableHead className="w-20 text-[10px] py-1 text-center">时间轴</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {grpAssets.map((a) => <AssetRow key={a.id} asset={a} />)}
                      </TableBody>
                    </Table>
                  </div>
                )
              })
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-border/50">
                    <TableHead className="w-12 text-[10px] py-1">图片</TableHead>
                    <TableHead className="w-20 text-[10px] py-1">类型</TableHead>
                    <TableHead className="text-[10px] py-1">名称</TableHead>
                    <TableHead className="text-[10px] py-1">描述</TableHead>
                    <TableHead className="w-20 text-[10px] py-1 text-center">时间轴</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((a) => <AssetRow key={a.id} asset={a} />)}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
