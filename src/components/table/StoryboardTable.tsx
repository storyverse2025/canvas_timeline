import { useRef } from 'react'
import { Image as ImageIcon, Video, Wand2, Trash2, Upload, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useViewStore } from '@/stores/view-store'
import { useLibtvGenerate } from '@/hooks/useLibtvGenerate'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import type { StoryboardRow } from '@/types/storyboard'

interface Col {
  key: string;
  label: string;
  width: string;
  multiline?: boolean;
}

const COLUMNS: Col[] = [
  { key: 'index',               label: '#',          width: 'w-10' },
  { key: 'shot_number',         label: '镜号',       width: 'w-20' },
  { key: 'duration',            label: '时长(秒)',   width: 'w-20' },
  { key: 'visual_description',  label: '画面描述',   width: 'w-64', multiline: true },
  { key: 'reference_image',     label: '参考',       width: 'w-32' },
  { key: 'shot_size',           label: '景别',       width: 'w-24' },
  { key: 'character_actions',   label: '角色动作',   width: 'w-56', multiline: true },
  { key: 'emotion_mood',        label: '情绪',       width: 'w-28' },
  { key: 'scene_tags',          label: '场景标签',   width: 'w-32' },
  { key: 'lighting_atmosphere', label: '光影氛围',   width: 'w-40', multiline: true },
  { key: 'sound_effects',       label: '音效',       width: 'w-36' },
  { key: 'dialogue',            label: '对白',       width: 'w-64', multiline: true },
  { key: 'storyboard_prompts',  label: '分镜提示词', width: 'w-64', multiline: true },
  { key: 'motion_prompts',      label: '视频运动提示词', width: 'w-64', multiline: true },
  { key: 'bgm',                 label: 'BGM',         width: 'w-32' },
  { key: 'status',              label: '状态',       width: 'w-24' },
  { key: 'ai_image',            label: 'AI 图',      width: 'w-28' },
  { key: 'ai_video',            label: 'AI 视频',    width: 'w-28' },
]

const STATUS_STYLES: Record<StoryboardRow['status'], string> = {
  todo:        'bg-zinc-700 text-zinc-200',
  in_progress: 'bg-amber-500/30 text-amber-200 border border-amber-500/50',
  done:        'bg-emerald-500/30 text-emerald-200 border border-emerald-500/50',
}

function TextCell({
  value, onChange, multiline,
}: { value: string; onChange: (v: string) => void; multiline?: boolean }) {
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
      type="number"
      step="0.1"
      min="0.1"
      className="w-full bg-transparent outline-none text-xs text-zinc-100 focus:bg-zinc-800 px-1 py-0.5 rounded"
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
    />
  )
}

function MediaCell({
  url, onChange, onGenerate, busy, kind,
}: { url?: string; onChange: (v: string) => void; onGenerate: () => void; busy?: boolean; kind: 'image' | 'video' }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const Placeholder = kind === 'image' ? ImageIcon : Video
  return (
    <div className="relative w-full h-[64px] rounded bg-zinc-800/70 border border-zinc-700 overflow-hidden flex items-center justify-center group">
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
        <Placeholder className="w-5 h-5 text-zinc-600" />
      )}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition bg-black/60 flex items-center justify-center gap-1">
        <button
          title="AI 生成"
          className="p-1 rounded bg-primary/80 hover:bg-primary text-primary-foreground"
          onClick={onGenerate}
        >
          <Wand2 className="w-3 h-3" />
        </button>
        <button
          title="上传"
          className="p-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="w-3 h-3" />
        </button>
      </div>
      <input
        ref={fileRef} type="file" accept={kind === 'image' ? 'image/*' : 'video/*'} className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]; if (!f) return
          const r = new FileReader()
          r.onload = () => { if (typeof r.result === 'string') onChange(r.result) }
          r.readAsDataURL(f)
        }}
      />
    </div>
  )
}

