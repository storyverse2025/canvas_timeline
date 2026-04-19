import { useRef, useState } from 'react'
import { X, Upload, Clapperboard, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'
import { useProjectDB } from '@/stores/project-db'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useViewStore } from '@/stores/view-store'
import { runDirectorPipeline, type PipelineState } from '@/lib/director-assistant'
import { parseAndValidateStoryboard } from '@/lib/storyboard-parser'
import { ArtDirectionPanel } from './ArtDirectionPanel'
import { DirectorPipelineProgress } from './DirectorPipelineProgress'

interface Props {
  onClose: () => void
}

export function ScriptInputDialog({ onClose }: Props) {
  const script = useProjectDB((s) => s.script)
  const updateScript = useProjectDB((s) => s.updateScript)
  const [text, setText] = useState(script.text)
  const [showArt, setShowArt] = useState(false)
  const [running, setRunning] = useState(false)
  const [pipelineState, setPipelineState] = useState<PipelineState | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
    setRunning(true)
    updateScript({ text: text.trim() })

    try {
      const { state, storyboardJson } = await runDirectorPipeline((s) => {
        setPipelineState({ ...s })
      })
      setPipelineState(state)

      // Parse and apply storyboard
      const result = parseAndValidateStoryboard(storyboardJson)
      if (result.ok && result.rows) {
        useStoryboardStore.getState().replaceAll(result.rows)
        updateScript({ optimizedText: storyboardJson })
        toast.success(`分镜表已生成：${result.rows.length} 行`)
        // Switch to table view after a short delay
        setTimeout(() => {
          useViewStore.getState().setActiveTab('table')
        }, 1500)
      } else {
        toast.error('分镜 JSON 解析失败', {
          description: (result.errors ?? []).slice(0, 3).join('; '),
        })
      }
    } catch (e) {
      toast.error('导演助手失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[600px] max-w-full max-h-[90vh] bg-card border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
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
          {!running && (
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
                  className="w-full min-h-[200px] text-xs bg-background border border-border rounded px-3 py-2 outline-none resize-y"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="在此输入或粘贴剧本内容…&#10;&#10;例：&#10;第一幕：黎明时分，山间小屋。&#10;主角醒来，发现窗外下着大雪…"
                  autoFocus
                />
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

          {/* Pipeline progress */}
          {pipelineState && <DirectorPipelineProgress state={pipelineState} />}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>
            {running ? '关闭' : '取消'}
          </button>
          {!running && (
            <button
              className="px-4 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1.5"
              disabled={!text.trim()}
              onClick={handleOptimize}
            >
              <Clapperboard className="w-3 h-3" />
              立即优化
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
