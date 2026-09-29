import { useEffect, useRef, useState } from 'react'
import { X, Sparkles, Loader2, Plus, FolderOpen, Wand2, Music, Video as VideoIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useCapabilityDialogStore } from '@/stores/capability-dialog-store'
import { useCapability } from '@/hooks/useCapability'
import { optimizePrompt } from '@/lib/providers/client'
import { AssetPickerDialog, type AssetPickKind, type PickedAsset } from './AssetPickerDialog'
import type { CapabilityParam } from '@/lib/capabilities/types'
import { cn } from '@/lib/utils'
import { thumb } from '@/lib/thumb'
import { serverBaseUrl } from '@/lib/capabilities/trace'

/** Pull the input kind out of a ref URL extension. Keeps the picker honest
 *  when the caller seeded refImages with raw URLs but didn't ship kind info. */
function inferKindFromUrl(url: string): AssetPickKind {
  const path = url.split('?')[0].toLowerCase()
  if (/\.(mp3|wav|flac|m4a|ogg|aac)$/.test(path)) return 'audio'
  if (/\.(mp4|webm|mov|m4v|avi)$/.test(path)) return 'video'
  return 'image'
}

interface RefAsset {
  url: string
  kind: AssetPickKind
}

/** 服务端 text-to-video / universal-video 不带 params.model 时用的默认档。
 *  下拉框必须显式选中它，否则显示的和实际跑的不是一个模型。 */
const DEFAULT_VIDEO_MODEL = 'dreamina-seedance-2-0-fast-260128'

