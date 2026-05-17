import { memo, useRef, useState, useCallback } from 'react'
import { Handle, Position, NodeResizer, useNodeId } from '@xyflow/react'
import { toast } from 'sonner'
import { NodeFloatingToolbar } from '../NodeFloatingToolbar'
import { ImageIcon, Upload, Link as LinkIcon, User, MapPin, Package, Film, Mic, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import { useAssetStore } from '@/stores/asset-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { runCapability } from '@/lib/capabilities/client'
import { VoiceFeedbackButton, type VoicePlan, type VoiceElementKind } from '@/components/canvas/VoiceFeedbackButton'
import { PanoramaViewer } from '@/components/canvas/PanoramaViewer'
import { normalizeVoiceUrl } from '@/lib/voice-library'

export interface ImageNodeData {
  itemId: string;
  /** Set when this image node is also the canvas representation of an asset
   *  (character / scene / prop / keyframe). Lets the node show a typed badge
   *  and route voice feedback under the right element kind. */
  assetId?: string;
}

const TYPE_BADGE: Record<'character' | 'scene' | 'prop' | 'keyframe', { label: string; Icon: React.ElementType; cls: string }> = {
  character: { label: '角色',  Icon: User,    cls: 'bg-violet-500/80 text-white' },
  scene:     { label: '场景',  Icon: MapPin,  cls: 'bg-emerald-500/80 text-white' },
  prop:      { label: '物品',  Icon: Package, cls: 'bg-amber-500/80 text-white' },
  keyframe:  { label: '关键帧', Icon: Film,    cls: 'bg-blue-500/80 text-white' },
}

interface Props {
  data: ImageNodeData;
  selected: boolean;
}

export const ImageCanvasNode = memo(function ImageCanvasNode({ data, selected }: Props) {
  const nodeId = useNodeId() ?? ''
  const item = useCanvasItemStore((s) => s.items[data.itemId])
  const updateItem = useCanvasItemStore((s) => s.updateItem)
  const updateAsset = useAssetStore((s) => s.updateAsset)
  const asset = useAssetStore((s) => (data.assetId ? s.assets.find((a) => a.id === data.assetId) : undefined))
  const activeTask = useLibtvTasksStore((s) =>
    Object.values(s.tasks).find(
      (t) => t.itemId === data.itemId && (t.status === 'pending' || t.status === 'polling'),
    ),
  )

  // For keyframe items: is this the one the storyboard table currently
  // adopts? Detect by URL match — generateKeyframe creates a fresh canvas
  // item per regenerate; the row's keyframeUrl points at the adopted one.
  // Old keyframes stay on canvas (preserved per user request) but only the
  // adopted one shows ⭐. Click the empty ⭐ on a sibling to promote it.
  const adoptedRowId = useStoryboardStore((s) => {
    if (item?.role !== 'keyframe' || !item.content) return undefined
    return s.rows.find((r) => r.keyframeUrl === item.content)?.id
  })
  const isAdoptedKeyframe = Boolean(adoptedRowId)
  const isKeyframeItem = item?.role === 'keyframe'

  const adoptThisKeyframe = useCallback(() => {
    if (!item || item.role !== 'keyframe' || !item.content) return
    // Match the row by shot_number embedded in the item name ("KF-S1") —
    // it's the only stable link from the canvas item back to the row.
    const shotMatch = /^KF-(.+)$/.exec(item.name)
    if (!shotMatch) {
      toast.error('无法识别此 keyframe 属于哪一行 (item name 不是 KF-* 格式)')
      return
    }
    const shotNumber = shotMatch[1]!
    const row = useStoryboardStore.getState().rows.find((r) => r.shot_number === shotNumber)
    if (!row) {
      toast.error(`没有找到镜号 ${shotNumber} 对应的分镜行`)
      return
    }
    useStoryboardStore.getState().updateRow(row.id, {
      keyframeUrl: item.content,
      reference_image: item.content,
      keyframeNodeId: nodeId,
    })
    toast.success(`已设为镜号 ${shotNumber} 的采用 keyframe`)
  }, [item, nodeId])
  const [promptOpen, setPromptOpen] = useState(false)
  const [regenerating, setRegenerating] = useState<{ intent: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        updateItem(data.itemId, { content: reader.result, name: f.name })
      }
    }
    reader.readAsDataURL(f)
  }, [data.itemId, updateItem])

  const onUrl = useCallback(() => {
    const url = window.prompt('图片 URL', item?.content ?? '')
    if (url != null) updateItem(data.itemId, { content: url })
    setPromptOpen(false)
  }, [data.itemId, item?.content, updateItem])

  const handleVoicePlanReady = useCallback(async (plan: VoicePlan) => {
    const currentImage = item?.content && /^https?:|^data:/.test(item.content) ? item.content : ''
    const refs = currentImage ? [currentImage] : []
    setRegenerating({ intent: plan.userIntent ?? '语音重生中…' })
    try {
      const result = await runCapability({
        capability: 'text-to-image',
        inputs: [
          { kind: 'text', text: plan.newPrompt },
          ...refs.map((url) => ({ kind: 'image' as const, url })),
        ],
        params: { aspect: '16:9' },
      })
      const url = result.outputs[0]?.url
      if (!url) throw new Error('regen returned no image')
      updateItem(data.itemId, { content: url, prompt: plan.newPrompt })
      // Mirror the regen back to the asset row so AssetTable / mic poll see it.
      if (data.assetId) updateAsset(data.assetId, { imageUrl: url, prompt: plan.newPrompt, status: 'completed' })
      toast.success('图片已根据语音重生', { description: plan.userIntent?.slice(0, 120) })
    } catch (err) {
      toast.error('语音重生失败', {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRegenerating(null)
    }
  }, [data.itemId, item?.content, updateItem])

  if (!item) return null

  return (
    <div
      className={cn(
        'relative w-full h-full rounded-lg border-2 border-border bg-card shadow-md overflow-hidden',
        selected && 'ring-2 ring-primary',
        (activeTask || regenerating) && 'bragi-generating'
      )}
    >
      <NodeFloatingToolbar nodeId={nodeId} itemId={data.itemId} isVisible={selected} />
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={90}
        lineClassName="!border-primary"
        handleClassName="!w-2 !h-2 !bg-primary !border !border-background"
      />
      <Handle id="t" type="target" position={Position.Top}    className="bragi-handle" />
      <Handle id="l" type="target" position={Position.Left}   className="bragi-handle" />
      <Handle id="r" type="source" position={Position.Right}  className="bragi-handle" />
      <Handle id="b" type="source" position={Position.Bottom} className="bragi-handle" />

      {/* Voice-feedback mic — top-left so it doesn't collide with the 替换 button.
          Skipped for non-visual canvas items (audio voice, character bios, style/
          system text) — those don't have a generated image to give voice feedback
          on, and the button's stopPropagation was eating clicks on top of the
          audio player + blocking React Flow's node-selection so the Inspector
          stayed empty. Only renders for image / video items. */}
      {(item.kind === 'image' || item.kind === 'video') && (
        <div className="absolute top-1 left-1 z-20">
          <VoiceFeedbackButton
            elementKind={(asset?.type as VoiceElementKind | undefined) ?? 'keyframe'}
            elementId={data.assetId ?? data.itemId}
            label={asset?.name ?? item.name}
            elementContext={{
              id: data.assetId ?? data.itemId,
              assetId: data.assetId,
              itemId: data.itemId,
              name: asset?.name ?? item.name,
              prompt: item.prompt ?? asset?.prompt ?? '',
              currentImage: item.content ?? asset?.imageUrl ?? '',
              type: asset?.type,
              kind: item.kind,
            }}
            onPlanReady={handleVoicePlanReady}
            compact
          />
        </div>
      )}

      {/* Typed badge — only when this image node is the canvas representation of an asset */}
      {asset && TYPE_BADGE[asset.type] && (
        <div className={cn(
          'absolute top-1 left-10 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shadow-sm',
          TYPE_BADGE[asset.type].cls,
        )}>
          {(() => { const I = TYPE_BADGE[asset.type].Icon; return <I className="w-2.5 h-2.5" /> })()}
          <span>{TYPE_BADGE[asset.type].label}</span>
          <span className="opacity-80 truncate max-w-[80px]">· {asset.name}</span>
        </div>
      )}

      {/* Adopted-keyframe ⭐ badge. Filled = currently adopted by the
          storyboard table; outline = sibling keyframe (click to promote). */}
      {isKeyframeItem && (
        <button
          type="button"
          onClick={adoptThisKeyframe}
          title={isAdoptedKeyframe ? '表格当前采用的 keyframe' : '点击采用此 keyframe (替换表格中当前采用的)'}
          className={cn(
            'absolute top-1 right-1 z-20 inline-flex items-center justify-center w-6 h-6 rounded shadow',
            isAdoptedKeyframe
              ? 'bg-amber-400 text-amber-900 cursor-default'
              : 'bg-black/60 text-white/80 hover:bg-amber-400/80 hover:text-amber-900 cursor-pointer',
          )}
        >
          <Star className={cn('w-3.5 h-3.5', isAdoptedKeyframe && 'fill-current')} />
        </button>
      )}

      {item.content ? (
        // Render decision order: item.kind beats URL regex (signed URLs like
        // s3.amazonaws.com/...?X-Amz-Signature=... carry no extension), then
        // fall back to URL pattern matching for legacy items that stored a
        // video as kind='image'.
        item.kind === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(item.content) ? (
          <video
            src={item.content}
            className="w-full h-full object-contain bg-black"
            controls
            playsInline
          />
        ) : item.kind === 'audio' ? (
          // Layout note: native <audio controls> needs ~320×54 to render
          // without clipping the play button. Voice nodes spawn at 340×140
          // (see spawnVoiceCanvasNodes); kept overflow-y auto + flex so
          // anyone manually resizing smaller still sees the bar at the top.
          //
          // Pointer handling: stopPropagation lives ONLY on the <audio>
          // element so the play/seek button works without React Flow
          // intercepting. The surrounding wrapper deliberately does NOT
          // stop propagation — clicking the Mic header / filename / padding
          // must still bubble up so React Flow selects the node (which
          // populates the Inspector with the 音色来源 metadata card).
          <div className="w-full h-full flex flex-col gap-2 bg-gradient-to-br from-amber-950/40 to-zinc-900 p-3 overflow-y-auto">
            <div className="flex items-center gap-1.5 text-amber-400/70 shrink-0">
              <Mic className="w-3.5 h-3.5" />
              <span className="text-[10px] uppercase tracking-wider">音色</span>
            </div>
            <audio
              src={normalizeVoiceUrl(item.content)}
              controls
              preload="metadata"
              className="w-full nodrag nopan shrink-0"
              style={{ minHeight: 40 }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            />
            <div className="text-[10px] text-zinc-300 truncate" title={item.name}>
              {item.name}
            </div>
            {item.description && (
              <div className="text-[10px] text-zinc-400 line-clamp-2" title={item.description}>
                {item.description}
              </div>
            )}
          </div>
        ) : asset?.type === 'scene' || item.role === 'scene' ? (
          // Scene canvas items (whether they came in via asset.type === 'scene'
          // or via item.role === 'scene' — the canvas-elements path) are 360°
          // equirectangular panoramas. Render through the draggable
          // PanoramaViewer so the user can pan to different viewpoints inside
          // the canvas node. Non-scene image assets stay as plain <img>.
          <PanoramaViewer src={item.content} alt={item.name} />
        ) : (
          <img src={item.content} alt={item.name} className="w-full h-full object-contain bg-black/40" />
        )
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-muted/20 text-muted-foreground">
          <ImageIcon className="w-8 h-8 opacity-40" />
          <div className="flex gap-1">
            <button
              className="px-2 py-1 text-xs rounded bg-secondary hover:bg-secondary/80 flex items-center gap-1"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="w-3 h-3" /> 上传
            </button>
            <button
              className="px-2 py-1 text-xs rounded bg-secondary hover:bg-secondary/80 flex items-center gap-1"
              onClick={onUrl}
            >
              <LinkIcon className="w-3 h-3" /> URL
            </button>
          </div>
        </div>
      )}

      {item.content && selected && (
        <button
          // When this is a keyframe item, the ⭐ adopt badge sits at top-1
          // right-1; shift 替换 left so the two don't collide.
          className={cn(
            'absolute top-1 px-1.5 py-0.5 text-[10px] rounded bg-black/60 text-white hover:bg-black/80',
            isKeyframeItem ? 'right-9' : 'right-1',
          )}
          onClick={() => fileRef.current?.click()}
        >替换</button>
      )}

      {(activeTask || regenerating) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white p-3 text-center">
          <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
          <div className="text-[10px]">
            {regenerating
              ? '🎤 根据语音重生中…'
              : activeTask?.status === 'pending' ? '创建会话…' : '生成中…'}
          </div>
          {regenerating?.intent && (
            <div className="text-[9px] text-white/70 line-clamp-2 max-w-[90%]">
              {regenerating.intent}
            </div>
          )}
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />

      {promptOpen && null}

    </div>
  )
})
