import { useMemo, useState, useCallback } from 'react'
import { Image, Tag, Link2, X, ChevronDown, ChevronRight, RefreshCw, Loader2, Film, Settings2, User, MapPin, Package } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { useAssetStore } from '@/stores/asset-store'
import { useViewStore } from '@/stores/view-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { generateImage } from '@/lib/fal-client'
import type { Asset } from '@/types/asset'
import type { Tag as TagType } from '@/types/canvas'

const TYPE_ICONS: Record<string, React.ElementType> = {
  character: User,
  scene: MapPin,
  prop: Package,
  keyframe: Film,
}

export function NodeInspector() {
  const selectedAssetIds = useViewStore((s) => s.selectedAssetIds)
  const assets = useAssetStore((s) => s.assets)
  const updateAsset = useAssetStore((s) => s.updateAsset)
  const getItemsForAsset = useTimelineStore((s) => s.getItemsForAsset)
  const links = useMappingStore((s) => s.links)

  const [clipsExpanded, setClipsExpanded] = useState(true)
  const [regenerating, setRegenerating] = useState(false)

  const selectedAsset = useMemo(
    () => assets.find((a) => a.id === selectedAssetIds[0]),
    [assets, selectedAssetIds]
  )

  if (!selectedAsset) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
        <div className="text-center">
          <Settings2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">选择一个资产查看属性</p>
          <p className="text-xs text-muted-foreground/60 mt-1">在画布、表格或时间轴中点击选择</p>
        </div>
      </div>
    )
  }

  const TypeIcon = TYPE_ICONS[selectedAsset.type] ?? Image
  const clips = getItemsForAsset(selectedAsset.id)
  const tags = selectedAsset.tags || []

  const addTag = () => {
    const newTag: TagType = { id: uuid(), category: 'custom', label: '新标签' }
    updateAsset(selectedAsset.id, { tags: [...tags, newTag] })
  }

  const removeTag = (tagId: string) => {
    updateAsset(selectedAsset.id, { tags: tags.filter((t) => t.id !== tagId) })
  }

  const handleRegenerate = async () => {
    if (!selectedAsset.prompt) return
    setRegenerating(true)
    try {
      const result = await generateImage(selectedAsset.prompt)
      const newVersions = [
        ...(selectedAsset.versions ?? []),
        { url: result.url, timestamp: Date.now() },
      ]
      updateAsset(selectedAsset.id, { imageUrl: result.url, versions: newVersions, status: 'completed' })
    } catch (err) {
      console.error('Regenerate failed:', err)
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <TypeIcon className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-semibold capitalize">{selectedAsset.name}</span>
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">{selectedAsset.id.slice(0, 8)}</span>
        </div>

        {/* Name */}
        <div>
          <label className="text-xs text-muted-foreground">名称</label>
          <Input
            value={selectedAsset.name}
            onChange={(e) => updateAsset(selectedAsset.id, { name: e.target.value })}
            className="mt-1 text-xs bg-secondary/50"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-xs text-muted-foreground">描述</label>
          <Textarea
            value={selectedAsset.description ?? ''}
            onChange={(e) => updateAsset(selectedAsset.id, { description: e.target.value })}
            className="mt-1 text-xs min-h-[60px] bg-secondary/50"
            placeholder="输入描述..."
          />
        </div>

        {/* Prompt + Regenerate */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <label className="text-xs text-muted-foreground">Prompt</label>
            <Button
              variant="outline"
              size="sm"
              className="h-5 text-[10px] px-2 ml-auto gap-1"
              onClick={handleRegenerate}
              disabled={regenerating || !selectedAsset.prompt}
            >
              {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {regenerating ? '生成中...' : '重新生成'}
            </Button>
          </div>
          <Textarea
            value={selectedAsset.prompt ?? ''}
            onChange={(e) => updateAsset(selectedAsset.id, { prompt: e.target.value })}
            className="text-xs min-h-[60px] bg-secondary/50"
            placeholder="图像生成 prompt..."
          />
        </div>

        {/* Image preview */}
        {selectedAsset.imageUrl && (
          <div>
            <label className="text-xs text-muted-foreground">图片预览</label>
            <img src={selectedAsset.imageUrl} alt={selectedAsset.name} className="mt-1 rounded border border-border w-full" />
          </div>
        )}

        {/* Version history */}
        {(selectedAsset.versions ?? []).length > 0 && (
          <VersionHistory asset={selectedAsset} updateAsset={updateAsset} />
        )}

        {/* Tags */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Tag className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">标签</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag.id} variant="secondary" className="text-[10px] gap-1 pr-1">
                {tag.label}
                <button onClick={() => removeTag(tag.id)} className="hover:text-destructive">
                  <X className="w-2.5 h-2.5" />
                </button>
              </Badge>
            ))}
            <Button variant="outline" size="sm" className="h-5 text-[10px] px-2" onClick={addTag}>
              + 添加标签
            </Button>
          </div>
        </div>

        {/* Timeline Clips */}
        <div>
          <button
            className="flex items-center gap-1.5 mb-2 w-full text-left"
            onClick={() => setClipsExpanded(!clipsExpanded)}
          >
            {clipsExpanded
              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
            <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">时间轴片段</span>
            <span className="text-[10px] text-muted-foreground ml-auto">{clips.length}</span>
          </button>

          {clipsExpanded && (
            <div className="space-y-0.5">
              {clips.length === 0 ? (
                <p className="text-[11px] text-muted-foreground pl-5">
                  暂无时间轴片段。将资产拖到时间轴轨道上可创建片段。
                </p>
              ) : (
                clips.map((clip) => (
                  <div
                    key={clip.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-[11px] bg-secondary/30"
                  >
                    <span className="truncate flex-1 text-foreground/80">{clip.label}</span>
                    <span className="text-[9px] text-muted-foreground shrink-0">{clip.duration}s</span>
                    <span className="text-[9px] text-muted-foreground/60 shrink-0 capitalize">{clip.type}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function VersionHistory({
  asset,
  updateAsset,
}: {
  asset: Asset
  updateAsset: (id: string, data: Partial<Asset>) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const versions = asset.versions ?? []

  return (
    <div>
      <button
        className="flex items-center gap-1.5 w-full text-left"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        <span className="text-xs font-medium">历史版本</span>
        <span className="text-[10px] text-muted-foreground ml-auto">{versions.length}</span>
      </button>
      {expanded && (
        <div className="grid grid-cols-3 gap-1.5 mt-2">
          {versions.map((v, i) => {
            const isActive = v.url === asset.imageUrl
            return (
              <button
                key={i}
                className={`relative rounded border overflow-hidden aspect-video ${
                  isActive ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/50'
                }`}
                onClick={() => updateAsset(asset.id, { imageUrl: v.url })}
              >
                <img src={v.url} alt={`v${i + 1}`} className="w-full h-full object-cover" />
                <span className="absolute bottom-0 left-0 right-0 text-[8px] bg-black/60 text-white text-center py-0.5">
                  v{i + 1}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
