import { useEffect, useRef, useState } from 'react'
import { X, FlaskConical } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectDB } from '@/stores/project-db'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useViewStore } from '@/stores/view-store'
import { useChatStore } from '@/stores/chat-store'
import { runDirectorPipeline, type PipelineState } from '@/lib/director-assistant'
import { parseAndValidateStoryboard } from '@/lib/storyboard-parser'
import { mergeSameSceneRows } from '@/lib/storyboard-merge'
import { validateGenreStructure } from '@/lib/benchmarks/structure-gates'
import { buildGenreCaseScript, type GenreCase } from '@/lib/benchmarks/genre-cases'
import { DirectorPipelineProgress } from './DirectorPipelineProgress'
import { InterviewCard } from '@/components/chat/InterviewCard'

interface Props {
  genreCase: GenreCase
  onClose: () => void
}

/**
 * 一键跑 30 秒题材基准用例：种子化剧本/风格 → runDirectorPipeline →
 * 分镜表落库 → 结果性结构门槛自检。关键帧/视频生成沿用分镜表页的
 * 现有流程。这是 S+ 漫剧能力回归的 Tier 2 入口（真实 LLM，花钱）。
 */
export function GenreCaseRunnerDialog({ genreCase, onClose }: Props) {
  const [phase, setPhase] = useState<'running' | 'done' | 'error'>('running')
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null)
  const [gateIssues, setGateIssues] = useState<string[]>([])
  const pendingQuestion = useChatStore((s) => s.pendingQuestion)
  const answerQuestion = useChatStore((s) => s.answerQuestion)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const run = async () => {
      const { updateScript, updateArtDirection } = useProjectDB.getState()
      updateScript({
        text: buildGenreCaseScript(genreCase),
        totalDurationSeconds: genreCase.totalDurationSeconds,
      })
      updateArtDirection({
        stylePreset: genreCase.stylePreset,
        defaultAspectRatio: genreCase.aspectRatio,
      })

      try {
        const { state, storyboardJson } = await runDirectorPipeline((s) => {
          setPipelineState({ ...s })
        })
        setPipelineState(state)

        const result = parseAndValidateStoryboard(storyboardJson)
        if (!result.ok || !result.rows) {
          toast.error('分镜 JSON 解析失败', {
            description: (result.errors ?? []).slice(0, 3).join('; '),
          })
          setPhase('error')
          return
        }
        const merged = mergeSameSceneRows(result.rows)
        useStoryboardStore.getState().replaceAll(merged.rows)
        useProjectDB.getState().updateScript({ optimizedText: storyboardJson })

        const gate = validateGenreStructure(merged.rows, genreCase)
        setGateIssues(gate.issues)
        if (gate.ok) {
          toast.success(`基准用例「${genreCase.title}」分镜表已生成：${merged.rows.length} 行，结构门槛全部通过`)
        } else {
          toast.warning(`「${genreCase.title}」分镜表已生成，但 ${gate.issues.length} 项结构门槛未过`, {
            description: gate.issues[0],
          })
        }
        setPhase('done')
      } catch (e) {
        toast.error('导演助手失败', { description: String((e as Error).message).slice(0, 200) })
        setPhase('error')
      }
    }
    void run()
  }, [genreCase])

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[600px] max-w-full max-h-[80vh] bg-card border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FlaskConical className="w-4 h-4 text-primary" />
            基准用例 — {genreCase.title}（{genreCase.genre} · 30s · Weta 3D CG）
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          {phase === 'running' && pendingQuestion && (
            <InterviewCard
              question={pendingQuestion.question}
              askedBy={pendingQuestion.agentLabel}
              onSubmit={(answer) => answerQuestion(pendingQuestion.id, answer)}
            />
          )}

          {pipelineState && <DirectorPipelineProgress state={pipelineState} />}

          {phase === 'done' && gateIssues.length > 0 && (
            <div className="text-xs border border-amber-500/40 bg-amber-500/10 rounded p-3">
              <div className="font-medium mb-1">结构门槛未通过项（改进 director agent 的 backlog）：</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {gateIssues.map((issue, i) => <li key={i}>{issue}</li>)}
              </ul>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          {phase === 'done' ? (
            <button
              className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90"
              onClick={() => { useViewStore.getState().setActiveTab('table'); onClose() }}
            >
              查看分镜表 → 继续生成关键帧/视频
            </button>
          ) : phase === 'error' ? (
            <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>关闭</button>
          ) : (
            <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>后台运行</button>
          )}
        </div>
      </div>
    </div>
  )
}
