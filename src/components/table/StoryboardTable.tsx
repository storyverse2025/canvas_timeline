import { useCallback, useState } from 'react'
import { Image as ImageIcon, Video, Wand2, Play, FolderInput } from 'lucide-react'
import { CanvasNodePickerDialog, type PickedNode } from './CanvasNodePickerDialog'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useViewStore } from '@/stores/view-store'
import { useStoryboardGenerate } from '@/hooks/useStoryboardGenerate'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import { TableContextMenu, type TableMenuState } from './TableContextMenu'
import { BatchToolbar } from '@/components/batch/BatchToolbar'
import { useShotEditorStore } from '@/stores/shot-editor-store'
import { runCapability } from '@/lib/capabilities/client'
import { VoiceFeedbackButton, type VoicePlan } from '@/components/canvas/VoiceFeedbackButton'
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { EMPTY_ELEMENT_SLOT, MAX_ROW_CHARACTERS, MAX_ROW_PROPS, normalizeRowSlots, rowCharacters, rowIdentitySheets, rowProps, withIdentitySheet, type StoryboardRow, type ElementSlot } from '@/types/storyboard'
import { computeMergeGroups, mergeRowGroup } from '@/lib/storyboard-merge'
import { thumb } from '@/lib/thumb'

interface Col {
  key: string
  label: string
  width: string
  type?: 'text' | 'number' | 'multiline' | 'media-image' | 'media-video' | 'element' | 'select'
}

const COLUMNS: Col[] = [
  { key: 'index',               label: '#',             width: 'w-10' },
  { key: 'voice',               label: '语音',          width: 'w-12' },
  { key: 'shot_number',         label: '镜号',          width: 'w-20',  type: 'text' },
  { key: 'duration',            label: '时长(秒)',      width: 'w-20',  type: 'number' },
  { key: 'visual_description',  label: '画面描述',      width: 'w-56',  type: 'multiline' },
  { key: 'transition_note',     label: '前后衔接',      width: 'w-56',  type: 'multiline' },
  { key: 'visual_anchor',       label: '视觉锚点',      width: 'w-40',  type: 'multiline' },
  { key: 'reference_image',     label: '黑白故事板',    width: 'w-28',  type: 'media-image' },
  { key: 'keyframe_clean',      label: '开场构图',      width: 'w-28',  type: 'media-image' },
  { key: 'shot_size',           label: '景别',          width: 'w-24',  type: 'text' },
  { key: 'characters',          label: '角色',          width: 'w-44',  type: 'element' },
  { key: 'props',               label: '道具',          width: 'w-44',  type: 'element' },
  { key: 'scene',               label: '场景',          width: 'w-40',  type: 'element' },
  { key: 'character_actions',   label: '角色动作',      width: 'w-48',  type: 'multiline' },
  { key: 'emotion_mood',        label: '情绪',          width: 'w-28',  type: 'text' },
  { key: 'emotion_atmosphere',  label: '情绪/氛围感',   width: 'w-48',  type: 'multiline' },
  { key: 'character_motivation', label: '角色动机',     width: 'w-48',  type: 'multiline' },
  { key: 'character_psychology', label: '心理/潜台词',   width: 'w-48',  type: 'multiline' },
  { key: 'performance_guidance', label: '表演指导',     width: 'w-48',  type: 'multiline' },
  { key: 'lighting_atmosphere', label: '光影氛围',      width: 'w-36',  type: 'multiline' },
  { key: 'dialogue',            label: '对白文本',      width: 'w-56',  type: 'multiline' },
  { key: 'sound_effects',       label: '音效',          width: 'w-32',  type: 'text' },
  { key: 'storyboard_prompts',  label: '分镜提示词',    width: 'w-56',  type: 'multiline' },
  { key: 'motion_prompts',      label: '视频运动提示词', width: 'w-56',  type: 'multiline' },
  { key: 'bgm',                 label: 'BGM',           width: 'w-28',  type: 'text' },
  { key: 'beat_video',          label: 'Beat Video',    width: 'w-28',  type: 'media-video' },
]

