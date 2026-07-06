import { useProjectDB } from '@/stores/project-db'
import { PROVIDERS } from '@/lib/providers/registry'
import { StylePresetsGrid } from './StylePresetsGrid'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { getArtStyle } from '@/lib/canvas-elements'
import { toast } from 'sonner'
import { Wand2, UserCircle2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { isRealPersonStyle } from '@/lib/virtual-avatar-library'
import { CharacterCastingDialog } from './CharacterCastingDialog'
import { ByteplusAssetLibraryDialog } from './ByteplusAssetLibraryDialog'

const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

export function ArtDirectionPanel() {
  const art = useProjectDB((s) => s.artDirection)
  const update = useProjectDB((s) => s.updateArtDirection)
  const [castingOpen, setCastingOpen] = useState(false)
  const [assetLibOpen, setAssetLibOpen] = useState(false)
  const realPerson = isRealPersonStyle(art.stylePreset)

  const imageModels = PROVIDERS.flatMap((p) => p.models.filter((m) => m.kind === 'image').map((m) => ({ provider: p.id, model: m.id, label: `${p.label} · ${m.label}` })))
  const videoModels = PROVIDERS.flatMap((p) => p.models.filter((m) => m.kind === 'video').map((m) => ({ provider: p.id, model: m.id, label: `${p.label} · ${m.label}` })))

  const spawnGlobalStyleNode = () => {
    const styleText = getArtStyle({ stylePreset: art.stylePreset, customStyle: art.customStyle })
    if (!styleText.trim()) { toast.error('当前风格为空'); return }
    const { items, addItem, updateItem } = useCanvasItemStore.getState()
    const existing = Object.values(items).find((it) => it.kind === 'text' && it.role === 'style')
    if (existing) {
      updateItem(existing.id, { content: styleText, name: '全局风格' })
      toast.success('已更新画布上的全局风格节点')
      return
    }
    const itemId = addItem({ kind: 'text', name: '全局风格', content: styleText, role: 'style' })
    useCanvasStore.getState().addItemNode(itemId, 'text', { x: 40, y: 40 }, { width: 260, height: 140 })
    toast.success('已在画布添加全局风格节点 — 连接它到资产节点即可应用')
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="text-[10px] text-muted-foreground uppercase mb-1 block">风格预设</label>
        <StylePresetsGrid value={art.stylePreset} onChange={(v) => update({ stylePreset: v })} />
      </div>

      <div>
        <button
          onClick={() => setCastingOpen(true)}
          className={`w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded border ${realPerson ? 'border-emerald-400/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20' : 'border-border text-muted-foreground hover:bg-muted/40'}`}
          title="真人 / 实拍风格：把每个角色绑定到 BytePlus 虚拟人像，避开内容审查"
        >
          <UserCircle2 className="w-3 h-3" />
          虚拟人像选角{realPerson ? '（真人风格已启用）' : ''}
        </button>
        <button
          onClick={() => setAssetLibOpen(true)}
          className="mt-1.5 w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded border border-border text-muted-foreground hover:bg-muted/40"
          title="查看账号已开白的 BytePlus 真人资产，预览角色名匹配结果，并可把资产图加入画布"
        >
          <ShieldCheck className="w-3 h-3" />
          开白真人资产库
        </button>
      </div>
      <CharacterCastingDialog open={castingOpen} onClose={() => setCastingOpen(false)} />
      <ByteplusAssetLibraryDialog open={assetLibOpen} onClose={() => setAssetLibOpen(false)} />

      <div>
        <label className="text-[10px] text-muted-foreground uppercase mb-1 block">自定义风格 (可选)</label>
        <input
          className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
          value={art.customStyle}
          onChange={(e) => update({ customStyle: e.target.value })}
          placeholder="例：赛博朋克 + 霓虹灯光 + 雨夜"
        />
        <button
          onClick={spawnGlobalStyleNode}
          className="mt-1.5 w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded border border-purple-400/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20"
          title="将当前风格作为画布上的全局风格文本节点，连接到资产节点即可生效"
        >
          <Wand2 className="w-3 h-3" />
          作为全局风格节点添加到画布
        </button>
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
