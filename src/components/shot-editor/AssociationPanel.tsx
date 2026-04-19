import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { runCapability } from '@/lib/capabilities/client'
import { useStoryboardStore } from '@/stores/storyboard-store'

interface Props { rowId: string; imageUrl: string }

export function AssociationPanel({ rowId, imageUrl }: Props) {
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<string[]>([])
  const updateRow = useStoryboardStore((s) => s.updateRow)

  const handleGenerate = async () => {
    if (!imageUrl) return
    setRunning(true)
    try {
      // Generate 2 variants
      const promises = [0, 1].map(() =>
        runCapability({
          capability: 'shot-association',
          inputs: [
            { kind: 'text', text: prompt.trim() || '生成一个相关的镜头变体' },
            { kind: 'image', url: imageUrl },
          ],
        })
      )
      const responses = await Promise.allSettled(promises)
      const urls = responses
        .filter((r): r is PromiseFulfilledResult<typeof responses[0] extends PromiseSettledResult<infer T> ? T : never> => r.status === 'fulfilled')
        .map((r) => r.value.outputs[0]?.url)
        .filter((u): u is string => !!u)
      setResults(urls)
      if (urls.length > 0) toast.success(`生成 ${urls.length} 个联想分镜`)
    } catch (e) {
      toast.error('联想失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setRunning(false)
    }
  }

  const applyResult = (url: string) => {
    updateRow(rowId, { keyframeUrl: url, reference_image: url })
    toast.success('已应用到分镜')
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[10px] text-muted-foreground uppercase">联想方向（可选）</label>
      <input
        className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="例: 换个更紧张的氛围"
      />
      <button
        className="w-full py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
        disabled={running || !imageUrl}
        onClick={handleGenerate}
      >
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
        分镜联想
      </button>

      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          {results.map((url, i) => (
            <div key={i} className="relative group">
              <img src={url} alt="" className="w-full rounded border border-border" />
              <button
                className="absolute inset-0 flex items-center justify-center bg-black/60 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity rounded"
                onClick={() => applyResult(url)}
              >
                应用
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
