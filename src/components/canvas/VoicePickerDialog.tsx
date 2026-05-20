import { useMemo, useState, useEffect } from 'react'
import { X, Mic, Check, Search } from 'lucide-react'
import { toast } from 'sonner'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useProjectDB } from '@/stores/project-db'
import {
  listVoices,
  normalizeVoiceUrl,
  shortlistForCard,
  type VoiceEntry,
} from '@/lib/voice-library'

interface Props {
  /** The character whose voice we're swapping (key into voiceBindings). */
  characterName: string;
  /** The audio canvas item that backs this character on the canvas. */
  audioItemId: string;
  /** Currently bound voice id (so we can mark it in the list). */
  currentVoiceId: string | undefined;
  onClose: () => void;
}

/**
 * Voice picker modal. Defaults to the strict shortlist (matching the
 * character's casting card gender + age) and lets the user broaden to
 * the full catalog. Selecting a voice updates BOTH
 * projectDB.script.voiceBindings[characterName] AND the audio canvas
 * item's content URL, so the next beat-video generation uses the new
 * voice immediately.
 */
export function VoicePickerDialog({ characterName, audioItemId, currentVoiceId, onClose }: Props) {
  const castingCard = useProjectDB((s) =>
    (s.script.castingCards ?? []).find(
      (c) => c.name.trim().toLowerCase() === characterName.trim().toLowerCase(),
    ),
  )
  const updateScript = useProjectDB((s) => s.updateScript)
  const updateItem = useCanvasItemStore((s) => s.updateItem)

  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const [previewId, setPreviewId] = useState<string | undefined>(undefined)

  // Default pool: strict shortlist for this card (typically 4-40 voices).
  // "Show all" lifts that to the entire 553-voice catalog.
  const pool: VoiceEntry[] = useMemo(() => {
    if (showAll) return listVoices()
    if (!castingCard) return listVoices()
    return shortlistForCard(
      {
        gender_presentation: castingCard.gender_presentation,
        age_range: castingCard.age_range,
        voice_print: castingCard.voice_print,
      },
      120,  // wider than the LLM shortlist so the user has options
    )
  }, [castingCard, showAll])

  const filtered: VoiceEntry[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pool
    return pool.filter((v) => {
      const hay = (v.displayName + ' ' + v.sampleSnippet + ' ' + v.tags.join(' ')).toLowerCase()
      return hay.includes(q)
    })
  }, [pool, query])

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickVoice = (voice: VoiceEntry) => {
    const bindings = { ...(useProjectDB.getState().script.voiceBindings ?? {}) }
    bindings[characterName] = voice.id
    updateScript({ voiceBindings: bindings })
    updateItem(audioItemId, {
      content: voice.urlPath,
      description: voice.displayName,
    })
    toast.success(`${characterName} 音色已替换为 ${voice.displayName}`, {
      description: '下次生成视频会用新音色。',
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-[640px] max-w-full max-h-[85vh] bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium flex items-center gap-2">
            <Mic className="w-4 h-4 text-amber-400" />
            替换音色 — {characterName}
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        {castingCard ? (
          <div className="text-[11px] text-muted-foreground">
            casting card: {castingCard.gender_presentation ?? '?'} / {castingCard.age_range ?? '?'}
            {castingCard.voice_print ? ` · 声纹: ${castingCard.voice_print}` : ''}
          </div>
        ) : (
          <div className="text-[11px] text-amber-500">
            该角色没有 casting card；显示完整音色库。
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 displayName / 样本 / tags …"
              className="w-full pl-7 pr-2 py-1 text-sm bg-background border border-border rounded"
              autoFocus
            />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            显示全库 ({listVoices().length})
          </label>
        </div>

        <div className="text-[11px] text-muted-foreground">
          {filtered.length} 个候选 ({showAll ? '完整音色库' : '按 gender + age 预筛'})
        </div>

        <div className="flex-1 overflow-y-auto border border-border rounded">
          {filtered.length === 0 && (
            <div className="text-[11px] text-muted-foreground text-center py-6">
              没有匹配的音色。试试取消勾选 "显示全库" 或者清空搜索关键词。
            </div>
          )}
          {filtered.map((v) => {
            const isCurrent = v.id === currentVoiceId
            const isPreviewing = v.id === previewId
            return (
              <div
                key={v.id}
                className={
                  'flex items-center gap-2 px-2 py-1.5 border-b border-border last:border-0 hover:bg-accent/40 ' +
                  (isCurrent ? 'bg-amber-500/10' : '')
                }
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate" title={v.displayName}>
                      {v.displayName}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] bg-amber-500/20 text-amber-600 px-1 rounded">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {v.gender} · {v.age}
                    {v.sampleSnippet && v.sampleSnippet !== v.displayName
                      ? ` · "${v.sampleSnippet.slice(0, 60)}"`
                      : ''}
                  </div>
                </div>

                {isPreviewing ? (
                  <audio
                    src={normalizeVoiceUrl(v.urlPath)}
                    controls
                    autoPlay
                    preload="metadata"
                    className="h-8 w-44 shrink-0"
                    style={{ minHeight: 32 }}
                    onEnded={() => setPreviewId(undefined)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setPreviewId(v.id)}
                    className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent shrink-0"
                  >
                    试听
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => pickVoice(v)}
                  disabled={isCurrent}
                  className={
                    'text-[11px] px-2 py-1 rounded shrink-0 ' +
                    (isCurrent
                      ? 'bg-muted text-muted-foreground cursor-default'
                      : 'bg-primary text-primary-foreground hover:opacity-90')
                  }
                  title={isCurrent ? '已是当前音色' : '采用此音色'}
                >
                  {isCurrent ? <Check className="w-3 h-3" /> : '选择'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
