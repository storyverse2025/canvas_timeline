import { useState } from 'react'
import { X, Sparkles, Image as ImageIcon, Type as TypeIcon } from 'lucide-react'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useGenerateDialogStore } from '@/stores/generate-dialog-store'
import { gatherUpstream } from '@/lib/canvas-graph'

interface Props {
  nodeId: string;
  itemId: string;
  onClose: () => void;
}

export function NodeEditPanel({ nodeId, itemId, onClose }: Props) {
  const item = useCanvasItemStore((s) => s.items[itemId])
  const updateItem = useCanvasItemStore((s) => s.updateItem)
  const openDialog = useGenerateDialogStore((s) => s.open)

  const [name, setName] = useState(item?.name ?? '')
  const [prompt, setPrompt] = useState(item?.prompt ?? '')
  const [content, setContent] = useState(item?.content ?? '')

  if (!item) return null

  const live = gatherUpstream(nodeId)
  const storedRefs = item.refImages ?? []

  const commit = () => {
    updateItem(itemId, {
      name: name.trim() || item.name,
      prompt: prompt.trim(),
      ...(item.kind === 'text' ? { content } : {}),
    })
    onClose()
  }

  const regenerate = () => {
    updateItem(itemId, { name: name.trim() || item.name, prompt: prompt.trim() })
    openDialog({
      nodeId,
      itemId,
      prompt: prompt.trim() || name || '',
      upstreamImages: live.images,
      defaultKind: item.kind === 'image' ? 'image' : 'image',
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[560px] max-w-full bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium flex items-center gap-2">
            {item.kind === 'image' ? <ImageIcon className="w-4 h-4" /> : <TypeIcon className="w-4 h-4" />}
            编辑节点 · {item.kind === 'image' ? '图片/视频' : '文本'}
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">名称</label>
          <input
            className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {item.kind === 'text' ? (
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">文本内容</label>
            <textarea
              className="w-full mt-1 min-h-[120px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">当前内容 URL</label>
            <div className="mt-1 flex gap-2">
              <input
                className="flex-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none font-mono"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="图片或视频 URL"
              />
            </div>
            {content && (
              <div className="mt-2 rounded border border-border overflow-hidden max-h-[180px] flex items-center justify-center bg-black/40">
                {/\.(mp4|webm|mov)(\?|$)/i.test(content)
                  ? <video src={content} className="max-h-[180px]" controls />
                  : <img src={content} alt="" className="max-h-[180px] object-contain" />}
              </div>
            )}
          </div>
        )}

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">
            生成 Prompt {item.provider && <span className="ml-1 opacity-60">· {item.provider}/{item.model}</span>}
          </label>
          <textarea
            className="w-full mt-1 min-h-[80px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="(从未生成过 / 未记录)"
          />
        </div>

        {(storedRefs.length > 0 || live.images.length > 0) && (
          <div className="space-y-2">
            {storedRefs.length > 0 && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase mb-1">生成时使用的参考图 ({storedRefs.length})</div>
                <div className="flex gap-1.5 overflow-x-auto">
                  {storedRefs.map((u, i) => (
                    <img key={`s${i}`} src={u} alt="" className="h-16 w-16 object-cover rounded border border-border shrink-0" title={u} />
                  ))}
                </div>
              </div>
            )}
            {live.images.length > 0 && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase mb-1">上游当前连入 ({live.images.length})</div>
                <div className="flex gap-1.5 overflow-x-auto">
                  {live.images.map((u, i) => (
                    <img key={`l${i}`} src={u} alt="" className="h-16 w-16 object-cover rounded border border-primary/50 shrink-0" title={u} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-between gap-2 pt-1">
          <button
            className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent inline-flex items-center gap-1"
            onClick={regenerate}
          >
            <Sparkles className="w-3 h-3" /> 用 Prompt 重新生成
          </button>
          <div className="flex gap-2">
            <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>取消</button>
            <button className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90" onClick={commit}>保存</button>
          </div>
        </div>
      </div>
    </div>
  )
}
