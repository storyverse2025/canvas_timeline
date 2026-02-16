import { memo, useCallback, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Music, Mic, Volume2, GripVertical, Upload } from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas-store'
import type { AudioBlockNodeData } from '@/types/canvas'

const audioIcons: Record<string, typeof Music> = {
  dialogue: Mic,
  sfx: Volume2,
  bgm: Music,
  voiceover: Mic,
}

export const AudioBlockNode = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as AudioBlockNodeData
  const Icon = audioIcons[d.audioType] || Music
  const fileInputRef = useRef<HTMLInputElement>(null)
  const updateNode = useCanvasStore((s) => s.updateNode)

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
    const audio = new Audio(url)
    audio.addEventListener('loadedmetadata', () => {
      updateNode(id, {
        audioUrl: url,
        duration: audio.duration,
        label: file.name.replace(/\.[^.]+$/, ''),
      } as Partial<AudioBlockNodeData>)
    })
    audio.addEventListener('error', () => {
      updateNode(id, { audioUrl: url } as Partial<AudioBlockNodeData>)
    })

    // Reset so the same file can be re-selected
    e.target.value = ''
  }, [id, updateNode])

  return (
    <div
      className={`min-w-[160px] max-w-[220px] rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-3 shadow-lg transition-shadow ${
        selected ? 'ring-2 ring-primary shadow-primary/20' : ''
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-amber-400 !w-2.5 !h-2.5" />
      <Handle type="source" position={Position.Right} className="!bg-amber-400 !w-2.5 !h-2.5" />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="flex items-center gap-1.5 mb-2">
        {/* Drag handle for timeline */}
        <div
          draggable
          onDragStart={handleDragStart}
          className="cursor-grab active:cursor-grabbing p-0.5 -ml-1 rounded hover:bg-white/10"
          title="Drag to timeline"
        >
          <GripVertical className="w-3 h-3 text-muted-foreground/60" />
        </div>
        <Icon className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-[10px] font-medium uppercase text-muted-foreground tracking-wider">
          {d.audioType}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{d.duration.toFixed(1)}s</span>
      </div>

      <div className="text-xs font-medium text-foreground mb-2">{d.label}</div>

      {/* Waveform visualization or upload */}
      {d.audioUrl ? (
        <div className="h-6 bg-secondary/50 rounded flex items-end gap-px px-1">
          {Array.from({ length: 20 }, (_, i) => (
            <div
              key={i}
              className="flex-1 bg-amber-500/40 rounded-t"
              style={{ height: `${(d.waveformData?.[i] ?? Math.random() * 0.7 + 0.3) * 100}%` }}
            />
          ))}
        </div>
      ) : (
        <button
          className="w-full h-6 bg-secondary/50 rounded flex items-center justify-center gap-1 hover:bg-secondary/70 transition-colors"
          onClick={handleUploadClick}
        >
          <Upload className="w-3 h-3 text-muted-foreground/60" />
          <span className="text-[9px] text-muted-foreground/60">Upload Audio</span>
        </button>
      )}

      {d.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {d.tags.map((tag) => (
            <span
              key={tag.id}
              className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300"
            >
              {tag.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
})
AudioBlockNode.displayName = 'AudioBlockNode'
