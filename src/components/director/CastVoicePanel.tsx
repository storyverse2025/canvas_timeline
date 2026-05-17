import { useEffect, useMemo, useRef, useState } from 'react'
import { Drama, Mic, RefreshCw, Search, X } from 'lucide-react'
import { toast } from 'sonner'

import { runCastVoicesAndSpawnAudio, spawnVoiceCanvasNodes } from '@/lib/voice-binding'
import { getVoice, listVoices, normalizeVoiceUrl, searchVoices } from '@/lib/voice-library'
import type { VoiceEntry, VoiceGender } from '@/lib/voice-library'
import { useProjectDB, type PersistedCastingCard } from '@/stores/project-db'
import { cn } from '@/lib/utils'

/**
 * 演员表 (CastVoicePanel) — per-character voice binding view.
 *
 * Shows each casting card, the currently-bound voice (with a preview
 * player), and lets the user either:
 *   - re-cast all voices via actor-agent.castVoices (full LLM pass), or
 *   - swap a single voice via the picker dialog (search + filter +
 *     preview); the swap re-spawns the canvas audio node so it reflects
 *     the new selection immediately.
 *
 * Mounted inside ScriptInputDialog after the casting cards land. Falls
 * back to a friendly empty state when no cards are present yet.
 */
// Stable empty literals so the `??` fallback inside the component doesn't
// create a fresh reference each render — that's what was tripping
// zustand's selector equality check and causing the React
// "Maximum update depth exceeded" infinite-loop in DirectorAssistant.
const EMPTY_CARDS: PersistedCastingCard[] = []
const EMPTY_BINDINGS: Record<string, string> = {}

export function CastVoicePanel() {
  // Selectors must return *stable* references when nothing changed —
  // never `... ?? []` inside a selector. Hoist the fallback to module
  // scope (above).
  const castingCardsRaw = useProjectDB((s) => s.script.castingCards)
  const voiceBindingsRaw = useProjectDB((s) => s.script.voiceBindings)
  const creativeBrief = useProjectDB((s) => s.script.creativeBrief)
  const updateScript = useProjectDB((s) => s.updateScript)

  const castingCards = castingCardsRaw ?? EMPTY_CARDS
  const voiceBindings = voiceBindingsRaw ?? EMPTY_BINDINGS

  const [busy, setBusy] = useState(false)
  const [pickerCharacter, setPickerCharacter] = useState<string | null>(null)

  if (castingCards.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground py-2 px-2 rounded border border-dashed border-border">
        <Drama className="w-3 h-3 inline-block mr-1" />
        暂无角色卡 — 跑一次导演助手生成 casting cards 后再回来选音色。
      </div>
    )
  }

  const runRecast = async () => {
    setBusy(true)
    try {
      const bindings = await runCastVoicesAndSpawnAudio({
        castingCards,
        creativeBrief,
      })
      toast.success(`已为 ${Object.keys(bindings).length} 个角色挑选音色`, {
        description: '音色文件已作为音频节点出现在画布上',
      })
    } catch (e) {
      toast.error('音色挑选失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setBusy(false)
    }
  }

  const handleSwapVoice = (characterName: string, voiceId: string) => {
    const newBindings = { ...voiceBindings, [characterName]: voiceId }
    updateScript({ voiceBindings: newBindings })
    spawnVoiceCanvasNodes(newBindings)
    setPickerCharacter(null)
    toast.success(`${characterName} 音色已更新`)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-[10px] text-muted-foreground uppercase">演员表 / 音色绑定</label>
        <button
          onClick={runRecast}
          disabled={busy}
          className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-border hover:bg-accent disabled:opacity-50"
          title="让 actor-agent 重新为所有角色挑选音色"
        >
          <RefreshCw className={cn('w-3 h-3', busy && 'animate-spin')} />
          {busy ? '正在挑选…' : '重新挑选'}
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {castingCards.map((card) => {
          const voiceId = voiceBindings[card.name]
          const voice = voiceId ? getVoice(voiceId) : undefined
          return (
            <CastRow
              key={card.name}
              characterName={card.name}
              voicePrint={card.voice_print}
              voice={voice}
              onSwap={() => setPickerCharacter(card.name)}
            />
          )
        })}
      </div>
      {pickerCharacter && (
        <VoicePickerDialog
          characterName={pickerCharacter}
          currentVoiceId={voiceBindings[pickerCharacter]}
          onPick={(voiceId) => handleSwapVoice(pickerCharacter, voiceId)}
          onClose={() => setPickerCharacter(null)}
        />
      )}
    </div>
  )
}

