import { useState } from 'react'
import { Loader2, Wand2, MessageSquare, Pencil, Check, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { runCapability } from '@/lib/capabilities/client'
import { api } from '@/lib/api-client'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { cn } from '@/lib/utils'
import { applyEditResult } from './apply-edit-result'

interface Props { rowId: string; imageUrl: string }

type Tab = 'feedback' | 'direct'

export function DialogEditPanel({ rowId, imageUrl }: Props) {
  const row = useStoryboardStore((s) => s.rows.find((r) => r.id === rowId))
  const [tab, setTab] = useState<Tab>('feedback')

  // Shared image-edit result state — whichever tab generated the latest
  // candidate, the preview + Apply button live here so the user always
  // confirms before the row + canvas are touched.
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  // Direct-edit tab: user types description, goes straight to smart-edit.
  const [directPrompt, setDirectPrompt] = useState('')

  // AI-feedback tab: user describes the change, AI rewrites it into a
  // polished prompt, user reviews + confirms, then we feed THAT into
  // smart-edit. Two-step so the user can catch wonky rewrites before any
  // image generation cost is spent.
  const [feedbackText, setFeedbackText] = useState('')
  const [revising, setRevising] = useState(false)
  const [revisedPrompt, setRevisedPrompt] = useState<string | null>(null)
  const [userIntent, setUserIntent] = useState<string>('')
  const [keyChanges, setKeyChanges] = useState<string[]>([])

  const elementContext = row
    ? {
        shot_number: row.shot_number,
        visual_description: row.visual_description,
        shot_size: row.shot_size,
        emotion_mood: row.emotion_mood,
        lighting_atmosphere: row.lighting_atmosphere,
        character_actions: row.character_actions,
        dialogue: row.dialogue,
      }
    : {}

  const runSmartEdit = async (prompt: string) => {
    if (!prompt.trim() || !imageUrl) return
    setRunning(true)
    try {
      const r = await runCapability({
        capability: 'smart-edit',
        inputs: [
          { kind: 'text', text: prompt.trim() },
          { kind: 'image', url: imageUrl },
        ],
      })
      const url = r.outputs[0]?.url
      if (url) {
        setResultUrl(url)
        toast.success('编辑完成')
      }
    } catch (e) {
      toast.error('编辑失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setRunning(false)
    }
  }

  const handleReviseFromFeedback = async () => {
    if (!feedbackText.trim()) return
    setRevising(true)
    setRevisedPrompt(null)
    try {
      const plan = await api.voiceFeedback.textRevise({
        text: feedbackText.trim(),
        elementKind: 'keyframe',
        elementContext,
      })
      setRevisedPrompt(plan.new_prompt)
      setUserIntent(plan.user_intent || '')
      setKeyChanges(plan.key_changes ?? [])
    } catch (e) {
      toast.error('AI 改写失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setRevising(false)
    }
  }

  const handleApply = () => {
    if (!resultUrl) return
    applyEditResult(rowId, resultUrl, tab === 'feedback' ? 'AI 反馈修图' : '修图')
    setResultUrl(null)
    setDirectPrompt('')
    setFeedbackText('')
    setRevisedPrompt(null)
    setUserIntent('')
    setKeyChanges([])
    toast.success('已应用到分镜 + 画布已添加节点')
  }

  const handleDiscardRevised = () => {
    setRevisedPrompt(null)
    setUserIntent('')
    setKeyChanges([])
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Tab strip */}
      <div className="flex items-center gap-0.5 bg-secondary/50 rounded-md p-0.5 self-start">
        <button
          onClick={() => setTab('feedback')}
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors',
            tab === 'feedback'
              ? 'bg-background text-foreground shadow-sm font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <MessageSquare className="w-3 h-3" />
          给 AI 反馈
        </button>
        <button
          onClick={() => setTab('direct')}
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors',
            tab === 'direct'
              ? 'bg-background text-foreground shadow-sm font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Pencil className="w-3 h-3" />
          直接编辑
        </button>
      </div>

      {tab === 'feedback' && (
        <>
          <label className="text-[10px] text-muted-foreground uppercase">
            告诉 AI 你想怎么改
          </label>
          <textarea
            className="w-full min-h-[80px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            placeholder="例: 这张图人物表情太平了，应该更愤怒一点；背景的灯也太亮了"
            disabled={revising || running}
          />
          {!revisedPrompt && (
            <button
              className="w-full py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
              disabled={revising || !feedbackText.trim() || !imageUrl}
              onClick={handleReviseFromFeedback}
            >
              {revising ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
              AI 改写 prompt
            </button>
          )}

          {revisedPrompt && (
            <div className="mt-1 space-y-2 rounded border border-emerald-700/40 bg-emerald-950/20 p-2">
              {userIntent && (
                <div className="text-[10px] text-emerald-300/80">
                  <strong>AI 理解:</strong> {userIntent}
                </div>
              )}
              <div className="text-[10px] text-muted-foreground">
                <strong>改写后的 prompt:</strong>
              </div>
              <div className="text-[11px] text-foreground/90 max-h-40 overflow-auto whitespace-pre-wrap">
                {revisedPrompt}
              </div>
              {keyChanges.length > 0 && (
                <div className="text-[10px] text-muted-foreground">
                  <strong>关键改动:</strong>
                  <ul className="list-disc list-inside">
                    {keyChanges.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  className="flex-1 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
                  disabled={running}
                  onClick={() => runSmartEdit(revisedPrompt)}
                >
                  {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  用这个 prompt 修图
                </button>
                <button
                  className="px-2 py-1.5 text-xs rounded hover:bg-accent text-muted-foreground inline-flex items-center gap-1"
                  disabled={running}
                  onClick={handleDiscardRevised}
                  title="重新写反馈"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'direct' && (
        <>
          <label className="text-[10px] text-muted-foreground uppercase">描述修改内容</label>
          <textarea
            className="w-full min-h-[80px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
            value={directPrompt}
            onChange={(e) => setDirectPrompt(e.target.value)}
            placeholder="例: 把背景改为夜晚，加上月光"
            disabled={running}
          />
          <button
            className="w-full py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
            disabled={running || !directPrompt.trim() || !imageUrl}
            onClick={() => runSmartEdit(directPrompt)}
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            AI 修图
          </button>
        </>
      )}

      {resultUrl && (
        <div className="mt-2 space-y-2">
          <img src={resultUrl} alt="result" className="w-full rounded border border-border" />
          <button className="w-full py-1.5 text-xs rounded bg-emerald-600 text-white hover:opacity-90" onClick={handleApply}>
            应用到分镜
          </button>
        </div>
      )}
    </div>
  )
}
