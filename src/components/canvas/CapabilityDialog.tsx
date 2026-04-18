import { useEffect, useState } from 'react'
import { X, Sparkles, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useCapabilityDialogStore } from '@/stores/capability-dialog-store'
import { useCapability } from '@/hooks/useCapability'
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
  const [running, setRunning] = useState(false)
  const runCap = useCapability()

  const cap = state.capability
  const hasPrompt = cap.inputKinds.includes('text')

  const setParam = (key: string, val: string) => {
    setParams((prev) => ({ ...prev, [key]: val }))
  }

  const handleSubmit = async () => {
    setRunning(true)
    try {
      const extraInputs: { kind: 'text' | 'image'; text?: string; url?: string }[] = []
      if (prompt.trim()) extraInputs.push({ kind: 'text', text: prompt.trim() })
      for (const u of state.refImages) extraInputs.push({ kind: 'image', url: u })
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
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[480px] max-w-full bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3"
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
            <label className="text-[10px] text-muted-foreground uppercase">Prompt / 输入文本</label>
            <textarea
              className="w-full mt-1 min-h-[100px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述要执行的操作…"
              autoFocus
            />
          </div>
        )}

        {(cap.params?.length ?? 0) > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {cap.params!.map((p) => (
              <ParamField key={p.key} param={p} value={params[p.key]} onChange={(v) => setParam(p.key, v)} />
            ))}
          </div>
        )}

        {state.refImages.length > 0 && (
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">参考图 ({state.refImages.length})</label>
            <div className="flex gap-1.5 overflow-x-auto pb-1 mt-1">
              {state.refImages.map((u, i) => (
                <img
                  key={i}
                  src={u}
                  alt=""
                  className="h-14 w-14 object-cover rounded border border-border shrink-0"
                />
              ))}
            </div>
          </div>
        )}

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
