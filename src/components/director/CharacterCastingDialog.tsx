/**
 * CharacterCastingDialog — 真人 / live-action character casting.
 *
 * Lets the user pin each casting-card character to a BytePlus virtual avatar
 * (虚拟人像库). The binding (canonical character name → avatar id) is persisted
 * on project-db and overrides the auto-matcher
 * (src/lib/virtual-avatar-library resolveAvatarsForCharacters). For 真人 styles
 * the chosen avatar drives both the keyframe face and the Seedance `asset://`
 * reference, so the character is sourced from an approved persona (避开审查).
 *
 * BytePlus has no public list API for the platform avatar library, so the
 * catalog is populated by scraping the user's logged-in session or by pasting
 * entries in the Import section below.
 */

import { useEffect, useMemo, useState } from 'react'
import { Search, UserCircle2, Check, X, Download } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useProjectDB } from '@/stores/project-db'
import {
  canonicalCharacterName,
  isRealPersonStyle,
  type VirtualAvatarAsset,
} from '@/lib/virtual-avatar-library'
import { fetchAvatarCatalog, importAvatars, scrapeAvatarsFromCurl } from '@/lib/virtual-avatar-library/client'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onClose: () => void
}

function avatarMeta(a: VirtualAvatarAsset): string {
  const age = a.ageMin || a.ageMax ? `${a.ageMin ?? '?'}–${a.ageMax ?? '?'}` : ''
  return [a.gender, age, a.nationality].filter(Boolean).join(' · ')
}

// Stable fallbacks for zustand selectors. NEVER write `?? []` / `?? {}`
// INSIDE a selector: when the field is undefined (the project-db default for
// castingCards), the selector mints a fresh reference on every getSnapshot,
// useSyncExternalStore sees a changed snapshot each check, and React dies
// with "Maximum update depth exceeded" (forceStoreRerender loop).
const EMPTY_CARDS: NonNullable<ReturnType<typeof useProjectDB.getState>['script']['castingCards']> = []
const EMPTY_BINDINGS: Record<string, string> = {}