function CastRow({
  characterName,
  voicePrint,
  voice,
  onSwap,
}: {
  characterName: string
  voicePrint?: string
  voice?: VoiceEntry
  onSwap: () => void
}) {
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 rounded border border-border bg-background/50">
      <Drama className="w-3 h-3 mt-0.5 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-medium">
          <span>{characterName}</span>
          {voicePrint && (
            <span className="text-[9px] text-muted-foreground truncate">{voicePrint}</span>
          )}
        </div>
        {voice ? (
          <div className="mt-1 flex items-center gap-1.5">
            <Mic className="w-3 h-3 text-emerald-400/80" />
            <span className="text-[10px] truncate text-emerald-300">{voice.displayName}</span>
            <audio src={normalizeVoiceUrl(voice.urlPath)} controls className="h-6 max-w-[160px]" preload="none" />
          </div>
        ) : (
          <div className="mt-1 text-[10px] text-amber-400/80">未绑定音色</div>
        )}
      </div>
      <button
        onClick={onSwap}
        className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-accent self-center"
      >
        换音色
      </button>
    </div>
  )
}

function VoicePickerDialog({
  characterName,
  currentVoiceId,
  onPick,
  onClose,
}: {
  characterName: string
  currentVoiceId?: string
  onPick: (voiceId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [gender, setGender] = useState<VoiceGender | 'any'>('any')
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  const results = useMemo(() => {
    const filtered = searchVoices({
      query: query.trim() || undefined,
      gender: gender === 'any' ? undefined : gender,
    })
    return filtered.slice(0, 200) // cap render — 553 entries is too many to render at once
  }, [query, gender])

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div
        ref={dialogRef}
        className="bg-background border border-border rounded-md w-[680px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="text-xs font-medium">
            为 <span className="text-primary">{characterName}</span> 挑选音色
            <span className="ml-2 text-[10px] text-muted-foreground">({listVoices().length} 个候选)</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 (名称 / 关键词 / 标签 / 示例文本)…"
              className="w-full text-[11px] bg-background border border-border rounded pl-7 pr-2 py-1 outline-none"
              autoFocus
            />
          </div>
          <select
            value={gender}
            onChange={(e) => setGender(e.target.value as VoiceGender | 'any')}
            className="text-[11px] bg-background border border-border rounded px-2 py-1 outline-none"
          >
            <option value="any">任意性别</option>
            <option value="female">女声</option>
            <option value="male">男声</option>
            <option value="unknown">未标记</option>
          </select>
        </div>
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {results.length === 0 && (
            <div className="text-[11px] text-muted-foreground py-4 text-center">没有匹配的音色</div>
          )}
          {results.map((v) => (
            <VoiceCandidateRow
              key={v.id}
              voice={v}
              selected={v.id === currentVoiceId}
              onPick={() => onPick(v.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function VoiceCandidateRow({
  voice,
  selected,
  onPick,
}: {
  voice: VoiceEntry
  selected: boolean
  onPick: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded border text-[11px]',
        selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{voice.displayName}</div>
        {voice.sampleSnippet && (
          <div className="text-[10px] text-muted-foreground line-clamp-1">{voice.sampleSnippet}</div>
        )}
        <div className="flex gap-1 mt-0.5 flex-wrap">
          {voice.gender !== 'unknown' && (
            <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-300">{voice.gender === 'male' ? '男' : '女'}</span>
          )}
          {voice.age !== 'unknown' && (
            <span className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-300">{voice.age}</span>
          )}
          {voice.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="text-[9px] px-1 rounded bg-zinc-800 text-zinc-400">{tag}</span>
          ))}
        </div>
      </div>
      <audio src={normalizeVoiceUrl(voice.urlPath)} controls className="h-6 max-w-[180px]" preload="none" />
      <button
        onClick={onPick}
        className={cn(
          'text-[10px] px-2 py-0.5 rounded border',
          selected ? 'border-primary text-primary' : 'border-border hover:bg-accent',
        )}
      >
        {selected ? '当前' : '选这个'}
      </button>
    </div>
  )
}
