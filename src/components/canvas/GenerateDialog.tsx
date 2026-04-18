import { useEffect, useState } from 'react'
import { X, Sparkles, Image as ImageIcon, Video, Link2, Wand2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { PROVIDERS } from '@/lib/providers/registry'
import { fetchAvailability, optimizePrompt, type ProviderAvailability } from '@/lib/providers/client'
import type { ProviderId, MediaKind } from '@/lib/providers/types'
import { cn } from '@/lib/utils'

export interface GenerateDialogResult {
  provider: ProviderId;
  model: string;
  prompt: string;
  kind: MediaKind;
  aspect: string;
  duration: number;
}

interface Props {
  initialPrompt?: string;
  upstreamImages?: string[];
  defaultKind?: MediaKind;
  onCancel: () => void;
  onSubmit: (r: GenerateDialogResult) => void;
}

const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

export function GenerateDialog({ initialPrompt = '', upstreamImages = [], defaultKind = 'image', onCancel, onSubmit }: Props) {
  const [avail, setAvail] = useState<ProviderAvailability | null>(null)
  const [kind, setKind] = useState<MediaKind>(defaultKind)
  const [provider, setProvider] = useState<ProviderId>('doubao')
  const [model, setModel] = useState<string>('')
  const [prompt, setPrompt] = useState(initialPrompt)
  const [aspect, setAspect] = useState('16:9')
  const [duration, setDuration] = useState(5)
  const [optimizing, setOptimizing] = useState(false)

  const runOptimize = async () => {
    if (!prompt.trim() || optimizing) return
    setOptimizing(true)
    try {
      const r = await optimizePrompt({ prompt: prompt.trim(), kind, aspect, duration })
      setPrompt(r.prompt)
      toast.success('Prompt 已优化')
    } catch (e) {
      toast.error('优化失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setOptimizing(false)
    }
  }

  useEffect(() => { fetchAvailability().then(setAvail).catch(() => setAvail({} as ProviderAvailability)) }, [])

  // Pick first enabled provider and a model matching kind
  useEffect(() => {
    if (!avail) return
    const enabledProviders = PROVIDERS.filter((p) => avail[p.id] && p.models.some((m) => m.kind === kind))
    if (enabledProviders.length === 0) return

    // Preferred defaults: video → doubao, image → libtv (generation that worked before)
    let preferred: ProviderId | undefined
    if (kind === 'video') preferred = 'doubao'
    else if (kind === 'image') preferred = 'libtv'
    const next = (preferred && enabledProviders.find((p) => p.id === preferred)) ?? enabledProviders[0]
    setProvider(next.id)

    const models = next.models.filter((m) => m.kind === kind)
    const defaultM = models.find((m) => /默认|default/i.test(m.label)) ?? models[0]
    setModel(defaultM?.id ?? '')
  }, [avail, kind])

  const models = (PROVIDERS.find((p) => p.id === provider)?.models ?? []).filter((m) => m.kind === kind)

  const disabled = !prompt.trim() || !provider || !model

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onCancel}>
      <div
        className="w-[520px] max-w-full bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" /> AI 生成
          </div>
          <button onClick={onCancel} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-2">
          {(['image', 'video'] as MediaKind[]).map((k) => (
            <button
              key={k}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border',
                kind === k ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setKind(k)}
            >
              {k === 'image' ? <ImageIcon className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
              {k === 'image' ? '图片' : '视频'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">Provider</label>
            <select
              className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderId)}
            >
              {PROVIDERS.filter((p) => p.models.some((m) => m.kind === kind)).map((p) => (
                <option key={p.id} value={p.id} disabled={avail ? !avail[p.id] : false}>
                  {p.label}{avail && !avail[p.id] ? ' (no key)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">Model</label>
            <select
              className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className="text-[10px] text-muted-foreground uppercase">Prompt</label>
            <button
              className="text-[10px] px-2 py-0.5 rounded border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-40 inline-flex items-center gap-1"
              onClick={runOptimize}
              disabled={optimizing || !prompt.trim()}
              title="用 Gemini 加入镜头语言、时长、构图等"
            >
              {optimizing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
              AI 优化
            </button>
          </div>
          <textarea
            className="w-full mt-1 min-h-[120px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述要生成的内容…"
            autoFocus
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-muted-foreground uppercase">比例</label>
            <select
              className="text-xs bg-background border border-border rounded px-2 py-1 outline-none"
              value={aspect}
              onChange={(e) => setAspect(e.target.value)}
            >
              {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          {kind === 'video' && (
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-muted-foreground uppercase">时长(秒)</label>
              <select
                className="text-xs bg-background border border-border rounded px-2 py-1 outline-none"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {[5, 10].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}
          {upstreamImages.length > 0 && (
            <div className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Link2 className="w-3 h-3" /> 已连入 {upstreamImages.length} 张参考图
            </div>
          )}
        </div>

        {upstreamImages.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {upstreamImages.map((u, i) => (
              <img
                key={i}
                src={u}
                alt=""
                className="h-14 w-14 object-cover rounded border border-border shrink-0"
                title={u}
              />
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onCancel}>取消</button>
          <button
            className={cn('px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40')}
            disabled={disabled}
            onClick={() => onSubmit({ provider, model, prompt: prompt.trim(), kind, aspect, duration })}
          >
            <Sparkles className="inline w-3 h-3 mr-1" />
            生成
          </button>
        </div>
      </div>
    </div>
  )
}
