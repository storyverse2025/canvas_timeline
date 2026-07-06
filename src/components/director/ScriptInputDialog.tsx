import { useRef, useState } from 'react'
import { X, Upload, Clapperboard, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectDB } from '@/stores/project-db'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useViewStore } from '@/stores/view-store'
import { useChatStore } from '@/stores/chat-store'
import { runDirectorPipeline, type PipelineState } from '@/lib/director-assistant'
import { parseAndValidateStoryboard } from '@/lib/storyboard-parser'
import { mergeSameSceneRows } from '@/lib/storyboard-merge'
import { ArtDirectionPanel } from './ArtDirectionPanel'
import { DirectorPipelineProgress } from './DirectorPipelineProgress'
import { InterviewCard } from '@/components/chat/InterviewCard'

interface Props {
  onClose: () => void
}

export function ScriptInputDialog({ onClose }: Props) {
  const script = useProjectDB((s) => s.script)
  const updateScript = useProjectDB((s) => s.updateScript)
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const answerQuestion = useChatStore((s) => s.answerQuestion)
  const [text, setText] = useState(script.text)
  const [totalDurationStr, setTotalDurationStr] = useState(
    script.totalDurationSeconds > 0 ? String(script.totalDurationSeconds) : '30',
  )
  const [showArt, setShowArt] = useState(false)
  const [phase, setPhase] = useState<'input' | 'running' | 'done' | 'error'>('input')
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const totalDurationSeconds = Number(totalDurationStr)
  const totalDurationValid =
    Number.isFinite(totalDurationSeconds) && totalDurationSeconds > 0 && totalDurationSeconds <= 7200

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setText(reader.result)
        toast.success(`已导入: ${f.name}`)
      }
    }
    reader.readAsText(f)
    e.target.value = ''
  }

  const handleOptimize = async () => {
    if (!text.trim()) { toast.error('请输入或上传剧本'); return }
    if (!totalDurationValid) { toast.error('请输入有效的总时长（1-7200 秒）'); return }
    setPhase('running')
    updateScript({ text: text.trim(), totalDurationSeconds })

    try {
      const { state, storyboardJson } = await runDirectorPipeline((s) => {
        setPipelineState({ ...s })
      })
      setPipelineState(state)

      // Parse and apply storyboard
      const result = parseAndValidateStoryboard(storyboardJson)
      if (result.ok && result.rows) {
        // 同场景相邻分镜合并到 ≤15s，单条 beat video 尽量吃满 Seedance 时长。
        const merged = mergeSameSceneRows(result.rows)
        useStoryboardStore.getState().replaceAll(merged.rows)
        updateScript({ optimizedText: storyboardJson })
        toast.success(
          merged.mergedAway > 0
            ? `分镜表已生成：${result.rows.length} 行 → 合并同场景后 ${merged.rows.length} 行（单条更接近 15s）`
            : `分镜表已生成：${merged.rows.length} 行`,
        )
        setPhase('done')
      } else {
        toast.error('分镜 JSON 解析失败', {
          description: (result.errors ?? []).slice(0, 3).join('; '),
        })
        setPhase('error')
      }
    } catch (e) {
      toast.error('导演助手失败', { description: String((e as Error).message).slice(0, 200) })
      setPhase('error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[600px] max-w-full max-h-[80vh] bg-card border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Clapperboard className="w-4 h-4 text-primary" />
            导演助手 — 智能优化流程
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          {/* Script input */}
          {phase === 'input' && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] text-muted-foreground uppercase">剧本 / 故事大纲</label>
                  <button
                    className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload className="w-3 h-3" /> 上传文件
                  </button>
                  <input ref={fileRef} type="file" accept=".txt,.md,.doc,.docx" className="hidden" onChange={handleUpload} />
                </div>
                <textarea
                  className="w-full min-h-[120px] text-xs bg-background border border-border rounded px-3 py-2 outline-none resize-y"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="在此输入或粘贴剧本内容…&#10;&#10;例：&#10;第一幕：黎明时分，山间小屋。&#10;主角醒来，发现窗外下着大雪…"
                  autoFocus
                />
              </div>

              <div>
                <label className="text-[10px] text-muted-foreground uppercase block mb-1">
                  总时长（秒） <span className="text-destructive">*</span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={7200}
                  step={1}
                  value={totalDurationStr}
                  onChange={(e) => setTotalDurationStr(e.target.value)}
                  className={`w-full text-xs bg-background border rounded px-3 py-2 outline-none ${
                    totalDurationValid ? 'border-border' : 'border-destructive'
                  }`}
                  placeholder="例如 30 / 60 / 600"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  分镜表每行时长之和必须等于此总时长，LLM 会被强制约束。
                </p>
              </div>

              {/* Art direction (collapsible) */}
              <div>
                <button
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground mb-1"
                  onClick={() => setShowArt(!showArt)}
                >
                  {showArt ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  美术设定
                </button>
                {showArt && <ArtDirectionPanel />}
              </div>
            </>
          )}

          {/* Agent interview — surfaces in-dialog so the modal backdrop
              doesn't trap the user. When an agent yields a Question turn the
              card appears here; submitting it resumes the pipeline. */}
          {phase === 'running' && pendingQuestion && (
            <InterviewCard
              question={pendingQuestion.question}
              askedBy={pendingQuestion.agentLabel}
              onSubmit={(answer) => answerQuestion(pendingQuestion.id, answer)}
            />
          )}

          {/* Pipeline progress */}
          {pipelineState && <DirectorPipelineProgress state={pipelineState} />}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          {phase === 'done' ? (
            <>
              <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={() => { useViewStore.getState().setActiveTab('table'); onClose() }}>
                查看分镜表
              </button>
              <button className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90" onClick={() => setPhase('input')}>
                重新优化
              </button>
            </>
          ) : phase === 'error' ? (
            <>
              <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>关闭</button>
              <button className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90" onClick={() => setPhase('input')}>重试</button>
            </>
          ) : phase === 'running' ? (
            <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>后台运行</button>
          ) : (
            <>
              <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>取消</button>
              <button
                className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1.5"
                disabled={!text.trim() || !totalDurationValid}
                onClick={handleOptimize}
              >
                <Clapperboard className="w-3 h-3" />
                立即优化
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
