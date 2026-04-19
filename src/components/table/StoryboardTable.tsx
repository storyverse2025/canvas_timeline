import { useRef, useState } from 'react'
import { Image as ImageIcon, Video, Wand2, Upload, Play, Volume2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useViewStore } from '@/stores/view-store'
import { useStoryboardGenerate } from '@/hooks/useStoryboardGenerate'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import { TableContextMenu, type TableMenuState } from './TableContextMenu'
import type { StoryboardRow, ElementSlot } from '@/types/storyboard'

interface Col {
  key: string
  label: string
  width: string
  type?: 'text' | 'number' | 'multiline' | 'media-image' | 'media-video' | 'media-audio' | 'element' | 'select'
}

const COLUMNS: Col[] = [
  { key: 'index',               label: '#',             width: 'w-10' },
  { key: 'shot_number',         label: '镜号',          width: 'w-20',  type: 'text' },
  { key: 'duration',            label: '时长(秒)',      width: 'w-20',  type: 'number' },
  { key: 'visual_description',  label: '画面描述',      width: 'w-56',  type: 'multiline' },
  { key: 'visual_anchor',       label: '视觉锚点',      width: 'w-40',  type: 'multiline' },
  { key: 'reference_image',     label: '参考/KF',       width: 'w-28',  type: 'media-image' },
  { key: 'shot_size',           label: '景别',          width: 'w-24',  type: 'text' },
  { key: 'character1',          label: '角色1',         width: 'w-40',  type: 'element' },
  { key: 'character2',          label: '角色2',         width: 'w-40',  type: 'element' },
  { key: 'prop1',               label: '道具1',         width: 'w-40',  type: 'element' },
  { key: 'prop2',               label: '道具2',         width: 'w-40',  type: 'element' },
  { key: 'scene',               label: '场景',          width: 'w-40',  type: 'element' },
  { key: 'character_actions',   label: '角色动作',      width: 'w-48',  type: 'multiline' },
  { key: 'emotion_mood',        label: '情绪',          width: 'w-28',  type: 'text' },
  { key: 'lighting_atmosphere', label: '光影氛围',      width: 'w-36',  type: 'multiline' },
  { key: 'dialogue',            label: '对白文本',      width: 'w-56',  type: 'multiline' },
  { key: 'dialogue_audio',      label: '对白音频',      width: 'w-28',  type: 'media-audio' },
  { key: 'sound_effects',       label: '音效',          width: 'w-32',  type: 'text' },
  { key: 'storyboard_prompts',  label: '分镜提示词',    width: 'w-56',  type: 'multiline' },
  { key: 'motion_prompts',      label: '视频运动提示词', width: 'w-56',  type: 'multiline' },
  { key: 'bgm',                 label: 'BGM',           width: 'w-28',  type: 'text' },
  { key: 'bgm_audio',           label: 'BGM 音频',      width: 'w-28',  type: 'media-audio' },
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

function MediaCell({ url, onChange, onGenerate, busy, kind }: {
  url?: string; onChange: (v: string) => void; onGenerate?: () => void; busy?: boolean
  kind: 'image' | 'video'
}) {
  const fileRef = useRef<HTMLInputElement>(null)
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
          ? <img src={url} alt="" className="w-full h-full object-cover" />
          : <video src={url} className="w-full h-full object-cover" muted />
      ) : (
        <Placeholder className="w-4 h-4 text-zinc-600" />
      )}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition bg-black/60 flex items-center justify-center gap-1">
        {onGenerate && (
          <button title="AI 生成" className="p-1 rounded bg-primary/80 hover:bg-primary text-primary-foreground" onClick={onGenerate}>
            <Wand2 className="w-3 h-3" />
          </button>
        )}
        <button title="上传" className="p-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100" onClick={() => fileRef.current?.click()}>
          <Upload className="w-3 h-3" />
        </button>
      </div>
      <input
        ref={fileRef} type="file" accept={kind === 'image' ? 'image/*' : 'video/*'} className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return
          const r = new FileReader(); r.onload = () => { if (typeof r.result === 'string') onChange(r.result) }; r.readAsDataURL(f)
        }}
      />
    </div>
  )
}

function AudioCell({ url, onChange }: { url?: string; onChange: (v: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="relative w-full h-[40px] rounded bg-zinc-800/70 border border-zinc-700 overflow-hidden flex items-center justify-center group">
      {url ? (
        <audio src={url} controls className="w-full h-full" style={{ maxHeight: 36 }} />
      ) : (
        <Volume2 className="w-4 h-4 text-zinc-600" />
      )}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition bg-black/60 flex items-center justify-center">
        <button title="上传" className="p-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100" onClick={() => fileRef.current?.click()}>
          <Upload className="w-3 h-3" />
        </button>
      </div>
      <input
        ref={fileRef} type="file" accept="audio/*" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return
          const r = new FileReader(); r.onload = () => { if (typeof r.result === 'string') onChange(r.result) }; r.readAsDataURL(f)
        }}
      />
    </div>
  )
}

