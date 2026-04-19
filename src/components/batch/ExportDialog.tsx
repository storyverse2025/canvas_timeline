import { useState } from 'react'
import { X, Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { collectExportItems, exportAsZip } from '@/lib/batch-export'

interface Props {
  onClose: () => void
}

export function ExportDialog({ onClose }: Props) {
  const rows = useStoryboardStore((s) => s.rows)
  const [includeKf, setIncludeKf] = useState(true)
  const [includeVid, setIncludeVid] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })

  const items = collectExportItems(rows, includeKf, includeVid)

  const handleExport = async () => {
    if (items.length === 0) { toast.error('没有可导出的内容'); return }
    setExporting(true)
    try {
      await exportAsZip(items, (done, total) => setProgress({ done, total }))
      toast.success(`已导出 ${items.length} 个文件`)
      onClose()
    } catch (e) {
      toast.error('导出失败', { description: String((e as Error).message) })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="w-[400px] bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">导出素材</span>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={includeKf} onChange={(e) => setIncludeKf(e.target.checked)} className="rounded" />
            Keyframe 图片 ({rows.filter((r) => r.keyframeUrl || r.reference_image).length} 张)
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={includeVid} onChange={(e) => setIncludeVid(e.target.checked)} className="rounded" />
            Beat Video 视频 ({rows.filter((r) => r.beatVideoUrl).length} 个)
          </label>
        </div>

        <div className="text-xs text-muted-foreground">
          共 {items.length} 个文件将打包为 ZIP 下载
        </div>

        {exporting && (
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>正在打包 {progress.done}/{progress.total}…</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>取消</button>
          <button
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1.5"
            disabled={items.length === 0 || exporting}
            onClick={handleExport}
          >
            <Download className="w-3 h-3" />
            导出 ZIP
          </button>
        </div>
      </div>
    </div>
  )
}
