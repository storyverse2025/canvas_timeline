import { useState } from 'react'
import { Image as ImageIcon, Film, Download } from 'lucide-react'
import { useBatchGenerate } from '@/hooks/useBatchGenerate'
import { BatchProgressOverlay } from './BatchProgressOverlay'
import { ExportDialog } from './ExportDialog'

export function BatchToolbar() {
  const { batch, startBatch, cancelBatch } = useBatchGenerate()
  const [exportOpen, setExportOpen] = useState(false)

  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-40"
          onClick={() => startBatch('keyframe')}
          disabled={batch?.isRunning}
          title="批量生成所有分镜的 Keyframe 图片"
        >
          <ImageIcon className="w-3 h-3" />
          批量 KF
        </button>
        <button
          className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-40"
          onClick={() => startBatch('beat-video')}
          disabled={batch?.isRunning}
          title="批量生成所有分镜的 Beat Video"
        >
          <Film className="w-3 h-3" />
          批量 Video
        </button>
        <button
          className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          onClick={() => setExportOpen(true)}
          title="导出素材为 ZIP"
        >
          <Download className="w-3 h-3" />
          导出
        </button>
      </div>

      {batch && <BatchProgressOverlay batch={batch} onClose={cancelBatch} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </>
  )
}