function ElementCell({ slot: rawSlot, onChange }: {
  slot: ElementSlot | Record<string, unknown>
  onChange: (patch: Partial<ElementSlot>) => void
}) {
  // Normalize: slot might be a plain object from Zod defaults or persisted data
  const slot: ElementSlot = {
    image: String((rawSlot as ElementSlot)?.image ?? ''),
    description: String((rawSlot as ElementSlot)?.description ?? ''),
    nodeId: String((rawSlot as ElementSlot)?.nodeId ?? ''),
  }
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-col gap-1">
      <div className="relative w-full h-[40px] rounded bg-zinc-800/70 border border-zinc-700 overflow-hidden flex items-center justify-center group">
        {slot.image ? (
          <img src={slot.image} alt="" className="w-full h-full object-cover" />
        ) : (
          <ImageIcon className="w-3.5 h-3.5 text-zinc-600" />
        )}
        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition bg-black/60 flex items-center justify-center">
          <button className="p-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100" onClick={() => fileRef.current?.click()}>
            <Upload className="w-3 h-3" />
          </button>
        </div>
        <input
          ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]; if (!f) return
            const r = new FileReader(); r.onload = () => { if (typeof r.result === 'string') onChange({ image: r.result }) }; r.readAsDataURL(f)
          }}
        />
      </div>
      <input
        className="w-full bg-transparent outline-none text-[10px] text-zinc-300 focus:bg-zinc-800 px-1 py-0.5 rounded"
        value={slot.description}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="描述…"
      />
    </div>
  )
}

export function StoryboardTable() {
  const rows = useStoryboardStore((s) => s.rows)
  const updateRow = useStoryboardStore((s) => s.updateRow)
  const clear = useStoryboardStore((s) => s.clear)
  const setActiveTab = useViewStore((s) => s.setActiveTab)
  const setPlayhead = useTimelineStore((s) => s.setPlayheadTime)
  const { generateKeyframe, generateBeatVideo } = useStoryboardGenerate()
  const tasks = useLibtvTasksStore((s) => s.tasks)
  const [ctxMenu, setCtxMenu] = useState<TableMenuState | null>(null)

  const totalDuration = rows.reduce((sum, r) => sum + (Number(r.duration) || 0), 0)

  const busyForKf = (rowId: string) =>
    Object.values(tasks).some((t) => t.itemId === rowId && t.nodeId.startsWith('sb-kf-') && (t.status === 'pending' || t.status === 'polling'))
  const busyForBv = (rowId: string) =>
    Object.values(tasks).some((t) => t.itemId === rowId && t.nodeId.startsWith('sb-bv-') && (t.status === 'pending' || t.status === 'polling'))

  const jumpToTimeline = (rowIdx: number) => {
    const start = rows.slice(0, rowIdx).reduce((s, r) => s + (Number(r.duration) || 0), 0)
    setPlayhead(start)
    setActiveTab('timeline')
  }

  const handleRowContextMenu = (e: React.MouseEvent, rowId: string) => {
    e.preventDefault()
    setCtxMenu({ rowId, x: e.clientX, y: e.clientY })
  }

  return (
    <div className="h-full flex flex-col bg-[#121212] text-zinc-100">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0">
        <div className="text-sm font-medium">
          分镜表 · Storyboard ({rows.length}) · 总时长 {totalDuration.toFixed(1)}s
        </div>
        <button
          className="text-xs px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 text-zinc-300"
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
                return (
                  <tr
                    key={r.id}
                    className="hover:bg-zinc-900/60 align-top"
                    onContextMenu={(e) => handleRowContextMenu(e, r.id)}
                  >
                    {/* # */}
                    <td className="px-2 py-2 text-zinc-500 border-b border-zinc-900">
                      <button className="hover:text-primary inline-flex items-center gap-1" onClick={() => jumpToTimeline(idx)} title="跳转到时间线">
                        <Play className="w-3 h-3" />{idx + 1}
                      </button>
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
                    {/* 视觉锚点 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.visual_anchor} onChange={(v) => updateRow(r.id, { visual_anchor: v })} />
                    </td>
                    {/* 参考 / Keyframe */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <MediaCell kind="image" url={r.keyframeUrl || r.reference_image} busy={kfBusy}
                        onChange={(v) => updateRow(r.id, { reference_image: v, keyframeUrl: v })}
                        onGenerate={() => generateKeyframe(r)} />
                    </td>
                    {/* 景别 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.shot_size} onChange={(v) => updateRow(r.id, { shot_size: v })} />
                    </td>
                    {/* 角色1 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <ElementCell slot={r.character1 ?? { image: '', description: '', nodeId: '' }}
                        onChange={(p) => updateRow(r.id, { character1: { ...(r.character1 ?? { image: '', description: '', nodeId: '' }), ...p } })} />
                    </td>
                    {/* 角色2 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <ElementCell slot={r.character2 ?? { image: '', description: '', nodeId: '' }}
                        onChange={(p) => updateRow(r.id, { character2: { ...(r.character2 ?? { image: '', description: '', nodeId: '' }), ...p } })} />
                    </td>
                    {/* 道具1 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <ElementCell slot={r.prop1 ?? { image: '', description: '', nodeId: '' }}
                        onChange={(p) => updateRow(r.id, { prop1: { ...(r.prop1 ?? { image: '', description: '', nodeId: '' }), ...p } })} />
                    </td>
                    {/* 道具2 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <ElementCell slot={r.prop2 ?? { image: '', description: '', nodeId: '' }}
                        onChange={(p) => updateRow(r.id, { prop2: { ...(r.prop2 ?? { image: '', description: '', nodeId: '' }), ...p } })} />
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
                    {/* 光影氛围 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.lighting_atmosphere} onChange={(v) => updateRow(r.id, { lighting_atmosphere: v })} />
                    </td>
                    {/* 对白文本 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.dialogue} onChange={(v) => updateRow(r.id, { dialogue: v })} />
                    </td>
                    {/* 对白音频 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <AudioCell url={r.dialogue_audio} onChange={(v) => updateRow(r.id, { dialogue_audio: v })} />
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
                    {/* BGM 音频 */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <AudioCell url={r.bgm_audio} onChange={(v) => updateRow(r.id, { bgm_audio: v })} />
                    </td>
                    {/* Beat Video */}
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <MediaCell kind="video" url={r.beatVideoUrl} busy={bvBusy}
                        onChange={(v) => updateRow(r.id, { beatVideoUrl: v })}
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
