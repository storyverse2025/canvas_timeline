/**
 * ByteplusAssetPickerDialog — compact one-step picker for a SINGLE character
 * slot. Lists ONLY the 开白 assets THIS canvas_timeline instance generated and
 * registered (the local 开白 registry), NOT the shared BytePlus account list.
 *
 * Rationale: the account is used by many people, so its list is full of
 * strangers' faces we never want to bind. Here the user only ever picks from
 * their OWN generated + 开白'd characters. Picking one sets the slot image and
 * binds the character → asset (characterAvatarBindings) in one action, so on
 * shoot its asset:// ref ships and BytePlus real-person privacy passes.
 *
 * The registry is populated automatically when 导演助手 / 生成角色图 runs (each
 * character auto-registers its OWN face). Only Active entries are pickable —
 * Processing ones are shown greyed while BytePlus finishes moderation (~35s).
 */

import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { canonicalCharacterName } from '@/lib/virtual-avatar-library'
import type { ByteplusAsset } from '@/lib/byteplus-asset-library'
import {
  listLocalByteplusAssets,
  toByteplusAsset,
  type LocalByteplusAsset,
} from '@/lib/byteplus-local-assets'

interface Props {
  open: boolean
  characterName?: string
  onClose: () => void
  onPick: (asset: ByteplusAsset) => void
}

export function ByteplusAssetPickerDialog({ open, characterName, onClose, onPick }: Props) {
  const [entries, setEntries] = useState<LocalByteplusAsset[]>([])
  const [query, setQuery] = useState('')

  const reload = () => setEntries(listLocalByteplusAssets())

  useEffect(() => {
    if (!open) return
    reload()
    // Pre-seed the search with this character's name so its own registered
    // asset surfaces first; the user can clear it to see everything.
    setQuery(characterName ? (characterName.split(/[，,。\n]/)[0]?.trim() ?? '') : '')
  }, [open, characterName])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? entries.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q))
      : entries
    // Active first, then Processing (still moderating).
    return [...list].sort((a, b) => Number(b.active) - Number(a.active))
  }, [entries, query])

  const charLabel = characterName?.split(/[，,。\n]/)[0]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="w-4 h-4" />
            选本地开白角色作为{charLabel ? `「${charLabel}」` : '角色'}的角色图
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground">
            只显示你在本 canvas_timeline 生成并开白过的角色；选中即设为角色图并绑定，生成视频时携带 asset:// 引用通过隐私风控。
          </div>
          <Button variant="ghost" size="sm" onClick={reload}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            刷新
          </Button>
        </div>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按角色名 / asset id 搜索"
          className="h-8 text-xs"
        />

        <div className="min-h-[160px] max-h-[46vh] overflow-y-auto">
          {entries.length === 0 ? (
            <div className="text-xs text-muted-foreground py-8 text-center px-6 leading-relaxed">
              还没有在 canvas_timeline 注册过开白角色。<br />
              运行「导演助手」或「生成角色图」会给每个角色自动开白；已有角色可在画布节点上重新生成来补开白。
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground py-8 text-center">没有匹配「{query}」的开白角色 — 清空搜索看全部。</div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {filtered.map((e) => {
                const isSelf = characterName
                  && canonicalCharacterName(e.name) === canonicalCharacterName(characterName)
                return (
                  <button
                    key={e.id}
                    onClick={() => { onPick(toByteplusAsset(e)); onClose() }}
                    disabled={!e.active}
                    className={`rounded border overflow-hidden flex flex-col text-left hover:border-primary disabled:opacity-50 disabled:cursor-not-allowed ${isSelf ? 'border-primary ring-1 ring-primary/40' : 'border-border'}`}
                    title={e.active ? `选中并绑定 (${e.id})` : '开白审核中（Processing），稍后刷新'}
                  >
                    <div className="relative">
                      {e.previewUrl ? (
                        <img src={e.previewUrl} alt={e.name} className="w-full aspect-square object-cover" />
                      ) : (
                        <div className="w-full aspect-square bg-muted flex items-center justify-center text-[10px] text-muted-foreground">无预览</div>
                      )}
                      <span className={`absolute bottom-1 left-1 px-1 py-0.5 rounded text-[9px] text-white ${e.active ? 'bg-emerald-600/80' : 'bg-amber-600/80'}`}>
                        {e.active ? '开白 Active' : '审核中'}
                      </span>
                    </div>
                    <div className="p-1.5 text-[11px] font-medium truncate" title={e.id}>{e.name || e.id}</div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
