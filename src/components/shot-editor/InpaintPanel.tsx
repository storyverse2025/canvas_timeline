import { useRef, useState, useEffect } from 'react'
import { Loader2, Paintbrush, Eraser } from 'lucide-react'
import { toast } from 'sonner'
import { runCapability } from '@/lib/capabilities/client'
import { useStoryboardStore } from '@/stores/storyboard-store'

interface Props { rowId: string; imageUrl: string }

export function InpaintPanel({ rowId, imageUrl }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [brushSize, setBrushSize] = useState(20)
  const [painting, setPainting] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const updateRow = useStoryboardStore((s) => s.updateRow)

  // Initialize canvas with the image
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageUrl) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      canvas.width = img.width
      canvas.height = img.height
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    img.src = imageUrl
  }, [imageUrl])

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!painting) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = getPos(e)
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)'
    ctx.beginPath()
    ctx.arc(x, y, brushSize, 0, Math.PI * 2)
    ctx.fill()
  }

  const clearMask = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  const handleInpaint = async () => {
    const canvas = canvasRef.current
    if (!canvas || !imageUrl) return
    setRunning(true)
    try {
      const maskDataUrl = canvas.toDataURL('image/png')
      const r = await runCapability({
        capability: 'inpaint',
        inputs: [
          { kind: 'text', text: prompt.trim() || 'fill naturally' },
          { kind: 'image', url: imageUrl },
        ],
        params: { mask_url: maskDataUrl },
      })
      const url = r.outputs[0]?.url
      if (url) {
        setResultUrl(url)
        toast.success('标记修图完成')
      }
    } catch (e) {
      toast.error('标记修图失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setRunning(false)
    }
  }

  const applyResult = () => {
    if (!resultUrl) return
    updateRow(rowId, { keyframeUrl: resultUrl, reference_image: resultUrl })
    setResultUrl(null)
    toast.success('已应用到分镜')
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[10px] text-muted-foreground uppercase">在图片上涂画要修改的区域</label>

      <div className="relative border border-border rounded overflow-hidden bg-black">
        {imageUrl && <img src={imageUrl} alt="" className="w-full" />}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          onMouseDown={() => setPainting(true)}
          onMouseUp={() => setPainting(false)}
          onMouseLeave={() => setPainting(false)}
          onMouseMove={draw}
        />
      </div>

      <div className="flex items-center gap-2">
        <label className="text-[10px] text-muted-foreground">笔刷</label>
        <input type="range" min="5" max="50" value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="flex-1" />
        <span className="text-[10px] w-6 text-right">{brushSize}</span>
        <button className="p-1 rounded hover:bg-accent" onClick={clearMask} title="清除标记">
          <Eraser className="w-3.5 h-3.5" />
        </button>
      </div>

      <textarea
        className="w-full min-h-[50px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="描述要填充的内容（可选）"
      />

      <button
        className="w-full py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 inline-flex items-center justify-center gap-1.5"
        disabled={running || !imageUrl}
        onClick={handleInpaint}
      >
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Paintbrush className="w-3 h-3" />}
        标记修图
      </button>

      {resultUrl && (
        <div className="mt-2 space-y-2">
          <img src={resultUrl} alt="result" className="w-full rounded border border-border" />
          <button className="w-full py-1.5 text-xs rounded bg-emerald-600 text-white hover:opacity-90" onClick={applyResult}>
            应用到分镜
          </button>
        </div>
      )}
    </div>
  )
}
