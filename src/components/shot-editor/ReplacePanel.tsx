import { useRef } from 'react'
import { Upload } from 'lucide-react'
import { toast } from 'sonner'
import { useStoryboardStore } from '@/stores/storyboard-store'

interface Props { rowId: string }

export function ReplacePanel({ rowId }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const updateRow = useStoryboardStore((s) => s.updateRow)

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    e.target.value = ''

    try {
      // Upload to server
      const reader = new FileReader()
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(f)
      })

      const res = await fetch('/uploads/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, filename: f.name }),
      })
      const data = await res.json() as { url?: string }
      if (!data.url) throw new Error('upload failed')

      updateRow(rowId, { keyframeUrl: data.url, reference_image: data.url })
      toast.success(`已替换为 ${f.name}`)
    } catch (err) {
      toast.error('上传失败', { description: String((err as Error).message) })
    }
  }

  const handleUrl = () => {
    const url = window.prompt('输入图片 URL')
    if (url?.trim()) {
      updateRow(rowId, { keyframeUrl: url.trim(), reference_image: url.trim() })
      toast.success('已替换')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-[10px] text-muted-foreground uppercase">替换分镜图片</label>

      <button
        className="w-full py-3 text-xs rounded border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors inline-flex items-center justify-center gap-1.5"
        onClick={() => fileRef.current?.click()}
      >
        <Upload className="w-4 h-4" />
        上传本地图片
      </button>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />

      <button
        className="w-full py-1.5 text-xs rounded border border-border hover:bg-accent"
        onClick={handleUrl}
      >
        输入图片 URL
      </button>
    </div>
  )
}