export function CharacterCastingDialog({ open, onClose }: Props) {
  const castingCards = useProjectDB((s) => s.script.castingCards) ?? EMPTY_CARDS
  const bindings = useProjectDB((s) => s.script.characterAvatarBindings) ?? EMPTY_BINDINGS
  const stylePreset = useProjectDB((s) => s.artDirection.stylePreset)
  const updateScript = useProjectDB((s) => s.updateScript)

  const [avatars, setAvatars] = useState<VirtualAvatarAsset[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [scraping, setScraping] = useState(false)

  const realPerson = isRealPersonStyle(stylePreset)
  // Default the active character to the first card so an avatar click lands
  // somewhere; an explicit card click overrides. Derived (not stored) to avoid
  // a synchronous setState in the open effect.
  const activeEffectiveKey =
    activeKey ?? (castingCards[0] ? canonicalCharacterName(castingCards[0].name) : null)

  const refresh = async () => {
    setAvatars(await fetchAvatarCatalog())
    setLoaded(true)
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const list = await fetchAvatarCatalog()
        if (!cancelled) { setAvatars(list); setLoaded(true) }
      } catch (e) {
        if (!cancelled) toast.error('加载虚拟人像失败', { description: String((e as Error).message) })
      }
    })()
    return () => { cancelled = true }
  }, [open])

  const byId = useMemo(() => new Map(avatars.map((a) => [a.id, a])), [avatars])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return avatars
    return avatars.filter((a) =>
      [a.name, a.gender, a.nationality, ...(a.tags ?? [])]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q)),
    )
  }, [avatars, search])

  const assign = (avatarId: string) => {
    if (!activeEffectiveKey) {
      toast.message('先选一个角色', { description: '点上方的角色卡，再点头像分配' })
      return
    }
    updateScript({ characterAvatarBindings: { ...bindings, [activeEffectiveKey]: avatarId } })
  }
  const clearBinding = (key: string) => {
    const next = { ...bindings }
    delete next[key]
    updateScript({ characterAvatarBindings: next })
  }

  const runScrape = async () => {
    if (!curlText.trim()) return
    setScraping(true)
    try {
      const r = await scrapeAvatarsFromCurl(curlText)
      toast.success(`抓取成功：${r.count} 个头像（共 ${r.scraped} 条）`)
      setCurlText('')
      await refresh()
    } catch (e) {
      toast.error('抓取失败', { description: String((e as Error).message) })
    } finally {
      setScraping(false)
    }
  }

  const runImport = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(importText)
    } catch {
      toast.error('JSON 解析失败', { description: '粘贴一个 VirtualAvatarAsset 数组' })
      return
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    try {
      const r = await importAvatars(arr as VirtualAvatarAsset[])
      toast.success(`已导入 ${r.added} 个头像（共 ${r.count}）`)
      setImportText('')
      await refresh()
    } catch (e) {
      toast.error('导入失败', { description: String((e as Error).message) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCircle2 className="w-4 h-4" /> 虚拟人像选角 / Character Casting
          </DialogTitle>
        </DialogHeader>

        {!realPerson && (
          <div className="text-[11px] rounded border border-amber-400/40 bg-amber-500/10 text-amber-300 px-2 py-1.5">
            当前风格不是「真人 / 实拍」，虚拟人像只在 live_action 风格下生效。仍可先分配，切到真人风格后即用。
          </div>
        )}

        {/* Casting cards — pick the character to assign */}
        <div>
          <div className="text-[10px] text-muted-foreground uppercase mb-1">角色（点选后再挑头像）</div>
          {castingCards.length === 0 ? (
            <div className="text-xs text-muted-foreground">暂无 casting cards — 先跑一遍导演助手生成角色卡。</div>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {castingCards.map((c) => {
                const key = canonicalCharacterName(c.name)
                const bound = bindings[key] ? byId.get(bindings[key]) : undefined
                return (
                  <button
                    key={key}
                    onClick={() => setActiveKey(key)}
                    className={`shrink-0 w-32 text-left rounded border p-2 ${activeEffectiveKey === key ? 'border-primary bg-primary/10' : 'border-border'}`}
                  >
                    <div className="text-xs font-medium truncate">{c.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {[c.gender_presentation, c.age_range].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      {bound?.uri ? (
                        <img src={bound.uri} alt="" className="w-7 h-7 rounded object-cover" />
                      ) : (
                        <div className="w-7 h-7 rounded bg-muted flex items-center justify-center">
                          <UserCircle2 className="w-4 h-4 text-muted-foreground" />
                        </div>
                      )}
                      <span className="text-[10px] truncate flex-1">
                        {bound ? (bound.name || bound.id) : <span className="text-muted-foreground">未分配</span>}
                      </span>
                      {bindings[key] && (
                        <span
                          role="button"
                          onClick={(e) => { e.stopPropagation(); clearBinding(key) }}
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
          )}
        </div>

        {/* Avatar grid */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7 h-8 text-xs"
              placeholder="搜索头像（性别 / 年龄 / 国籍 / 标签）"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowImport((v) => !v)}>
            <Download className="w-3.5 h-3.5 mr-1" /> 导入
          </Button>
        </div>

        {showImport && (
          <div className="rounded border border-border p-2 space-y-2">
            <div className="text-[11px] text-muted-foreground">
              BytePlus 没有公开列表 API。在 Model Playground 登录后打开「虚拟人像库」，DevTools → Network
              找到列表请求 → 右键 Copy as cURL，粘到下面「cURL 抓取」自动入库（会翻页）。
            </div>
            <textarea
              className="w-full h-20 text-[11px] font-mono bg-background border border-border rounded px-2 py-1 outline-none"
              placeholder="curl 'https://...console.volcengine.com/...' -H 'cookie: ...' --data-raw '{...}'"
              value={curlText}
              onChange={(e) => setCurlText(e.target.value)}
            />
            <Button size="sm" onClick={runScrape} disabled={scraping || !curlText.trim()}>
              {scraping ? '抓取中…' : 'cURL 抓取入库'}
            </Button>

            <div className="text-[11px] text-muted-foreground pt-1">
              或手动粘贴 JSON 数组：
              <code className="mx-1 px-1 bg-muted rounded">{`[{"id":"asset-…","name":"图片1","uri":"https://…","gender":"female","ageMin":20,"ageMax":30}]`}</code>
            </div>
            <textarea
              className="w-full h-20 text-[11px] font-mono bg-background border border-border rounded px-2 py-1 outline-none"
              placeholder='[{"id":"asset-...","name":"图片1","uri":"https://...","gender":"female","ageMin":20,"ageMax":30}]'
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <Button size="sm" variant="ghost" onClick={runImport} disabled={!importText.trim()}>导入 JSON</Button>
          </div>
        )}

        <div className="min-h-[180px] max-h-[42vh] overflow-y-auto">
          {!loaded ? (
            <div className="text-xs text-muted-foreground py-8 text-center">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground py-8 text-center">
              {avatars.length === 0 ? '头像库为空 — 点「导入」添加，或把 Model Playground 的列表请求 cURL 发给我。' : '没有匹配的头像。'}
            </div>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
              {filtered.map((a) => {
                const isBound = activeEffectiveKey != null && bindings[activeEffectiveKey] === a.id
                return (
                  <button
                    key={a.id}
                    onClick={() => assign(a.id)}
                    className={`relative rounded border overflow-hidden text-left ${isBound ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
                    title={a.id}
                  >
                    {a.uri ? (
                      <img src={a.uri} alt={a.name} className="w-full aspect-square object-cover" />
                    ) : (
                      <div className="w-full aspect-square bg-muted flex items-center justify-center">
                        <UserCircle2 className="w-8 h-8 text-muted-foreground" />
                      </div>
                    )}
                    {isBound && (
                      <span className="absolute top-1 right-1 bg-primary text-primary-foreground rounded-full p-0.5">
                        <Check className="w-3 h-3" />
                      </span>
                    )}
                    <div className="p-1">
                      <div className="text-[10px] truncate">{a.name || a.id}</div>
                      <div className="text-[9px] text-muted-foreground truncate">{avatarMeta(a)}</div>
                    </div>
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
