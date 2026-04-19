import { useMemo } from 'react'
import { useProjectDB } from '@/stores/project-db'
import { Image as ImageIcon, Video, FileText, Music } from 'lucide-react'

const KIND_ICONS: Record<string, React.ElementType> = {
  image: ImageIcon, video: Video, text: FileText, audio: Music,
}

export function GenerationHistoryTab() {
  const history = useProjectDB((s) => s.generationHistory)

  const entries = useMemo(() =>
    Object.values(history).sort((a, b) => b.createdAt - a.createdAt),
    [history],
  )

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-4 text-center">
        暂无生成历史<br />使用 AI 能力生成内容后会记录在此
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-2">
      <div className="flex flex-col gap-1.5">
        {entries.map((h) => {
          const Icon = KIND_ICONS[h.resultKind] ?? FileText
          const isMedia = h.resultKind === 'image' || h.resultKind === 'video'
          return (
            <div key={h.id} className="flex gap-2 p-1.5 rounded border border-border bg-card hover:bg-accent/30 transition-colors">
              <div className="w-12 h-12 rounded bg-muted flex items-center justify-center overflow-hidden shrink-0">
                {isMedia && h.resultUrl ? (
                  <img src={h.resultUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Icon className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-medium truncate">{h.capability}</div>
                <div className="text-[9px] text-muted-foreground truncate">{h.prompt || '(no prompt)'}</div>
                <div className="text-[9px] text-muted-foreground mt-0.5">
                  {new Date(h.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {h.status === 'failed' && <span className="text-destructive ml-1">失败</span>}
                  {h.status === 'running' && <span className="text-amber-400 ml-1">进行中</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
