/**
 * ByteplusAssetLibraryDialog — 开白真人资产库 (BytePlus private digital assets).
 *
 * Shows the account's registered assets (AK/SK-signed ListAssets via the dev
 * server), lets the user ASSIGN an asset to a storyboard character (console
 * asset Names are machine hashes, so explicit assignment is the primary
 * path; auto name-match kicks in when assets are renamed to character
 * names), previews the exact refs generateBeatVideo will ship, and can add
 * any asset image to the canvas as a character reference node. Previews are
 * permanent /uploads/ copies, so nothing here dies with the signed URL's
 * ~12h expiry.
 *
 * Assignments persist in project-db `characterAvatarBindings` — the same
 * map the avatar-library casting dialog uses. Each consumer only acts on
 * ids it recognizes, so avatar ids and asset ids coexist safely.
 */

import { useEffect, useMemo, useState } from 'react'
import { BadgeCheck, ImagePlus, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { useProjectDB } from '@/stores/project-db'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { canonicalCharacterName } from '@/lib/virtual-avatar-library'
import { correctElementRole } from '@/lib/canvas-elements'
import {
  fetchByteplusAssets,
  matchAssetsToCharacters,
  type ByteplusAsset,
} from '@/lib/byteplus-asset-library'

interface Props {
  open: boolean
  onClose: () => void
}

// Stable fallback for the zustand selector — see [[zustand-selector-stable-refs]]:
// a fresh `?? {}` inside the selector would mint a new snapshot per check.
const EMPTY_BINDINGS: Record<string, string> = {}

function statusBadgeClass(status: string): string {
  const s = status.toLowerCase()
  if (s === 'active') return 'border-emerald-400/50 bg-emerald-500/10 text-emerald-300'
  if (s === 'processing') return 'border-amber-400/50 bg-amber-500/10 text-amber-300'
  return 'border-red-400/50 bg-red-500/10 text-red-300'
}

export function ByteplusAssetLibraryDialog({ open, onClose }: Props) {
  const [assets, setAssets] = useState<ByteplusAsset[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const bindings = useProjectDB((s) => s.script.characterAvatarBindings) ?? EMPTY_BINDINGS
  const updateScript = useProjectDB((s) => s.updateScript)
  const rows = useStoryboardStore((s) => s.rows)

  const load = async (force: boolean) => {
    setLoading(true)
    setError(null)
    try {
      setAssets(await fetchByteplusAssets({ force }))
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load(false)
  }, [open])

  // Distinct storyboard characters (canonical name) — the assignment targets.
  const characters = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ key: string; slotLabel: string; name: string; short: string }> = []
    for (const r of rows) {
      for (const [slotLabel, slot] of [['角色1', r.character1], ['角色2', r.character2]] as const) {
        const name = slot?.description?.trim()
        if (!name) continue
        const key = canonicalCharacterName(name)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push({ key, slotLabel, name, short: name.split(/[,，。\n]/)[0]?.trim() || name })
      }
    }
    return out
  }, [rows])

  const activeEffectiveKey = activeKey ?? characters[0]?.key ?? null
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  // Dry run of the EXACT matcher generateBeatVideo uses (bindings included).
  const { matches, unmatched } = useMemo(() => {
    const refs = matchAssetsToCharacters(
      characters.map((c) => ({ slotLabel: c.slotLabel, name: c.name })),
      assets,
      bindings,
    )
    const matchedNames = new Set(refs.map((m) => canonicalCharacterName(m.characterName)))
    return { matches: refs, unmatched: characters.filter((c) => !matchedNames.has(c.key)) }
  }, [characters, assets, bindings])

  const assign = (asset: ByteplusAsset) => {
    if (!activeEffectiveKey) {
      toast.message('分镜表还没有角色', { description: '先在分镜表填角色，再回来分配资产' })
      return
    }
    if (asset.status.toLowerCase() !== 'active' || asset.assetType.toLowerCase() !== 'image') {
      toast.error('只能分配 Active 的 Image 资产')
      return
    }
    updateScript({ characterAvatarBindings: { ...bindings, [activeEffectiveKey]: asset.id } })
    const ch = characters.find((c) => c.key === activeEffectiveKey)
    toast.success(`已把资产分配给「${ch?.short ?? activeEffectiveKey}」`, {
      description: `生成视频时该角色将携带 asset://${asset.id}`,
    })
  }

  const clearBinding = (key: string) => {
    const next = { ...bindings }
    delete next[key]
    updateScript({ characterAvatarBindings: next })
  }

  const addToCanvas = (asset: ByteplusAsset) => {
    if (!asset.previewUrl) {
      toast.error('该资产没有可用预览图', { description: '点「刷新」让服务端重新下载，或检查资产在控制台是否有图。' })
      return
    }
    const itemStore = useCanvasItemStore.getState()
    const existing = Object.values(itemStore.items).find(
      (it) => it.kind === 'image' && it.content === asset.previewUrl,
    )
    if (existing) {
      toast.message('已在画布上', { description: `「${asset.name || asset.id}」已有节点，无需重复添加` })
      return
    }
    // Infer role from the asset name — a 开白 asset named 场景：/道具： must NOT
    // become a character node (else regen applies the character portrait
    // template to a scene). Defaults to character for real-person assets.
    const role = correctElementRole(asset.name || '', 'character')
    const count = Object.values(itemStore.items).filter((it) => it.role === role).length
    const itemId = itemStore.addItem({
      kind: 'image',
      name: asset.name || asset.id,
      content: asset.previewUrl,
      role,
      prompt: `BytePlus 开白资产 asset://${asset.id}`,
    })
    useCanvasStore.getState().addItemNode(
      itemId, 'image',
      { x: -600, y: count * 210 },
      { width: 200, height: 200 },
    )
    toast.success(`已添加「${asset.name || asset.id}」到画布`, {
      description: '可作为角色参考图连线使用；生成视频时按上方分配携带 asset:// 开白引用',
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> 开白真人资产库 / BytePlus Digital Assets
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <div className="text-[11px] text-muted-foreground">
            点选角色 → 再点资产完成分配；生成视频时按分配（或资产名匹配）自动携带 asset://ID 开白引用。
          </div>
          <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {error && (
          <div className="text-[11px] rounded border border-red-400/40 bg-red-500/10 text-red-300 px-2 py-1.5">
            资产列表拉取失败：{error}
            {/AccessDenied|ListAssets/i.test(error) && (
              <div className="mt-1 text-red-200/80">
                多半是 IAM 权限：给 BYTEPLUS_ACCESS_KEY 附加资产库策略（ark:*Asset*），并确认 .env 的 BYTEPLUS_PROJECT_NAME 正确（该 key 是项目级授权）。
              </div>
            )}
          </div>
        )}

        {/* Character chips — pick the assignment target. */}
        {characters.length > 0 && (
          <div>
            <div className="text-[10px] text-muted-foreground uppercase mb-1">角色（点选后再点资产分配）</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {characters.map((c) => {
                const boundAsset = bindings[c.key] ? assetById.get(bindings[c.key]) : undefined
                return (
                  <button
                    key={c.key}
                    onClick={() => setActiveKey(c.key)}
                    className={`shrink-0 max-w-40 text-left rounded border p-2 ${activeEffectiveKey === c.key ? 'border-primary bg-primary/10' : 'border-border'}`}
                  >
                    <div className="text-xs font-medium truncate">{c.short}</div>
                    <div className="mt-1 flex items-center gap-1">
                      {boundAsset?.previewUrl ? (
                        <img src={boundAsset.previewUrl} alt="" className="w-7 h-7 rounded object-cover" />
                      ) : (
                        <div className="w-7 h-7 rounded bg-muted" />
                      )}
                      <span className="text-[10px] truncate flex-1">
                        {bindings[c.key]
                          ? (boundAsset?.name || bindings[c.key])
                          : <span className="text-muted-foreground">未分配</span>}
                      </span>
                      {bindings[c.key] && (
                        <span
                          role="button"
                          onClick={(e) => { e.stopPropagation(); clearBinding(c.key) }}
                          className="text-muted-foreground hover:text-destructive"
                          title="清除分配"
                        >
                          <X className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Dry run of what generateBeatVideo will actually ship. */}
        {(matches.length > 0 || unmatched.length > 0) && !error && (
          <div className="rounded border border-border p-2 space-y-1">
            <div className="text-[10px] text-muted-foreground uppercase">生成视频时将携带</div>
            {matches.map((m) => {
              const asset = assetById.get(m.assetUri.replace('asset://', ''))
              return (
                <div key={m.assetUri} className="flex items-center gap-2 text-xs">
                  <BadgeCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span className="truncate">{m.characterName}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="truncate text-emerald-300">{asset?.name || m.assetUri}</span>
                </div>
              )
            })}
            {unmatched.map((c) => (
              <div key={c.key} className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="w-3.5 h-3.5 shrink-0 text-center leading-none">—</span>
                <span className="truncate">{c.short}</span>
                <span className="text-amber-300/80">未分配 / 未匹配 — 点选该角色后点下方资产</span>
              </div>
            ))}
          </div>
        )}

        <div className="min-h-[160px] max-h-[42vh] overflow-y-auto">
          {loading && assets.length === 0 ? (
            <div className="text-xs text-muted-foreground py-8 text-center">加载中…（首次会把资产图缓存到本地，可能稍慢）</div>
          ) : assets.length === 0 && !error ? (
            <div className="text-xs text-muted-foreground py-8 text-center">
              资产库为空 — 在 BytePlus 控制台「资产库」注册真人形象（Status 达到 Active 后即可用）。
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {assets.map((a) => {
                const isBound = activeEffectiveKey != null && bindings[activeEffectiveKey] === a.id
                return (
                  <div
                    key={a.id}
                    className={`rounded border overflow-hidden flex flex-col ${isBound ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
                  >
                    <button onClick={() => assign(a)} title={`分配给当前选中的角色 (${a.id})`}>
                      {a.previewUrl ? (
                        <img src={a.previewUrl} alt={a.name} className="w-full aspect-square object-cover" />
                      ) : (
                        <div className="w-full aspect-square bg-muted flex items-center justify-center text-[10px] text-muted-foreground">
                          {a.assetType === 'Video' ? '视频资产' : '无预览'}
                        </div>
                      )}
                    </button>
                    <div className="p-1.5 flex-1 flex flex-col gap-1">
                      <div className="text-[11px] font-medium truncate" title={a.id}>{a.name || a.id}</div>
                      <div className="flex items-center gap-1">
                        <span className={`text-[9px] px-1 py-0.5 rounded border ${statusBadgeClass(a.status)}`}>
                          {a.status}
                        </span>
                        <span className="text-[9px] text-muted-foreground">{a.assetType}</span>
                      </div>
                      <button
                        onClick={() => addToCanvas(a)}
                        className="mt-auto flex items-center justify-center gap-1 text-[10px] px-1.5 py-1 rounded border border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                        title="以角色参考图节点加入画布（用的是已持久化的 /uploads/ 副本，不会过期）"
                      >
                        <ImagePlus className="w-3 h-3" />
                        添加到画布
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
