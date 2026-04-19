import { useShotEditorStore, type EditMode } from '@/stores/shot-editor-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { X, MessageSquare, Paintbrush, Sparkles, RotateCcw, Upload, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DialogEditPanel } from './DialogEditPanel'
import { InpaintPanel } from './InpaintPanel'
import { AssociationPanel } from './AssociationPanel'
import { MultiAnglePanel } from './MultiAnglePanel'
import { ReplacePanel } from './ReplacePanel'

const MODES: { id: EditMode; label: string; icon: React.ElementType }[] = [
  { id: 'dialog', label: '对话修图', icon: MessageSquare },
  { id: 'inpaint', label: '标记修图', icon: Paintbrush },
  { id: 'association', label: '分镜联想', icon: Sparkles },
  { id: 'multi-angle', label: '多角度', icon: RotateCcw },
  { id: 'replace', label: '替换', icon: Upload },
]

export function ShotEditorOverlay() {
  const isOpen = useShotEditorStore((s) => s.isOpen)
  const rowId = useShotEditorStore((s) => s.activeRowId)
  const editMode = useShotEditorStore((s) => s.editMode)
  const setEditMode = useShotEditorStore((s) => s.setEditMode)
  const closeEditor = useShotEditorStore((s) => s.closeEditor)
  const rows = useStoryboardStore((s) => s.rows)

  if (!isOpen || !rowId) return null

  const rowIdx = rows.findIndex((r) => r.id === rowId)
  const row = rows[rowIdx]
  if (!row) return null

  const imageUrl = row.keyframeUrl || row.reference_image
  const hasPrev = rowIdx > 0
  const hasNext = rowIdx < rows.length - 1

  const goTo = (idx: number) => {
    const target = rows[idx]
    if (target) useShotEditorStore.getState().openEditor(target.id, editMode)
  }

  return (
    <div className="absolute inset-0 z-30 bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={closeEditor} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium">{row.shot_number}</span>
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">{row.visual_description}</span>
        </div>

        {/* Mode tabs */}
        <div className="flex items-center gap-0.5 bg-secondary/50 rounded-lg p-0.5">
          {MODES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setEditMode(id)}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 text-[10px] rounded-md transition-colors',
                editMode === id
                  ? 'bg-background text-foreground shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>

        {/* Navigator */}
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded hover:bg-accent disabled:opacity-30"
            disabled={!hasPrev}
            onClick={() => goTo(rowIdx - 1)}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs text-muted-foreground">{rowIdx + 1}/{rows.length}</span>
          <button
            className="p-1 rounded hover:bg-accent disabled:opacity-30"
            disabled={!hasNext}
            onClick={() => goTo(rowIdx + 1)}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Image viewer */}
        <div className="flex-1 flex items-center justify-center bg-black/90 p-4">
          {imageUrl ? (
            <img src={imageUrl} alt={row.shot_number} className="max-w-full max-h-full object-contain rounded" />
          ) : (
            <div className="text-zinc-500 text-sm">无参考图 — 请先生成 Keyframe</div>
          )}
        </div>

        {/* Right: Edit panel */}
        <div className="w-[320px] shrink-0 border-l border-border overflow-auto p-3 flex flex-col gap-3">
          {/* Shot metadata */}
          <div className="text-[10px] text-muted-foreground space-y-1">
            <div><strong>景别:</strong> {row.shot_size || '—'}</div>
            <div><strong>情绪:</strong> {row.emotion_mood || '—'}</div>
            <div><strong>光影:</strong> {row.lighting_atmosphere || '—'}</div>
            <div><strong>对白:</strong> {row.dialogue || '—'}</div>
          </div>

          <div className="border-t border-border pt-3">
            {editMode === 'dialog' && <DialogEditPanel rowId={rowId} imageUrl={imageUrl} />}
            {editMode === 'inpaint' && <InpaintPanel rowId={rowId} imageUrl={imageUrl} />}
            {editMode === 'association' && <AssociationPanel rowId={rowId} imageUrl={imageUrl} />}
            {editMode === 'multi-angle' && <MultiAnglePanel rowId={rowId} imageUrl={imageUrl} />}
            {editMode === 'replace' && <ReplacePanel rowId={rowId} />}
          </div>
        </div>
      </div>
    </div>
  )
}
