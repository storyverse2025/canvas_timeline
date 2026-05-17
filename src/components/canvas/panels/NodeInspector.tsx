import { useMemo, useState, useCallback } from 'react'
import { Image, Tag, Link2, X, ChevronDown, ChevronRight, RefreshCw, Loader2, Film, Settings2, User, MapPin, Package, Mic, FileText, Music, Video } from 'lucide-react'
import { v4 as uuid } from 'uuid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasItemStore, type CanvasItem } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useViewStore } from '@/stores/view-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { generateImage } from '@/lib/fal-client'
import { findVoiceByUrl, normalizeVoiceUrl } from '@/lib/voice-library'
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
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
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

  // Asset takes priority; otherwise fall back to the selected canvas-item
  // panel. Voice (audio), bio (text), and any other itemId-only node get a
  // useful detail view this way instead of the empty-state placeholder.
  if (!selectedAsset) {
    if (selectedNodeIds.length > 0) {
      return <CanvasItemPanel nodeId={selectedNodeIds[0]!} />
    }
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

// ─── CanvasItemPanel — fallback inspector for nodes without an asset ──
//
// Voice (audio), character-bio (text), style (text), and any other item-
// only canvas node lands here. Shows kind/role badges, the content with
// an inline player or text preview, and an editable name. Plays nice with
// the empty state above when no node is selected.

const ITEM_KIND_META: Record<string, { Icon: React.ElementType; label: string; tint: string }> = {
  audio: { Icon: Mic, label: '音频', tint: 'text-amber-400' },
  video: { Icon: Video, label: '视频', tint: 'text-blue-400' },
  image: { Icon: Image, label: '图片', tint: 'text-violet-400' },
  text: { Icon: FileText, label: '文本', tint: 'text-emerald-400' },
}

const ITEM_ROLE_LABEL: Record<string, string> = {
  voice: '角色音色',
  'character-bio': '人物小传 / 外貌',
  style: '全局风格',
  system: '系统',
  keyframe: '关键帧',
}

function CanvasItemPanel({ nodeId }: { nodeId: string }) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId))
  const itemId = (node?.data as { itemId?: string } | undefined)?.itemId
  const item = useCanvasItemStore((s) => (itemId ? s.items[itemId] : undefined))
  const updateItem = useCanvasItemStore((s) => s.updateItem)

  if (!node) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
        <p className="text-sm">所选节点不存在</p>
      </div>
    )
  }
  if (!item) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4 text-center">
        <div>
          <Settings2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">所选节点尚未绑定 canvas item</p>
          <p className="text-[10px] text-muted-foreground/60 mt-1 font-mono">node: {nodeId.slice(0, 8)}</p>
        </div>
      </div>
    )
  }

  const meta = ITEM_KIND_META[item.kind] ?? ITEM_KIND_META.text!
  const Icon = meta.Icon
  const roleLabel = item.role ? (ITEM_ROLE_LABEL[item.role] ?? item.role) : undefined

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${meta.tint}`} />
          <span className="text-sm font-semibold truncate flex-1">{item.name}</span>
          <span className="text-[10px] text-muted-foreground font-mono">{item.id.slice(0, 8)}</span>
        </div>

        {/* Kind + role badges */}
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="text-[10px]">{meta.label}</Badge>
          {roleLabel && <Badge variant="outline" className="text-[10px]">{roleLabel}</Badge>}
        </div>

        {/* Name */}
        <div>
          <label className="text-xs text-muted-foreground">名称</label>
          <Input
            value={item.name}
            onChange={(e) => updateItem(item.id, { name: e.target.value })}
            className="mt-1 text-xs bg-secondary/50"
          />
        </div>

        {/* Optional description */}
        {item.description !== undefined && (
          <div>
            <label className="text-xs text-muted-foreground">描述</label>
            <Input
              value={item.description ?? ''}
              onChange={(e) => updateItem(item.id, { description: e.target.value })}
              className="mt-1 text-xs bg-secondary/50"
              placeholder="可选描述..."
            />
          </div>
        )}

        {/* Content preview, branched by kind */}
        <ItemContentPanel item={item} />

        {/* Generation metadata, if present */}
        {item.prompt && (
          <div>
            <label className="text-xs text-muted-foreground">Prompt</label>
            <Textarea
              value={item.prompt}
              onChange={(e) => updateItem(item.id, { prompt: e.target.value })}
              className="mt-1 text-xs min-h-[80px] bg-secondary/50"
            />
          </div>
        )}
        {(item.provider || item.model) && (
          <div className="text-[10px] text-muted-foreground space-y-0.5">
            {item.provider && <div>provider: <span className="font-mono">{item.provider}</span></div>}
            {item.model && <div>model: <span className="font-mono">{item.model}</span></div>}
          </div>
        )}

        <div className="text-[10px] text-muted-foreground font-mono">
          node: {node.id.slice(0, 8)}
        </div>
      </div>
    </ScrollArea>
  )
}

function ItemContentPanel({ item }: { item: CanvasItem }) {
  const updateItem = useCanvasItemStore((s) => s.updateItem)
  if (item.kind === 'audio') {
    return <AudioItemContentPanel item={item} />
  }
  if (item.kind === 'video') {
    return (
      <div>
        <label className="text-xs text-muted-foreground">视频预览</label>
        <video src={item.content} controls className="mt-1 rounded border border-border w-full bg-black" />
      </div>
    )
  }
  if (item.kind === 'image') {
    return (
      <div>
        <label className="text-xs text-muted-foreground">图片预览</label>
        <img src={item.content} alt={item.name} className="mt-1 rounded border border-border w-full" />
      </div>
    )
  }
  // text
  return (
    <div>
      <label className="text-xs text-muted-foreground">内容</label>
      <Textarea
        value={item.content}
        onChange={(e) => updateItem(item.id, { content: e.target.value })}
        className="mt-1 text-xs min-h-[200px] bg-secondary/50 font-mono"
      />
    </div>
  )
}

function AudioItemContentPanel({ item }: { item: CanvasItem }) {
  // For role='voice' audio, look up the source voice library entry by URL
  // so the inspector can surface its real display name + spoken sample +
  // gender/age/collection metadata instead of leaving the user staring at
  // a URL-encoded path.
  const voice = findVoiceByUrl(item.content)
  return (
    <div className="space-y-2">
      <div>
        <label className="text-xs text-muted-foreground">音频预览</label>
        <div className="mt-1 p-3 rounded border border-border bg-secondary/30">
          <audio src={normalizeVoiceUrl(item.content)} controls preload="metadata" className="w-full" />
        </div>
      </div>
      {voice && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
          <div className="flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs font-medium">音色来源</span>
          </div>
          <div className="text-xs">
            <div className="text-foreground">{voice.displayName}</div>
            <div className="text-[10px] text-muted-foreground font-mono mt-0.5">id: {voice.id}</div>
          </div>
          {voice.sampleSnippet && (
            <div>
              <div className="text-[10px] text-muted-foreground uppercase">示例文本</div>
              <div className="text-[11px] text-foreground/80 mt-0.5 italic">"{voice.sampleSnippet}"</div>
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {voice.gender !== 'unknown' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">{voice.gender === 'male' ? '男声' : '女声'}</span>
            )}
            {voice.age !== 'unknown' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">{voice.age}</span>
            )}
            {voice.tags.slice(0, 5).map((t) => (
              <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800/70 text-zinc-400">{t}</span>
            ))}
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase">所属合集</div>
            <div className="text-[11px] text-muted-foreground/80 mt-0.5 font-mono break-all">{voice.collection}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase">音色文件</div>
            <a
              href={voice.urlPath}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted-foreground font-mono hover:text-foreground break-all"
              title={voice.relativePath}
            >
              {voice.relativePath}
            </a>
          </div>
        </div>
      )}
      {!voice && item.content && (
        <a
          href={item.content}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-[10px] text-muted-foreground truncate font-mono hover:text-foreground"
          title={item.content}
        >
          {item.content}
        </a>
      )}
    </div>
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
