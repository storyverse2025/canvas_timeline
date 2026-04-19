import { useState } from 'react'
import { Loader2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { runCapability } from '@/lib/capabilities/client'
import { applyEditResult } from './apply-edit-result'

interface Props { rowId: string; imageUrl: string }

export function DialogEditPanel({ rowId, imageUrl }: Props) {
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)

  const handleEdit = async () => {
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

  const handleApply = () => {
    if (!resultUrl) return
    applyEditResult(rowId, resultUrl, '修图')
    setResultUrl(null)
    setPrompt('')
    toast.success('已应用到分镜 + 画布已添加节点')
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[10px] text-muted-foreground uppercase">描述修改内容</label>
      <textarea
        className="w-full min-h-[80px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="例: 把背景改为夜晚，加上月光"
      />
      <button
        className="w-full py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
        disabled={running || !prompt.trim() || !imageUrl}
        onClick={handleEdit}
      >
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
        AI 修图
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
