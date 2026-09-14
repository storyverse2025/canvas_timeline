import { useCallback, useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useTimelineStore } from '@/stores/timeline-store'
import {
  downloadBlob,
  exportMergedVideo,
  exportMergedVideoServerSide,
  type ExportProgress,
} from '@/lib/timeline-export'

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export function TimelineExportButton() {
  const rows = useStoryboardStore((s) => s.rows)
  const setIsPlaying = useTimelineStore((s) => s.setIsPlaying)

  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [useServer, setUseServer] = useState(true)  // default to server-side (faster + correct CFR)
  const abortRef = useRef<AbortController | null>(null)

  const totalShots = rows.length
  const totalSec = rows.reduce((s, r) => s + Math.max(0.1, Number(r.duration) || 1), 0)
  const disabled = totalShots === 0

  const handleStart = useCallback(async () => {
    if (disabled || running) return
    setIsPlaying(false)
    setRunning(true)
    setProgress({ shotIndex: 0, totalShots, elapsedSec: 0, totalSec, phase: 'preparing' })
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const exporter = useServer ? exportMergedVideoServerSide : exportMergedVideo
      const result = await exporter({
        signal: ctrl.signal,
        onProgress: (p) => setProgress(p),
      })
      const filename = `timeline-export-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${result.ext}`
      downloadBlob(result.blob, filename)
      toast.success(`已合拼 ${totalShots} 个分镜`, {
        description: `${filename} · ${(result.blob.size / 1024 / 1024).toFixed(1)} MB`,
      })
      setOpen(false)
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') {
        toast.info('已取消导出')
      } else {
        toast.error('导出失败', { description: err.message.slice(0, 200) })
      }
    } finally {
      setRunning(false)
      abortRef.current = null
      setProgress(null)
    }
  }, [disabled, running, setIsPlaying, totalSec, totalShots])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleOpenChange = useCallback((v: boolean) => {
    if (!v && running) return // block close while recording
    setOpen(v)
  }, [running])

  const percent = progress && progress.totalSec > 0
    ? Math.min(100, (progress.elapsedSec / progress.totalSec) * 100)
    : 0

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={disabled}
            onClick={() => setOpen(true)}
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {disabled ? '时间轴为空' : '导出合拼视频'}
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md" onPointerDownOutside={(e) => running && e.preventDefault()} onEscapeKeyDown={(e) => running && e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>导出合拼视频</DialogTitle>
            <DialogDescription>
              {running
                ? (useServer
                   ? '服务器端 ffmpeg 拼合中…通常 10-50× 比浏览器实时录屏快，输出标准 CFR MP4。'
                   : '浏览器实时录屏拼合中（耗时 ≈ 时间轴总时长）。')
                : `将 ${totalShots} 个分镜（${fmtTime(totalSec)}）合拼为一段视频下载。`}
            </DialogDescription>
          </DialogHeader>

          {!running && (
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={useServer} onChange={(e) => setUseServer(e.target.checked)} />
                <span>服务器端 ffmpeg 拼合（推荐）</span>
              </label>
              <span className="text-muted-foreground">
                {useServer ? '10-50× 更快，输出标准 CFR MP4' : '浏览器 MediaRecorder 实时录屏（兼容老 dev 环境）'}
              </span>
            </div>
          )}

          {running && progress && (
            <div className="space-y-2 text-xs">
              <Progress value={percent} />
              <div className="flex justify-between text-muted-foreground">
                <span>
                  {progress.phase === 'preparing' && '准备中…'}
                  {progress.phase === 'recording' && `分镜 ${progress.shotIndex}/${progress.totalShots}${progress.message ? ` · ${progress.message}` : ''}`}
                  {progress.phase === 'finalizing' && '生成文件…'}
                </span>
                <span className="tabular-nums">
                  {fmtTime(progress.elapsedSec)} / {fmtTime(progress.totalSec)}
                </span>
              </div>
            </div>
          )}

          <DialogFooter>
            {running ? (
              <Button variant="outline" size="sm" onClick={handleCancel}>
                取消
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                  关闭
                </Button>
                <Button size="sm" disabled={disabled} onClick={handleStart}>
                  <Download className="w-3.5 h-3.5 mr-1" />
                  开始合拼
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