export function StoryboardTable() {
  const rows = useStoryboardStore((s) => s.rows)
  const updateRow = useStoryboardStore((s) => s.updateRow)
  const removeRow = useStoryboardStore((s) => s.removeRow)
  const clear = useStoryboardStore((s) => s.clear)
  const setActiveTab = useViewStore((s) => s.setActiveTab)
  const setPlayhead = useTimelineStore((s) => s.setPlayheadTime)
  const generate = useLibtvGenerate()
  const tasks = useLibtvTasksStore((s) => s.tasks)

  const totalDuration = rows.reduce((sum, r) => sum + (Number(r.duration) || 0), 0)

  const busyFor = (rowId: string) =>
    Object.values(tasks).some((t) => t.itemId === rowId && (t.status === 'pending' || t.status === 'polling'))

  const jumpToTimeline = (rowIdx: number) => {
    const start = rows.slice(0, rowIdx).reduce((s, r) => s + (Number(r.duration) || 0), 0)
    setPlayhead(start)
    setActiveTab('timeline')
  }

  const triggerAiImage = (r: StoryboardRow) => {
    const prompt = r.storyboard_prompts || r.visual_description || r.shot_number
    if (!prompt.trim()) return
    const full = [prompt, r.lighting_atmosphere, r.emotion_mood].filter(Boolean).join('. ')
    generate({ nodeId: `sb-${r.id}`, itemId: r.id, prompt: full })
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
                <th className="px-2 py-2 w-10 border-b border-zinc-800"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const busy = busyFor(r.id)
                return (
                  <tr key={r.id} className="hover:bg-zinc-900/60 align-top">
                    <td className="px-2 py-2 text-zinc-500 border-b border-zinc-900">
                      <button
                        className="hover:text-primary inline-flex items-center gap-1"
                        onClick={() => jumpToTimeline(idx)}
                        title="跳转到时间线"
                      >
                        <Play className="w-3 h-3" />
                        {idx + 1}
                      </button>
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.shot_number} onChange={(v) => updateRow(r.id, { shot_number: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <NumberCell value={r.duration} onChange={(v) => updateRow(r.id, { duration: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.visual_description} onChange={(v) => updateRow(r.id, { visual_description: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <MediaCell
                        kind="image"
                        url={r.reference_image}
                        busy={busy}
                        onChange={(v) => updateRow(r.id, { reference_image: v })}
                        onGenerate={() => triggerAiImage(r)}
                      />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.shot_size} onChange={(v) => updateRow(r.id, { shot_size: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.character_actions} onChange={(v) => updateRow(r.id, { character_actions: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.emotion_mood} onChange={(v) => updateRow(r.id, { emotion_mood: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.scene_tags} onChange={(v) => updateRow(r.id, { scene_tags: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.lighting_atmosphere} onChange={(v) => updateRow(r.id, { lighting_atmosphere: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.sound_effects} onChange={(v) => updateRow(r.id, { sound_effects: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.dialogue} onChange={(v) => updateRow(r.id, { dialogue: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.storyboard_prompts} onChange={(v) => updateRow(r.id, { storyboard_prompts: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell multiline value={r.motion_prompts} onChange={(v) => updateRow(r.id, { motion_prompts: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <TextCell value={r.bgm} onChange={(v) => updateRow(r.id, { bgm: v })} />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <select
                        className={cn('text-[11px] rounded px-1.5 py-0.5 outline-none', STATUS_STYLES[r.status])}
                        value={r.status}
                        onChange={(e) => updateRow(r.id, { status: e.target.value as StoryboardRow['status'] })}
                      >
                        <option value="todo">待办</option>
                        <option value="in_progress">进行中</option>
                        <option value="done">已完成</option>
                      </select>
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <MediaCell
                        kind="image"
                        url={r.aiImageUrl}
                        busy={busy}
                        onChange={(v) => updateRow(r.id, { aiImageUrl: v })}
                        onGenerate={() => triggerAiImage(r)}
                      />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <MediaCell
                        kind="video"
                        url={r.aiVideoUrl}
                        onChange={(v) => updateRow(r.id, { aiVideoUrl: v })}
                        onGenerate={() => triggerAiImage(r)}
                      />
                    </td>
                    <td className="px-2 py-2 border-b border-zinc-900">
                      <button className="text-zinc-500 hover:text-destructive" onClick={() => removeRow(r.id)} title="删除">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