/** One entry of /capabilities/models' video list. */
interface VideoModel {
  id: string
  label: string
  provider: string
  costPer?: number
  durations?: number[]
  /** BytePlus endpoint this id resolves to, and how (see seedanceEndpointSource). */
  endpoint?: string
  endpointSource?: 'endpoint-id' | 'per-model-env' | 'table' | 'fallback' | 'passthrough' | 'gateway'
}

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
    // Caller-supplied values (e.g. the source video's own duration / resolution)
    // win over the capability defaults, but only for params this capability has.
    // `model` is the exception: it's a real server param that no capability
    // declares, so filtering it out silently threw away the source video's
    // model and every re-shoot fell back to the server default.
    for (const [k, v] of Object.entries(state.params ?? {})) {
      if (k === 'model') { defaults.model = String(v); continue }
      const spec = (state.capability.params ?? []).find((p) => p.key === k)
      if (!spec) continue
      if (spec.options?.length && !spec.options.some((o) => String(o.value) === String(v))) continue
      defaults[k] = String(v)
    }
    return defaults
  })
  const [refs, setRefs] = useState<RefAsset[]>(
    () => state.refImages.map((url) => ({ url, kind: inferKindFromUrl(url) })),
  )
  const refImages = refs.filter((r) => r.kind === 'image').map((r) => r.url)
  const [videoModels, setVideoModels] = useState<VideoModel[]>([])
  const [running, setRunning] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const runCap = useCapability()

  const cap = state.capability
  const hasPrompt = cap.inputKinds.includes('text')
  const isUniversalVideo = cap.id === 'universal-video'
  const isVideo = cap.outputKind === 'video'

  // Model picker for video capabilities: the server takes params.model, so a
  // re-shoot can be sent to Seedance 2.5 instead of whatever shot it last time.
  useEffect(() => {
    if (!isVideo) return
    let alive = true
    void fetch(`${serverBaseUrl()}/capabilities/models`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { video?: VideoModel[] } | null) => {
        if (!alive || !d?.video) return
        setVideoModels(d.video)
        // A <select> whose value matches no <option> still *displays* the first
        // one, and re-picking that displayed option fires no onChange — so the
        // user saw "Seedance 2.5" while params.model was still empty and the
        // server shot on its own default. Make value and display agree.
        setParams((prev) => (prev.model ? prev : { ...prev, model: DEFAULT_VIDEO_MODEL }))
      })
      .catch(() => { /* offline: keep the model the caller seeded */ })
    return () => { alive = false }
  }, [isVideo])

  const selectedModel = String(params.model ?? '')
  const modelSpec = videoModels.find((m) => m.id === selectedModel)
  // 2.5 goes to 30s, the 2.0 family stops at 15s — follow the picked model.
  const durationOptions = modelSpec?.durations?.length
    ? modelSpec.durations.map((d) => ({ value: String(d), label: `${d}s` }))
    : undefined

  const setParam = (key: string, val: string) => {
    setParams((prev) => ({ ...prev, [key]: val }))
  }

  const addRefFileRef = useRef<HTMLInputElement>(null)
  const removeRef = (idx: number) => {
    setRefs((prev) => prev.filter((_, i) => i !== idx))
  }
  const addRefFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    const reader = new FileReader()
    reader.onload = async () => {
      if (typeof reader.result !== 'string') return
      const kind: AssetPickKind = f.type.startsWith('audio/')
        ? 'audio'
        : f.type.startsWith('video/')
          ? 'video'
          : 'image'
      // Upload to server to get a URL (avoids localStorage bloat).
      try {
        const res = await fetch('/uploads/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl: reader.result, filename: f.name }),
        })
        const data = await res.json() as { url?: string }
        if (data.url) setRefs((prev) => [...prev, { url: data.url!, kind }])
      } catch {
        // Fallback: use data URL directly
        setRefs((prev) => [...prev, { url: reader.result as string, kind }])
      }
    }
    reader.readAsDataURL(f)
    e.target.value = ''
  }

  const handlePickAssets = (picked: PickedAsset[]) => {
    setRefs((prev) => {
      const seen = new Set(prev.map((r) => r.url))
      const merged = [...prev]
      for (const p of picked) {
        if (!seen.has(p.url)) { merged.push(p); seen.add(p.url) }
      }
      return merged
    })
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
      const extraInputs: { kind: 'text' | 'image' | 'audio' | 'video'; text?: string; url?: string }[] = []
      if (prompt.trim()) extraInputs.push({ kind: 'text', text: prompt.trim() })
      for (const r of refs) extraInputs.push({ kind: r.kind, url: r.url })
      await runCap({
        capabilityId: cap.id,
        nodeId: state.nodeId,
        itemId: state.itemId,
        params,
        extraInputs,
        includeSourceContent: state.includeSourceContent,
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

        {(isVideo && !cap.pipeline && videoModels.length > 0) && (
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">模型</label>
            <select
              className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
              value={selectedModel}
              onChange={(e) => {
                const next = videoModels.find((m) => m.id === e.target.value)
                setParam('model', e.target.value)
                if (next?.provider) setParam('provider', next.provider)
                // Keep the duration legal for the newly picked model.
                const allowed = next?.durations
                const current = Number(params.duration ?? 0)
                if (allowed?.length && current && !allowed.includes(current)) {
                  setParam('duration', String(allowed.reduce((best, d) => (Math.abs(d - current) < Math.abs(best - current) ? d : best), allowed[0])))
                }
              }}
            >
              {!videoModels.some((m) => m.id === selectedModel) && selectedModel && (
                <option value={selectedModel}>{selectedModel}（当前）</option>
              )}
              {videoModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}{m.costPer ? ` · ~$${m.costPer}/条` : ''}{m.endpointSource === 'fallback' ? ' · 未配置 endpoint' : ''}
                </option>
              ))}
            </select>
            {modelSpec?.endpointSource === 'gateway' && (
              <p className="text-[10px] text-slate-400 mt-1">
                走 StoryVerse 网关 · 实际模型 {modelSpec.endpoint}
                {modelSpec.endpoint === 'sv-seedance-2.0' && /fast/i.test(modelSpec.id) && '（网关没有 fast 档，按 2.0 出片）'}
              </p>
            )}
            {modelSpec?.endpointSource === 'fallback' && (
              <p className="text-[10px] text-amber-400/90 mt-1">
                ⚠ 这个账号没有 {modelSpec.label} 的 endpoint，实际会跑在 {modelSpec.endpoint} 上（默认那个模型），出片不是你选的模型。
                在 .env 配 SEEDANCE_ENDPOINT_{modelSpec.id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}=ep-xxxx 后重启才会真正生效。
              </p>
            )}
          </div>
        )}

        {(cap.params?.length ?? 0) > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {cap.params!.map((p) => (
              <ParamField
                key={p.key}
                // A pipeline capability's `duration` is the finished length; only a
                // single-model call takes its durations from the chosen model.
                param={p.key === 'duration' && durationOptions && !cap.pipeline
                  ? { ...p, options: durationOptions }
                  : p}
                value={params[p.key]}
                onChange={(v) => setParam(p.key, v)}
              />
            ))}
          </div>
        )}

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">参考素材 ({refs.length})</label>
          <div className="flex gap-1.5 overflow-x-auto pb-1 mt-1">
            {refs.map((r, i) => {
              // Per-kind label so the user can see they picked an audio
              // node (音色), not just "图N". This shipped silently as
              // kind='image' before and either Seedance rejected the URL
              // or the file was treated as a still.
              const label = r.kind === 'audio' ? `音${i + 1}` : r.kind === 'video' ? `视${i + 1}` : `图${i + 1}`
              return (
                <div key={`${r.url}-${i}`} className="relative shrink-0 group">
                  {r.kind === 'image' ? (
                    <img src={thumb(r.url, 256)} alt="" loading="lazy" decoding="async" className="h-14 w-14 object-cover rounded border border-border" />
                  ) : (
                    <div className="h-14 w-14 rounded border border-border bg-muted/40 flex items-center justify-center">
                      {r.kind === 'audio'
                        ? <Music className="w-5 h-5 text-muted-foreground" />
                        : <VideoIcon className="w-5 h-5 text-muted-foreground" />}
                    </div>
                  )}
                  <button
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => removeRef(i)}
                    title="移除"
                  >×</button>
                  <div className="absolute bottom-0 left-0 right-0 text-[8px] text-center bg-black/60 text-white py-0.5">
                    {label}
                  </div>
                </div>
              )
            })}
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
              title={isVideo ? '上传本地图片或音频' : '上传本地图片'}
            >
              <Plus className="w-4 h-4 text-muted-foreground" />
              <span className="text-[8px] text-muted-foreground">上传</span>
            </button>
            <input
              ref={addRefFileRef}
              type="file"
              accept={
                // Universal-video accepts all three; text-to-video / first-last accept
                // image + audio (the audio drives lip-sync via Seedance refs); image
                // capabilities stay image-only.
                isUniversalVideo
                  ? 'image/*,audio/*,video/*'
                  : isVideo
                    ? 'image/*,audio/*'
                    : 'image/*'
              }
              className="hidden"
              onChange={addRefFromFile}
            />
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
    {pickerOpen && (
      <AssetPickerDialog
        onClose={() => setPickerOpen(false)}
        onSelect={handlePickAssets}
        allowedKinds={
          isUniversalVideo
            ? new Set<AssetPickKind>(['image', 'audio', 'video'])
            : isVideo
              ? new Set<AssetPickKind>(['image', 'audio'])
              : new Set<AssetPickKind>(['image'])
        }
      />
    )}
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
