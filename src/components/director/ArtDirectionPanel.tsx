import { useProjectDB } from '@/stores/project-db'
import { PROVIDERS } from '@/lib/providers/registry'
import { StylePresetsGrid } from './StylePresetsGrid'

const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

export function ArtDirectionPanel() {
  const art = useProjectDB((s) => s.artDirection)
  const update = useProjectDB((s) => s.updateArtDirection)

  const imageModels = PROVIDERS.flatMap((p) => p.models.filter((m) => m.kind === 'image').map((m) => ({ provider: p.id, model: m.id, label: `${p.label} · ${m.label}` })))
  const videoModels = PROVIDERS.flatMap((p) => p.models.filter((m) => m.kind === 'video').map((m) => ({ provider: p.id, model: m.id, label: `${p.label} · ${m.label}` })))

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="text-[10px] text-muted-foreground uppercase mb-1 block">风格预设</label>
        <StylePresetsGrid value={art.stylePreset} onChange={(v) => update({ stylePreset: v })} />
      </div>

      <div>
        <label className="text-[10px] text-muted-foreground uppercase mb-1 block">自定义风格 (可选)</label>
        <input
          className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
          value={art.customStyle}
          onChange={(e) => update({ customStyle: e.target.value })}
          placeholder="例：赛博朋克 + 霓虹灯光 + 雨夜"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground uppercase mb-1 block">图片模型</label>
          <select
            className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
            value={art.defaultImageModel}
            onChange={(e) => update({ defaultImageModel: e.target.value })}
          >
            {imageModels.map((m) => (
              <option key={m.model} value={m.model}>{m.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase mb-1 block">视频模型</label>
          <select
            className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
            value={art.defaultVideoModel}
            onChange={(e) => update({ defaultVideoModel: e.target.value })}
          >
            {videoModels.map((m) => (
              <option key={m.model} value={m.model}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="text-[10px] text-muted-foreground uppercase mb-1 block">画面比例</label>
        <div className="flex gap-1.5">
          {ASPECTS.map((a) => (
            <button
              key={a}
              className={`text-[10px] px-2.5 py-1 rounded border ${art.defaultAspectRatio === a ? 'border-primary bg-primary/15 text-primary' : 'border-border text-muted-foreground'}`}
              onClick={() => update({ defaultAspectRatio: a })}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