function TextCell({ value, onChange, multiline }: { value: string; onChange: (v: string) => void; multiline?: boolean }) {
  if (multiline) {
    return (
      <textarea
        className="w-full min-h-[40px] bg-transparent outline-none resize-none text-xs text-zinc-100 focus:bg-zinc-800 px-1 py-0.5 rounded"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  return (
    <input
      className="w-full bg-transparent outline-none text-xs text-zinc-100 focus:bg-zinc-800 px-1 py-0.5 rounded"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function NumberCell({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number" step="0.1" min="0.1"
      className="w-full bg-transparent outline-none text-xs text-zinc-100 focus:bg-zinc-800 px-1 py-0.5 rounded"
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
    />
  )
}

function MediaCell({ url, onPick, onGenerate, busy, kind }: {
  url?: string
  /** Receives the picked canvas node (or just the URL if you don't need the id). */
  onPick: (node: PickedNode) => void
  onGenerate?: () => void
  busy?: boolean
  kind: 'image' | 'video'
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const Placeholder = kind === 'image' ? ImageIcon : Video
  return (
    <div className="relative w-full h-[56px] rounded bg-zinc-800/70 border border-zinc-700 overflow-hidden flex items-center justify-center group">
      {busy && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {url ? (
        kind === 'image'
          ? <img src={thumb(url, 256)} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
          : <video src={url} className="w-full h-full object-cover" muted preload="metadata" />
      ) : (
        <Placeholder className="w-4 h-4 text-zinc-600" />
      )}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition bg-black/60 flex items-center justify-center gap-1">
        {onGenerate && (
          <button title="AI 生成" className="p-1 rounded bg-primary/80 hover:bg-primary text-primary-foreground" onClick={onGenerate}>
            <Wand2 className="w-3 h-3" />
          </button>
        )}
        <button
          title={`从画布选取${kind === 'image' ? '图片' : '视频'}节点`}
          className="p-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
          onClick={() => setPickerOpen(true)}
        >
          <FolderInput className="w-3 h-3" />
        </button>
      </div>
      <CanvasNodePickerDialog
        open={pickerOpen}
        kind={kind}
        onClose={() => setPickerOpen(false)}
        onPick={onPick}
      />
    </div>
  )
}

function ElementCell({ slot: rawSlot, onChange, identity }: {
  slot: ElementSlot | Record<string, unknown>
  onChange: (patch: Partial<ElementSlot>) => void
  /**
   * 角色 slots only: the 角色身份版 strip under the slot. The identity sheet
   * derives from this slot's asset image (edge on canvas: 角色节点 → 身份版
   * 节点), so it lives inside the character cell instead of its own column.
   */
  identity?: {
    url?: string
    busy?: boolean
    onGenerate: () => void
    onPick: (node: PickedNode) => void
  }
}) {
  // Normalize: slot might be a plain object from Zod defaults or persisted data
  const slot: ElementSlot = {
    image: String((rawSlot as ElementSlot)?.image ?? ''),
    description: String((rawSlot as ElementSlot)?.description ?? ''),
    nodeId: String((rawSlot as ElementSlot)?.nodeId ?? ''),
  }
  const [pickerOpen, setPickerOpen] = useState(false)
  const [idPickerOpen, setIdPickerOpen] = useState(false)
  const showIdentity = identity && (slot.image || slot.description || identity.url)
  return (
    <div className="flex flex-col gap-1">
      <div className="relative w-full h-[40px] rounded bg-zinc-800/70 border border-zinc-700 overflow-hidden flex items-center justify-center group">
        {slot.image ? (
          <img src={thumb(slot.image, 256)} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
        ) : (
          <ImageIcon className="w-3.5 h-3.5 text-zinc-600" />
        )}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition bg-black/60 flex items-center justify-center">
          <button
            title="从画布选取图片节点"
            className="p-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
            onClick={() => setPickerOpen(true)}
          >
            <FolderInput className="w-3 h-3" />
          </button>
        </div>
      </div>
      <input
        className="w-full bg-transparent outline-none text-[10px] text-zinc-300 focus:bg-zinc-800 px-1 py-0.5 rounded"
        value={slot.description}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="描述…"
      />
      {showIdentity && (
        <div
          className="relative w-full h-[32px] rounded bg-zinc-800/40 border border-dashed border-zinc-700 overflow-hidden flex items-center justify-center group/id"
          title="角色身份版：全身锚点+多视角+表情+细节+ID块，场景光刷光；生成视频时作为该角色的第一参考图"
        >
          {identity.busy && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {identity.url ? (
            <img src={thumb(identity.url, 256)} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
          ) : (
            <span className="text-[9px] text-zinc-600">身份版</span>
          )}
          <div className="absolute inset-0 opacity-0 group-hover/id:opacity-100 transition bg-black/60 flex items-center justify-center gap-1">
            <button
              title="AI 生成角色身份版"
              className="p-1 rounded bg-primary/80 hover:bg-primary text-primary-foreground"
              onClick={identity.onGenerate}
            >
              <Wand2 className="w-3 h-3" />
            </button>
            <button
              title="从画布选取身份版图片"
              className="p-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
              onClick={() => setIdPickerOpen(true)}
            >
              <FolderInput className="w-3 h-3" />
            </button>
          </div>
          <CanvasNodePickerDialog
            open={idPickerOpen}
            kind="image"
            onClose={() => setIdPickerOpen(false)}
            onPick={identity.onPick}
          />
        </div>
      )}
      <CanvasNodePickerDialog
        open={pickerOpen}
        kind="image"
        onClose={() => setPickerOpen(false)}
        onPick={(picked) => onChange({ image: picked.url, nodeId: picked.nodeId })}
      />
    </div>
  )
}

export function StoryboardTable() {
  const rows = useStoryboardStore((s) => s.rows)
  const updateRow = useStoryboardStore((s) => s.updateRow)
  // Patch the i-th character/prop slot in the canonical array, then re-normalize
  // so the legacy character1/2 + prop1/2 fields stay mirrored to the first two
  // (keeps un-migrated readers + persisted schema consistent). Editing the
  // trailing empty cell appends a new member/prop.
  const updateArraySlot = useCallback(
    (row: StoryboardRow, key: 'characters' | 'props', index: number, patch: Partial<ElementSlot>) => {
      const cap = key === 'characters' ? MAX_ROW_CHARACTERS : MAX_ROW_PROPS
      if (index >= cap) return
      const base: ElementSlot[] = [...((row[key] as ElementSlot[] | undefined) ?? [])]
      while (base.length <= index) base.push({ ...EMPTY_ELEMENT_SLOT })
      base[index] = { ...base[index]!, ...patch }
      const norm = normalizeRowSlots({ ...row, [key]: base })
      updateRow(row.id, key === 'characters'
        ? { characters: norm.characters, character1: norm.character1, character2: norm.character2 }
        : { props: norm.props, prop1: norm.prop1, prop2: norm.prop2 })
    },
    [updateRow],
  )
  const clear = useStoryboardStore((s) => s.clear)
  const setActiveTab = useViewStore((s) => s.setActiveTab)
  const setPlayhead = useTimelineStore((s) => s.setPlayheadTime)
  const { generateKeyframe, generateBeatVideo, generateIdentitySheets } = useStoryboardGenerate()
  const tasks = useLibtvTasksStore((s) => s.tasks)
  const [ctxMenu, setCtxMenu] = useState<TableMenuState | null>(null)

  const totalDuration = rows.reduce((sum, r) => sum + (Number(r.duration) || 0), 0)

  const busyForKf = (rowId: string) =>
    Object.values(tasks).some((t) => t.itemId === rowId && t.nodeId.startsWith('sb-kf-') && (t.status === 'pending' || t.status === 'polling'))
  const busyForBv = (rowId: string) =>
    Object.values(tasks).some((t) => t.itemId === rowId && t.nodeId.startsWith('sb-bv-') && (t.status === 'pending' || t.status === 'polling'))
  const busyForId = (rowId: string) =>
    Object.values(tasks).some((t) => t.itemId === rowId && t.nodeId.startsWith('sb-id-') && (t.status === 'pending' || t.status === 'polling'))

  const jumpToTimeline = (rowIdx: number) => {
    const start = rows.slice(0, rowIdx).reduce((s, r) => s + (Number(r.duration) || 0), 0)
    setPlayhead(start)
    setActiveTab('timeline')
  }

  /**
   * Sync slot images on every storyboard row against the canvas.
   *
   * Two passes:
   *
   *  1. AUTHORITATIVE refresh — when a slot carries `nodeId`, mirror the
   *     current canvas item's content URL. This is unconditional: even
   *     when the slot already has a valid URL, we overwrite it if the
   *     canvas node's content has moved on (the user regenerated the
   *     asset image on the canvas and expects the table to follow).
   *
   *  2. BACK-FILL by name/description — only for slots with NO usable
   *     canvas link. Covers legacy rows whose `slot.image` was parsed
   *     before short-id resolution existed, plus rows where the LLM
   *     dropped the [node:xxxxxx] tag and left description-only.
   *
   * The first pass is what makes "regenerate on canvas → click sync →
   * table reflects new image" work; the second is the original back-fill
   * for broken/empty slots.
   */
  const repairSlotImages = useCallback(() => {
    const looksLikeUrl = (s: string) =>
      /^https?:\/\//i.test(s) || s.startsWith('data:') || s.startsWith('/')
    const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase()
    const assets = useAssetStore.getState().assets
    const items = useCanvasItemStore.getState().items
    const nodes = useCanvasStore.getState().nodes

    // slot.nodeId → current canvas item content URL. Walks node →
    // itemId → item.content. Returns undefined when any link is missing
    // or the content is not a real URL (so the back-fill pass can take
    // over).
    const resolveCanvasUrl = (nodeId: string | undefined): string | undefined => {
      if (!nodeId) return undefined
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return undefined
      const itemId = (node.data as { itemId?: string }).itemId
      if (!itemId) return undefined
      const it = items[itemId]
      if (!it || it.kind !== 'image') return undefined
      return it.content && looksLikeUrl(it.content) ? it.content : undefined
    }

    type Cand = { kind: 'character' | 'scene' | 'prop' | 'keyframe'; name: string; description: string; imageUrl: string; nodeId?: string }
    const candidates: Cand[] = [
      ...assets
        .filter((a) => !!a.imageUrl)
        .map<Cand>((a) => ({ kind: a.type, name: a.name, description: a.description ?? '', imageUrl: a.imageUrl ?? '' })),
      ...nodes
        .map<Cand | null>((n) => {
          const itemId = (n.data as { itemId?: string }).itemId
          if (!itemId) return null
          const it = items[itemId]
          if (!it || it.kind !== 'image' || !it.content || !looksLikeUrl(it.content)) return null
          return {
            kind: 'keyframe' as const,
            name: it.name ?? '',
            description: it.prompt ?? it.name ?? '',
            imageUrl: it.content,
            nodeId: n.id,
          } satisfies Cand
        })
        .filter((c): c is Cand => !!c),
    ]
    const findMatch = (slot: ElementSlot, prefer: Cand['kind'][]): Cand | undefined => {
      const desc = norm(slot.description)
      const sid = (slot.nodeId ?? '').slice(0, 8)
      // 1. Exact prefix-id match against canvas nodes.
      if (sid) {
        const byId = candidates.find((c) => c.nodeId?.startsWith(sid))
        if (byId) return byId
      }
      if (!desc) return undefined
      // 2. Walk preferred kinds first to avoid e.g. matching a prop to character1.
      for (const k of prefer) {
        for (const c of candidates) {
          if (c.kind !== k) continue
          const cn = norm(c.name)
          const cd = norm(c.description)
          if (!cn && !cd) continue
          if (cn && desc.includes(cn)) return c
          if (cn && cn.includes(desc.slice(0, 12))) return c
          if (cd && desc.startsWith(cd.slice(0, 16))) return c
          if (cd && cd.startsWith(desc.slice(0, 16))) return c
        }
      }
      return undefined
    }
    const allRows = useStoryboardStore.getState().rows
    let refreshed = 0
    let backfilled = 0
    for (const row of allRows) {
      const patch: Partial<StoryboardRow> = {}
      const slotsConfig = [
        { key: 'character1' as const, prefer: ['character'] as Cand['kind'][] },
        { key: 'character2' as const, prefer: ['character'] as Cand['kind'][] },
        { key: 'prop1' as const,      prefer: ['prop'] as Cand['kind'][] },
        { key: 'prop2' as const,      prefer: ['prop'] as Cand['kind'][] },
        { key: 'scene' as const,      prefer: ['scene', 'keyframe'] as Cand['kind'][] },
      ]
      for (const { key, prefer } of slotsConfig) {
        const slot = row[key]
        if (!slot) continue
        // Pass 1: authoritative refresh via nodeId → live canvas item.
        const fresh = resolveCanvasUrl(slot.nodeId)
        if (fresh) {
          if (String(slot.image ?? '') !== fresh) {
            patch[key] = { ...slot, image: fresh }
            refreshed++
          }
          continue
        }
        // Pass 2: back-fill broken/empty slots by name/description.
        const cur = String(slot.image ?? '')
        if (cur && looksLikeUrl(cur)) continue
        const match = findMatch(slot, prefer)
        if (!match) continue
        patch[key] = { ...slot, image: match.imageUrl, nodeId: match.nodeId ?? slot.nodeId ?? '' }
        backfilled++
      }
      if (Object.keys(patch).length > 0) updateRow(row.id, patch)
    }
    const total = refreshed + backfilled
    if (total === 0) {
      toast.success('已是最新 — 没有需要同步的槽位')
    } else {
      toast.success(`已同步 ${total} 个槽位（画布刷新 ${refreshed} · 名称回填 ${backfilled}）`)
    }
  }, [updateRow])

  // Voice-driven keyframe regen for a single shot row. Reads the row freshly
  // from the store so we always use the latest slot images / metadata.
  const handleVoicePlanReady = useCallback(async (plan: VoicePlan) => {
    const row = useStoryboardStore.getState().rows.find((r) => r.id === plan.elementId)
    if (!row) return
    // Build ordered, role-labeled refs so the prompt can reference each one
    // as "image1", "image2", … in the same order as the inputs array.
    type Ref = { role: string; description: string; url: string }
    const refs: Ref[] = []
    const push = (role: string, description: string, url: string | undefined) => {
      if (!url) return
      if (refs.some((r) => r.url === url)) return
      refs.push({ role, description, url })
    }
    rowCharacters(row).forEach((s, i) => push(`角色${i + 1}`, s.description ?? '', s.image))
    rowProps(row).forEach((s, i) => push(`道具${i + 1}`, s.description ?? '', s.image))
    push('场景',  row.scene?.description ?? '',      row.scene?.image)
    push('参考',  '',                                row.reference_image)
    const legend = refs.length
      ? `Reference images (use them as labeled):\n` +
        refs.map((r, i) =>
          `- image${i + 1} = ${r.role}${r.description ? ` (${r.description})` : ''}`
        ).join('\n')
      : ''
    const finalPrompt = legend ? `${plan.newPrompt}\n\n${legend}` : plan.newPrompt
    updateRow(row.id, { status: 'in_progress' })
    try {
      const result = await runCapability({
        capability: 'text-to-image',
        inputs: [
          { kind: 'text', text: finalPrompt },
          ...refs.map((r) => ({ kind: 'image' as const, url: r.url })),
        ],
        params: { aspect: '16:9' },
      })
      const url = result.outputs[0]?.url
      if (!url) throw new Error('regen returned no image')
      updateRow(row.id, {
        keyframeUrl: url,
        reference_image: url,
        storyboard_prompts: plan.newPrompt,
        status: 'completed',
      })
      toast.success(`镜头 ${row.shot_number || row.id.slice(0, 4)} 已根据语音重生`, {
        description: plan.userIntent?.slice(0, 120),
      })
    } catch (err) {
      updateRow(row.id, { status: 'failed' })
      toast.error('镜头语音重生失败', {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [updateRow])

  // 合并相邻同场景分镜到 ≤15s：每组保留第一行（含它的 keyframe / 视频 /
  // 画布引用），其余行删除（它们已生成的画布节点不动）。文本字段按时间段
  // 重排（【0-4s】…），让长 beat 满足 Seedance ≥8s 的分时段要求。
  const mergeSameScene = useCallback(() => {
    const all = useStoryboardStore.getState().rows
    const groups = computeMergeGroups(all).filter((g) => g.length > 1)
    if (groups.length === 0) {
      toast.message('没有可合并的相邻同场景分镜', {
        description: '条件：相邻行场景相同、合计 ≤15s、角色/道具并集不超过 2 个槽位',
      })
      return
    }
    const away = groups.reduce((s, g) => s + g.length - 1, 0)
    if (!confirm(`合并 ${groups.length} 组相邻同场景分镜（减少 ${away} 行，单条 beat video 更接近 15s 上限）？\n每组保留第一行已生成的 keyframe/视频；被合并行的画布节点不会删除。`)) return
    const store = useStoryboardStore.getState()
    for (const g of groups) {
      const groupRows = g.map((i) => all[i]!)
      store.updateRow(groupRows[0]!.id, mergeRowGroup(groupRows))
      for (const r of groupRows.slice(1)) store.removeRow(r.id)
    }
    toast.success(`已合并 ${groups.length} 组同场景分镜（-${away} 行）`)
  }, [])

  const handleRowContextMenu = (e: React.MouseEvent, rowId: string) => {
    e.preventDefault()
    setCtxMenu({ rowId, x: e.clientX, y: e.clientY })
  }

  return (
    <div className="h-full flex flex-col bg-[#121212] text-zinc-100">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0 gap-2">
        <div className="text-sm font-medium shrink-0">
          分镜表 ({rows.length}) · {totalDuration.toFixed(1)}s
        </div>
        {rows.length > 0 && <BatchToolbar />}
        <button
          className="text-xs px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 text-zinc-300 shrink-0"
          onClick={repairSlotImages}
          disabled={rows.length === 0}
          title="同步：把每一行的角色/道具/场景图片刷新成画布上对应资产的最新图（在画布重新生成后，点这里让分镜表跟上）；没有 nodeId 的槽位则按名称/描述回填"
        >同步画布图片</button>
        <button
          className="text-xs px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 text-zinc-300 shrink-0"
          onClick={mergeSameScene}
          disabled={rows.length === 0}
          title="把相邻的同场景分镜合并成一条 ≤15s 的长 beat（Seedance 单条时长上限），动作/运镜按时间段重排"
        >合并同场景</button>
        <button
          className="text-xs px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 text-zinc-300 shrink-0"
          onClick={() => { if (confirm('清空分镜表？')) clear() }}
          disabled={rows.length === 0}
        >清空</button>
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
          <div className="text-center">
            <div>暂无分镜</div>
            <div className="text-xs mt-1">在聊天中说「根据画布的内容，生成分镜表格」即可自动填充</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-[#1a1a1a]">
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={cn(
                    'px-2 py-2 text-left font-medium text-zinc-300 border-b border-zinc-800 whitespace-nowrap',
                    c.width,
                  )}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const kfBusy = busyForKf(r.id)
                const bvBusy = busyForBv(r.id)
                const idBusy = busyForId(r.id)
                return (
                  <tr
                    key={r.id}
                    className="hover:bg-zinc-900/60 align-top cursor-pointer"
                    onContextMenu={(e) => handleRowContextMenu(e, r.id)}
                    onDoubleClick={() => useShotEditorStore.getState().openEditor(r.id)}
                  >
                    {/* # */}
                    <td className="px-2 py-2 text-zinc-500 border-b border-zinc-900">
                      <button className="hover:text-primary inline-flex items-center gap-1" onClick={() => jumpToTimeline(idx)} title="跳转到时间线">
                        <Play className="w-3 h-3" />{idx + 1}
                      </button>
                    </td>
                    {/* 语音 — voice-feedback mic for this shot */}
                    <td className="px-2 py-2 border-b border-zinc-900 text-center">
                      <VoiceFeedbackButton
                        elementKind="shot"
                        elementId={r.id}
                        label={`镜头 ${r.shot_number || idx + 1}`}
                        elementContext={{
                          shot_number: r.shot_number,
                          duration: r.duration,
                          visual_description: r.visual_description,
                          visual_anchor: r.visual_anchor,
                          shot_size: r.shot_size,
                          character_actions: r.character_actions,
                          emotion_mood: r.emotion_mood,
                          emotion_atmosphere: r.emotion_atmosphere,
                          lighting_atmosphere: r.lighting_atmosphere,
                          dialogue: r.dialogue,
                          storyboard_prompts: r.storyboard_prompts,
                          motion_prompts: r.motion_prompts,
                          current_keyframe: r.keyframeUrl ?? r.reference_image ?? '',
                        }}
                        onPlanReady={handleVoicePlanReady}
                        compact
                      />
                    </td>
                    {/* 镜号 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.shot_number} onChange={(v) => updateRow(r.id, { shot_number: v })} />
                    </td>
                    {/* 时长 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <NumberCell value={r.duration} onChange={(v) => updateRow(r.id, { duration: v })} />
                    </td>
                    {/* 画面描述 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.visual_description} onChange={(v) => updateRow(r.id, { visual_description: v })} />
                    </td>
                    {/* 前后衔接 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.transition_note} onChange={(v) => updateRow(r.id, { transition_note: v })} />
                    </td>
                    {/* 视觉锚点 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.visual_anchor} onChange={(v) => updateRow(r.id, { visual_anchor: v })} />
                    </td>
                    {/* 黑白故事板 (multi-panel grid keyframe) */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <MediaCell kind="image" url={r.keyframeUrl || r.reference_image} busy={kfBusy}
                        onPick={(picked) => updateRow(r.id, { reference_image: picked.url, keyframeUrl: picked.url, keyframeNodeId: picked.nodeId })}
                        onGenerate={() => generateKeyframe(r)} />
                    </td>
                    {/* 开场构图 (clean keyframe — 视频的开场机位/首帧标准; 生成时
                        与故事板成对产出: 故事板先渲染, 开场构图引用其第1格构图) */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <MediaCell kind="image" url={r.keyframeCleanUrl} busy={kfBusy}
                        onPick={(picked) => updateRow(r.id, { keyframeCleanUrl: picked.url, keyframeCleanNodeId: picked.nodeId })}
                        onGenerate={() => generateKeyframe(r)} />
                    </td>
                    {/* 景别 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.shot_size} onChange={(v) => updateRow(r.id, { shot_size: v })} />
                    </td>
                    {/* 角色（单列，可放多个角色；每个成员各自一张身份版） */}
                    <td className="px-2 py-2 border-b border-zinc-900 align-top">
                      <div className="space-y-2">
                        {(() => {
                          const chars = r.characters?.length ? r.characters : rowCharacters(r)
                          // Existing members + one trailing empty cell to add another (until the cap).
                          const cells = [...chars]
                          if (cells.length < MAX_ROW_CHARACTERS) cells.push({ ...EMPTY_ELEMENT_SLOT })
                          const sheetUrls = rowIdentitySheets(r)
                          const lastRealIdx = chars.length - 1
                          return cells.map((slot, i) => (
                            <ElementCell key={i} slot={slot}
                              onChange={(p) => updateArraySlot(r, 'characters', i, p)}
                              // Real members (not the trailing "add" cell) each get their own
                              // identity-sheet strip → per-member 身份版.
                              identity={i <= lastRealIdx ? {
                                url: sheetUrls[i],
                                busy: idBusy,
                                onGenerate: () => generateIdentitySheets(r, i + 1),
                                onPick: (picked) => {
                                  updateRow(r.id, withIdentitySheet(r, i, picked.url, picked.nodeId ?? ''))
                                  if (slot.nodeId && picked.nodeId) useCanvasStore.getState().addEdge(slot.nodeId, picked.nodeId)
                                },
                              } : undefined} />
                          ))
                        })()}
                      </div>
                    </td>
                    {/* 道具（单列，可放多个道具） */}
                    <td className="px-2 py-2 border-b border-zinc-900 align-top">
                      <div className="space-y-2">
                        {(() => {
                          const props = r.props?.length ? r.props : rowProps(r)
                          const cells = [...props]
                          if (cells.length < MAX_ROW_PROPS) cells.push({ ...EMPTY_ELEMENT_SLOT })
                          return cells.map((slot, i) => (
                            <ElementCell key={i} slot={slot}
                              onChange={(p) => updateArraySlot(r, 'props', i, p)} />
                          ))
                        })()}
                      </div>
                    </td>
                    {/* 场景 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <ElementCell slot={r.scene ?? { image: '', description: '', nodeId: '' }}
                        onChange={(p) => updateRow(r.id, { scene: { ...(r.scene ?? { image: '', description: '', nodeId: '' }), ...p } })} />
                    </td>
                    {/* 角色动作 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.character_actions} onChange={(v) => updateRow(r.id, { character_actions: v })} />
                    </td>
                    {/* 情绪 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.emotion_mood} onChange={(v) => updateRow(r.id, { emotion_mood: v })} />
                    </td>
                    {/* 情绪 / 氛围感 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.emotion_atmosphere} onChange={(v) => updateRow(r.id, { emotion_atmosphere: v })} />
                    </td>
                    {/* 角色动机 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.character_motivation} onChange={(v) => updateRow(r.id, { character_motivation: v })} />
                    </td>
                    {/* 心理 / 潜台词 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.character_psychology} onChange={(v) => updateRow(r.id, { character_psychology: v })} />
                    </td>
                    {/* 表演指导 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.performance_guidance} onChange={(v) => updateRow(r.id, { performance_guidance: v })} />
                    </td>
                    {/* 光影氛围 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.lighting_atmosphere} onChange={(v) => updateRow(r.id, { lighting_atmosphere: v })} />
                    </td>
                    {/* 对白文本 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.dialogue} onChange={(v) => updateRow(r.id, { dialogue: v })} />
                    </td>
                    {/* 音效 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.sound_effects} onChange={(v) => updateRow(r.id, { sound_effects: v })} />
                    </td>
                    {/* 分镜提示词 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.storyboard_prompts} onChange={(v) => updateRow(r.id, { storyboard_prompts: v })} />
                    </td>
                    {/* 视频运动提示词 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.motion_prompts} onChange={(v) => updateRow(r.id, { motion_prompts: v })} />
                    </td>
                    {/* BGM */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.bgm} onChange={(v) => updateRow(r.id, { bgm: v })} />
                    </td>
                    {/* Beat Video */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <MediaCell kind="video" url={r.beatVideoUrl} busy={bvBusy}
                        onPick={(picked) => updateRow(r.id, { beatVideoUrl: picked.url })}
                        onGenerate={() => generateBeatVideo(r)} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <TableContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  )
}
