import { useEffect, useRef, useState } from 'react'
import { X, Sparkles, Image as ImageIcon, Video, Link2, Wand2, Loader2, Plus, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react'
import { AssetPickerDialog } from './AssetPickerDialog'
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
  refImages: string[];
  negativePrompt?: string;
  seed?: number;
  guidanceScale?: number;
  resolution?: string;
  generateAudio?: boolean;
  numImages?: number;
}

interface Props {
  initialPrompt?: string;
  upstreamImages?: string[];
  defaultKind?: MediaKind;
  onCancel: () => void;
  onSubmit: (r: GenerateDialogResult) => void;
}

const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
const RESOLUTIONS = ['480p', '720p', '1080p']

export function GenerateDialog({ initialPrompt = '', upstreamImages = [], defaultKind = 'image', onCancel, onSubmit }: Props) {
  const [avail, setAvail] = useState<ProviderAvailability | null>(null)
  const [kind, setKind] = useState<MediaKind>(defaultKind)
  const [refImages, setRefImages] = useState<string[]>(upstreamImages)

  const addRefFileRef = useRef<HTMLInputElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const removeRefImage = (idx: number) => {
    setRefImages((prev) => prev.filter((_, i) => i !== idx))
  }
  const addRefFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    const reader = new FileReader()
    reader.onload = async () => {
      if (typeof reader.result !== 'string') return
      // Upload to server to avoid localStorage bloat
      try {
        const res = await fetch('/uploads/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: reader.result, filename: f.name }),
        })
        const data = await res.json() as { url?: string }
        if (data.url) setRefImages((prev) => [...prev, data.url!])
        else setRefImages((prev) => [...prev, reader.result as string])
      } catch {
        setRefImages((prev) => [...prev, reader.result as string])
      }
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }
  const handlePickAssets = (urls: string[]) => {
    setRefImages((prev) => Array.from(new Set([...prev, ...urls])))
  }
  const [provider, setProvider] = useState<ProviderId>('doubao')
  const [model, setModel] = useState<string>('')
  const [prompt, setPrompt] = useState(initialPrompt)
  const [aspect, setAspect] = useState('16:9')
  const [duration, setDuration] = useState(5)
  const [optimizing, setOptimizing] = useState(false)
  // Advanced params
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [negativePrompt, setNegativePrompt] = useState('')
  const [seed, setSeed] = useState<string>('')
  const [guidanceScale, setGuidanceScale] = useState<number>(7.5)
  const [resolution, setResolution] = useState<string>('720p')
  const [generateAudio, setGenerateAudio] = useState(true)
  const [numImages, setNumImages] = useState<number>(1)

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

  // Pick first enabled provider and a model matching kind when kind changes
  useEffect(() => {
    if (!avail) return
    const enabledProviders = PROVIDERS.filter((p) => avail[p.id] && p.models.some((m) => m.kind === kind))
    if (enabledProviders.length === 0) return

    // Preferred defaults: video → doubao, image → doubao (seedream)
    let preferred: ProviderId | undefined
    if (kind === 'video') preferred = 'doubao'
    else if (kind === 'image') preferred = 'doubao'
    const next = (preferred && enabledProviders.find((p) => p.id === preferred)) ?? enabledProviders[0]
    setProvider(next.id)
  }, [avail, kind])

  // When provider or kind changes, auto-select a valid model
  useEffect(() => {
    const providerModels = (PROVIDERS.find((p) => p.id === provider)?.models ?? []).filter((m) => m.kind === kind)
    if (providerModels.length === 0) return
    // If current model is still valid for this provider+kind, keep it
    if (providerModels.some((m) => m.id === model)) return
    // Otherwise pick a preferred default
    const preferredIds = [
      'doubao-seedream-5-0-260128',           // image default
      'doubao-seedance-2-0-fast-260128',      // video default
    ]
    const preferred = providerModels.find((m) => preferredIds.includes(m.id))
      ?? providerModels.find((m) => /默认|default/i.test(m.label))
      ?? providerModels[0]
    setModel(preferred.id)
  }, [provider, kind, model])

  const models = (PROVIDERS.find((p) => p.id === provider)?.models ?? []).filter((m) => m.kind === kind)

  const disabled = !prompt.trim() || !provider || !model

  return (
    <>
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
          <div className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Link2 className="w-3 h-3" /> 参考图 {refImages.length} 张
          </div>
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {refImages.map((u, i) => (
            <div key={i} className="relative shrink-0 group">
              <img
                src={u}
                alt=""
                className="h-14 w-14 object-cover rounded border border-border"
                title={u}
              />
              <button
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => removeRefImage(i)}
                title="移除参考图"
              >×</button>
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

        <div className="border-t border-border pt-2">
          <button
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            高级设置
          </button>
          {advancedOpen && (
            <div className="mt-2 flex flex-col gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground uppercase">负面提示词</label>
                <input
                  type="text"
                  className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="不希望出现的元素…"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase">随机种子</label>
                  <input
                    type="number"
                    className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    placeholder="空=随机"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase">引导强度 ({guidanceScale})</label>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    step={0.5}
                    className="w-full mt-2"
                    value={guidanceScale}
                    onChange={(e) => setGuidanceScale(Number(e.target.value))}
                  />
                </div>
              </div>
              {kind === 'video' && (
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <label className="text-[10px] text-muted-foreground uppercase">分辨率</label>
                    <select
                      className="text-xs bg-background border border-border rounded px-2 py-1 outline-none"
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                    >
                      {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <label className="text-[11px] flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={generateAudio}
                      onChange={(e) => setGenerateAudio(e.target.checked)}
                    />
                    生成音频
                  </label>
                </div>
              )}
              {kind === 'image' && (
                <div className="flex items-center gap-1.5">
                  <label className="text-[10px] text-muted-foreground uppercase">生成数量</label>
                  <select
                    className="text-xs bg-background border border-border rounded px-2 py-1 outline-none"
                    value={numImages}
                    onChange={(e) => setNumImages(Number(e.target.value))}
                  >
                    {[1, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onCancel}>取消</button>
          <button
            className={cn('px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40')}
            disabled={disabled}
            onClick={() => onSubmit({
              provider, model, prompt: prompt.trim(), kind, aspect, duration, refImages,
              negativePrompt: negativePrompt.trim() || undefined,
              seed: seed.trim() === '' ? undefined : Number(seed),
              guidanceScale,
              resolution: kind === 'video' ? resolution : undefined,
              generateAudio: kind === 'video' ? generateAudio : undefined,
              numImages: kind === 'image' ? numImages : undefined,
            })}
          >
            <Sparkles className="inline w-3 h-3 mr-1" />
            生成
          </button>
        </div>
      </div>
    </div>
    {pickerOpen && <AssetPickerDialog onClose={() => setPickerOpen(false)} onSelect={handlePickAssets} />}
    </>
  )
}
