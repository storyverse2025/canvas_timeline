import { memo, useCallback, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ImageIcon, User, MapPin, Box, GripVertical, Upload, Film, Loader2 } from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas-store'
import type { VisualAssetNodeData } from '@/types/canvas'

const assetIcons: Record<string, typeof ImageIcon> = {
  character: User,
  scene: MapPin,
  prop: Box,
  keyframe: ImageIcon,
  storyboard: ImageIcon,
  video: Film,
}

export const VisualAssetNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as VisualAssetNodeData
  const Icon = assetIcons[d.assetType] || ImageIcon
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const updateNode = useCanvasStore((s) => s.updateNode)
  const [hovering, setHovering] = useState(false)
  const isVideo = d.assetType === 'video'

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('canvas-node-id', id)
    e.dataTransfer.effectAllowed = 'copy'
    e.stopPropagation()
  }, [id])

  const handleUploadClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    updateNode(id, { imageUrl: url } as Partial<VisualAssetNodeData>)
    e.target.value = ''
  }, [id, updateNode])

  const handleMouseEnter = useCallback(() => {
    setHovering(true)
    if (isVideo && videoRef.current) {
      videoRef.current.play().catch(() => {})
    }
  }, [isVideo])

  const handleMouseLeave = useCallback(() => {
    setHovering(false)
    if (isVideo && videoRef.current) {
      videoRef.current.pause()
      videoRef.current.currentTime = 0
    }
  }, [isVideo])

  const borderColor = isVideo
    ? d.status === 'completed' ? 'border-green-500/60' : d.status === 'generating' ? 'border-amber-500/60' : 'border-violet-500/60'
    : 'border-violet-500/60'
  const bgColor = isVideo ? 'bg-green-500/10' : 'bg-violet-500/10'

  return (
    <div
      className={`w-[200px] rounded-lg border-2 ${borderColor} ${bgColor} shadow-lg transition-shadow overflow-hidden ${
        selected ? 'ring-2 ring-primary shadow-primary/20' : ''
      }`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Handle type="target" position={Position.Left} className="!bg-violet-400 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Right} className="!bg-violet-400 !w-2.5 !h-2.5" />

      <input
        ref={fileInputRef}
        type="file"
        accept={isVideo ? 'video/*,image/*' : 'image/*'}
        className="hidden"
        onChange={handleFileChange}
      />

      {isVideo && d.videoUrl ? (
        <div className="w-full h-[120px] bg-secondary relative group">
          <video
            ref={videoRef}
            src={d.videoUrl}
            poster={d.imageUrl}
            muted
            loop
            playsInline
            className="w-full h-full object-cover"
          />
          {d.status === 'generating' && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-white animate-spin" />
            </div>
          )}
          {/* Duration badge */}
          {d.status === 'completed' && (
            <span className="absolute bottom-1 right-1 text-[9px] bg-black/70 text-white px-1.5 py-0.5 rounded">
              {(data as Record<string, unknown>).duration ? `${(data as Record<string, unknown>).duration}s` : 'video'}
            </span>
          )}
          {!hovering && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Film className="w-6 h-6 text-white/60" />
            </div>
          )}
        </div>
      ) : d.imageUrl ? (
        <div className="w-full h-[120px] bg-secondary relative group">
          <img src={d.imageUrl} alt={d.label} className="w-full h-full object-cover" />
          <button
            className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 text-white text-[10px]"
            onClick={handleUploadClick}
          >
            <Upload className="w-3.5 h-3.5" />
            Replace Image
          </button>
        </div>
      ) : (
        <button
          className="w-full h-[80px] bg-secondary/50 flex flex-col items-center justify-center gap-1 hover:bg-secondary/70 transition-colors"
          onClick={handleUploadClick}
        >
          <Upload className="w-5 h-5 text-muted-foreground/60" />
          <span className="text-[9px] text-muted-foreground/60">
            {isVideo ? 'Upload Video' : 'Upload Image'}
          </span>
        </button>
      )}

      <div className="p-2.5">
        <div className="flex items-center gap-1.5 mb-1">
          <div
            draggable
            onDragStart={handleDragStart}
            className="cursor-grab active:cursor-grabbing p-0.5 -ml-1 rounded hover:bg-white/10"
            title="Drag to timeline"
          >
            <GripVertical className="w-3 h-3 text-muted-foreground/60" />
          </div>
          <Icon className={`w-3 h-3 ${isVideo ? 'text-green-400' : 'text-violet-400'}`} />
          <span className="text-[10px] font-medium uppercase text-muted-foreground tracking-wider">
            {d.assetType}
          </span>
          {isVideo && d.status && (
            <span className={`text-[8px] px-1 py-0.5 rounded ml-auto ${
              d.status === 'completed' ? 'bg-green-500/20 text-green-300' :
              d.status === 'generating' ? 'bg-amber-500/20 text-amber-300' :
              d.status === 'failed' ? 'bg-red-500/20 text-red-300' :
              'bg-muted text-muted-foreground'
            }`}>
              {d.status}
            </span>
          )}
        </div>
        <div className="text-xs font-medium text-foreground truncate">{d.label}</div>

        {d.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {d.tags.map((tag) => (
              <span
                key={tag.id}
                className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                  isVideo ? 'bg-green-500/20 text-green-300' : 'bg-violet-500/20 text-violet-300'
                }`}
              >
                {tag.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
})
VisualAssetNode.displayName = 'VisualAssetNode'
