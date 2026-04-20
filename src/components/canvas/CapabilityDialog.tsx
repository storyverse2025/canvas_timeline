import { useRef, useState } from 'react'
import { X, Sparkles, Loader2, Plus, FolderOpen, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { useCapabilityDialogStore } from '@/stores/capability-dialog-store'
import { useCapability } from '@/hooks/useCapability'
import { optimizePrompt } from '@/lib/providers/client'
import { AssetPickerDialog } from './AssetPickerDialog'
import type { CapabilityParam } from '@/lib/capabilities/types'
import { cn } from '@/lib/utils'

export function CapabilityDialogMount() {
  const state = useCapabilityDialogStore((s) => s.state)
  const close = useCapabilityDialogStore((s) => s.close)
  if (!state) return null
  return <CapabilityDialog key={state.nodeId + state.capability.id} state={state} onClose={close} />
}

function CapabilityDialog({ state, onClose }: {
  state: NonNullable<ReturnType<typeof useCapabilityDialogStore.getState>['state']>
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState(state.prompt)
  const [params, setParams] = useState<Record<string, unknown>>(() => {
    const defaults: Record<string, unknown> = {}
    for (const p of state.capability.params ?? []) {
      if (p.default != null) defaults[p.key] = String(p.default)
      else if (p.options?.length) defaults[p.key] = p.options[0].value
    }
    return defaults
  })
  const [refImages, setRefImages] = useState<string[]>(state.refImages)
  const [running, setRunning] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const runCap = useCapability()

  const cap = state.capability
  const hasPrompt = cap.inputKinds.includes('text')
  const isUniversalVideo = cap.id === 'universal-video'
  const isVideo = cap.outputKind === 'video'

  const setParam = (key: string, val: string) => {
    setParams((prev) => ({ ...prev, [key]: val }))
  }

  const addRefFileRef = useRef<HTMLInputElement>(null)
  const removeRefImage = (idx: number) => {
    setRefImages((prev) => prev.filter((_, i) => i !== idx))
  }
  const addRefFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    const reader = new FileReader()
    reader.onload = async () => {
      if (typeof reader.result !== 'string') return
      // Upload to server to get a URL (avoids localStorage bloat)
      try {
        const res = await fetch('/uploads/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: reader.result, filename: f.name }),
        })
        const data = await res.json() as { url?: string }
        if (data.url) setRefImages((prev) => [...prev, data.url!])
      } catch {
        // Fallback: use data URL directly
        setRefImages((prev) => [...prev, reader.result as string])
      }
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  const handlePickAssets = (urls: string[]) => {
    setRefImages((prev) => Array.from(new Set([...prev, ...urls])))
  }

  const handleOptimize = async () => {
    if (optimizing) return
    setOptimizing(true)
    try {
      const mode = isUniversalVideo && refImages.length > 0 ? 'seedance-universal' : 'default'
      const r = await optimizePrompt({
        prompt: prompt.trim() || cap.label,
        kind: isVideo ? 'video' : 'image',
        aspect: (params.aspect as string) ?? '16:9',
        duration: params.duration ? Number(params.duration) : undefined,
        mode,
        refImages: mode === 'seedance-universal' ? refImages : undefined,
      })
      setPrompt(r.prompt)
      toast.success('Prompt 已优化')
    } catch (e) {
      toast.error('优化失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setOptimizing(false)
    }
  }

  const handleSubmit = async () => {
    setRunning(true)
    try {
      const extraInputs: { kind: 'text' | 'image'; text?: string; url?: string }[] = []
      if (prompt.trim()) extraInputs.push({ kind: 'text', text: prompt.trim() })
      for (const u of refImages) extraInputs.push({ kind: 'image', url: u })
      await runCap({
        capabilityId: cap.id,
        nodeId: state.nodeId,
        itemId: state.itemId,
        params,
        extraInputs,
      })
      onClose()
    } catch (e) {
      toast.error('执行失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[520px] max-w-full max-h-[85vh] bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3 overflow-auto"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            {cap.label}
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        <p className="text-xs text-muted-foreground">{cap.description}</p>

        {hasPrompt && (
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] text-muted-foreground uppercase">Prompt / 输入文本</label>
              <button
                className="text-[10px] px-2 py-0.5 rounded border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-40 inline-flex items-center gap-1"
                onClick={handleOptimize}
                disabled={optimizing}
                title={isUniversalVideo ? '生成 Seedance 2.0 @图片N 格式的 prompt' : '用 Gemini 优化 prompt'}
              >
                {optimizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                AI 优化
              </button>
            </div>
            <textarea
              className="w-full mt-1 min-h-[80px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={isUniversalVideo ? '例: 参考@图片1的角色和@图片2的场景，缓慢推镜...' : '描述要执行的操作…'}
              autoFocus
            />
            {isUniversalVideo && (
              <p className="text-[10px] text-muted-foreground mt-1">
                💡 多图参考时用 @图片1 / @图片2 明确指定每张图的用途。点击"AI 优化"自动生成。
              </p>
            )}
          </div>
        )}

        {(cap.params?.length ?? 0) > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {cap.params!.map((p) => (
              <ParamField key={p.key} param={p} value={params[p.key]} onChange={(v) => setParam(p.key, v)} />
            ))}
          </div>
        )}

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">参考图 ({refImages.length})</label>
          <div className="flex gap-1.5 overflow-x-auto pb-1 mt-1">
            {refImages.map((u, i) => (
              <div key={i} className="relative shrink-0 group">
                <img src={u} alt="" className="h-14 w-14 object-cover rounded border border-border" />
                <button
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => removeRefImage(i)}
                  title="移除"
                >×</button>
                <div className="absolute bottom-0 left-0 right-0 text-[8px] text-center bg-black/60 text-white py-0.5">
                  图{i + 1}
                </div>
              </div>
            ))}
            <button
              className="shrink-0 h-14 w-14 rounded border border-dashed border-border flex flex-col items-center justify-center hover:bg-accent/30"
              onClick={() => setPickerOpen(true)}
              title="从画布资产选择"
            >
              <FolderOpen className="w-4 h-4 text-muted-foreground" />
              <span className="text-[8px] text-muted-foreground">画布</span>
            </button>
            <button
              className="shrink-0 h-14 w-14 rounded border border-dashed border-border flex flex-col items-center justify-center hover:bg-accent/30"
              onClick={() => addRefFileRef.current?.click()}
              title="上传本地图片"
            >
              <Plus className="w-4 h-4 text-muted-foreground" />
              <span className="text-[8px] text-muted-foreground">上传</span>
            </button>
            <input ref={addRefFileRef} type="file" accept="image/*" className="hidden" onChange={addRefFromFile} />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>
            取消
          </button>
          <button
            className={cn('px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40')}
            disabled={running}
            onClick={handleSubmit}
          >
            {running ? <Loader2 className="inline w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="inline w-3 h-3 mr-1" />}
            执行
          </button>
        </div>
      </div>
    </div>
    {pickerOpen && <AssetPickerDialog onClose={() => setPickerOpen(false)} onSelect={handlePickAssets} />}
    </>
  )
}

function ParamField({ param, value, onChange }: { param: CapabilityParam; value: unknown; onChange: (v: string) => void }) {
  if (param.type === 'select' && param.options) {
    return (
      <div>
        <label className="text-[10px] text-muted-foreground uppercase">{param.label}</label>
        <select
          className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {param.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    )
  }
  if (param.type === 'number') {
    return (
      <div>
        <label className="text-[10px] text-muted-foreground uppercase">{param.label}</label>
        <input
          type="number"
          className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
          value={String(value ?? param.default ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  }
  return (
    <div>
      <label className="text-[10px] text-muted-foreground uppercase">{param.label}</label>
      <input
        type="text"
        className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        placeholder={param.label}
      />
    </div>
  )
}
