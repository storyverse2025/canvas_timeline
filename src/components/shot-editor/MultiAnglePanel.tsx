import { useState } from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { runCapability } from '@/lib/capabilities/client'
import { applyEditResult } from './apply-edit-result'
import { cn } from '@/lib/utils'

const ANGLES = [
  { value: 'front', label: '正面' },
  { value: 'side', label: '侧面' },
  { value: 'back', label: '背面' },
  { value: 'top', label: '俯视' },
  { value: 'low', label: '仰视' },
  { value: 'bird', label: '鸟瞰' },
]

interface Props { rowId: string; imageUrl: string }

export function MultiAnglePanel({ rowId, imageUrl }: Props) {
  const [angle, setAngle] = useState('side')
  const [running, setRunning] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  const handleGenerate = async () => {
    if (!imageUrl) return
    setRunning(true)
    try {
      const r = await runCapability({
        capability: 'multi-angle',
        inputs: [{ kind: 'image', url: imageUrl }],
        params: { angle },
      })
      const url = r.outputs[0]?.url
      if (url) {
        setResultUrl(url)
        toast.success('多角度生成完成')
      }
    } catch (e) {
      toast.error('多角度失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setRunning(false)
    }
  }

  const handleApply = () => {
    if (!resultUrl) return
    applyEditResult(rowId, resultUrl, '多角度')
    setResultUrl(null)
    toast.success('已应用到分镜 + 画布已添加节点')
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[10px] text-muted-foreground uppercase">选择角度</label>
      <div className="grid grid-cols-3 gap-1">
        {ANGLES.map((a) => (
          <button
            key={a.value}
            className={cn(
              'text-[10px] py-1.5 rounded border transition-colors',
              angle === a.value ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setAngle(a.value)}
          >
            {a.label}
          </button>
        ))}
      </div>

      <button
        className="w-full py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
        disabled={running || !imageUrl}
        onClick={handleGenerate}
      >
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
        生成 {ANGLES.find((a) => a.value === angle)?.label}
      </button>

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
