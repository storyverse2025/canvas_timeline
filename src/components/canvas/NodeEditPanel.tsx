import { useState } from 'react'
import { X, Sparkles, Image as ImageIcon, Type as TypeIcon, Mic, Film } from 'lucide-react'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useGenerateDialogStore } from '@/stores/generate-dialog-store'
import { useCapabilityDialogStore } from '@/stores/capability-dialog-store'
import { useProjectDB } from '@/stores/project-db'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { gatherUpstream } from '@/lib/canvas-graph'
import { findVoiceByUrl, getVoice, normalizeVoiceUrl } from '@/lib/voice-library'
import { getCapability } from '@/lib/capabilities/registry'

interface Props {
  nodeId: string;
  itemId: string;
  onClose: () => void;
}

export function NodeEditPanel({ nodeId, itemId, onClose }: Props) {
  const item = useCanvasItemStore((s) => s.items[itemId])
  const updateItem = useCanvasItemStore((s) => s.updateItem)
  const openDialog = useGenerateDialogStore((s) => s.open)
  const openCapDialog = useCapabilityDialogStore((s) => s.open)
  const storyboardRows = useStoryboardStore((s) => s.rows)

  const [name, setName] = useState(item?.name ?? '')
  const [prompt, setPrompt] = useState(item?.prompt ?? '')
  const [content, setContent] = useState(item?.content ?? '')

  if (!item) return null

  const live = gatherUpstream(nodeId)
  const storedRefs = item.refImages ?? []
  const storedAudios = item.refAudios ?? []
  const isVideo = item.kind === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(item.content)

  // For the stale-voice-warning fix: the original UI showed "没有音色文件
  // — 该镜头生成时还没有 voice bindings" whenever item.refAudios was
  // empty. That was historically accurate but stale — bindings written
  // AFTER this video was generated still couldn't be seen. We now read
  // the LIVE bindings + materialize each one — but only for the
  // characters that actually appear in THIS shot, not the whole project.
  const liveBindings = useProjectDB((s) => s.script.voiceBindings ?? {})
  const shotRow = isVideo
    ? storyboardRows.find((r) => r.beatVideoNodeId === nodeId)
    : undefined
  // character1.description can be "林清, 灰色风衣" (name + appearance) —
  // mirror actor-agent's nameFromSlotDescription: first comma-separated token.
  const shotCharacterNames = shotRow
    ? [shotRow.character1?.description, shotRow.character2?.description]
        .map((s) => (s ?? '').split(/[,，。\n]/)[0]?.trim() ?? '')
        .filter((s) => s.length > 0)
    : []
  // Canonical-name binding lookup — actor-agent stores castingCards (and
  // therefore voiceBindings keys) in the bilingual form "莉安 (Lian)" but
  // the storyboard table fills character1.description with the short form
  // "莉安, 灰色风衣". Without stripping the "(English)" tail the lookup
  // misses every Chinese-character project. Also lowercases for ASCII names.
  const canonical = (n: string) => n.replace(/\s*[\(（][^\)）]*[\)）]/g, '').trim().toLowerCase()
  const canonBindings: Record<string, string> = {}
  for (const [name, voiceId] of Object.entries(liveBindings)) {
    canonBindings[canonical(name)] = voiceId
  }
  const liveVoicesNow = isVideo
    ? shotCharacterNames
        .map((characterName) => ({
          characterName,
          voice: getVoice(canonBindings[canonical(characterName)]),
        }))
        .filter((b): b is { characterName: string; voice: NonNullable<ReturnType<typeof getVoice>> } => Boolean(b.voice))
    : []
  // Client-side debug trace so the user can see WHY voices appear/don't.
  if (isVideo) {
    // eslint-disable-next-line no-console
    console.log('[voice-debug][NodeEditPanel]', {
      nodeId,
      shotRowFound: Boolean(shotRow),
      shotCharacterNames,
      voiceBindingKeys: Object.keys(liveBindings),
      matched: liveVoicesNow.map((b) => ({ character: b.characterName, voice: b.voice.displayName, id: b.voice.id })),
    })
  }

  const commit = () => {
    updateItem(itemId, {
      name: name.trim() || item.name,
      prompt: prompt.trim(),
      ...(item.kind === 'text' ? { content } : {}),
    })
    onClose()
  }

  const regenerate = () => {
    updateItem(itemId, { name: name.trim() || item.name, prompt: prompt.trim() })
    if (isVideo) {
      const cap = getCapability('universal-video')
      if (cap) {
        const keyframeUrl = storedRefs[0] ?? shotRow?.keyframeUrl ?? ''
        const voiceUrls = liveVoicesNow
          .map((b) => normalizeVoiceUrl(b.voice.urlPath))
          .filter((u): u is string => Boolean(u))
        const refImages = [keyframeUrl, ...voiceUrls].filter((u): u is string => Boolean(u))
        openCapDialog({
          capability: cap,
          nodeId,
          itemId,
          prompt: prompt.trim() || name || '',
          refImages,
        })
        onClose()
        return
      }
    }
    // Pull in upstream text-node content (e.g., the character 人物小传 +
    // 外貌 / scene description / prop description nodes that sit upstream
    // of this asset image). The bio is the canonical source of truth for
    // appearance; without folding it into the regen prompt, regenerating
    // an asset image strips off everything that made the first pass good.
    const userTyped = prompt.trim() || name || ''
    const upstreamText = live.texts.join('\n\n').trim()
    const composedPrompt = upstreamText
      ? userTyped
        ? `${upstreamText}\n\n${userTyped}`
        : upstreamText
      : userTyped
    openDialog({
      nodeId,
      itemId,
      prompt: composedPrompt,
      upstreamImages: live.images,
      defaultKind: 'image',
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="w-[560px] max-w-full bg-card border border-border rounded-lg shadow-xl p-4 flex flex-col gap-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium flex items-center gap-2">
            {item.kind === 'image' ? <ImageIcon className="w-4 h-4" /> : <TypeIcon className="w-4 h-4" />}
            编辑节点 · {item.kind === 'image' ? '图片/视频' : '文本'}
          </div>
          <button onClick={onClose} className="opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">名称</label>
          <input
            className="w-full mt-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {item.kind === 'text' ? (
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">文本内容</label>
            <textarea
              className="w-full mt-1 min-h-[120px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <label className="text-[10px] text-muted-foreground uppercase">当前内容 URL</label>
            <div className="mt-1 flex gap-2">
              <input
                className="flex-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none font-mono"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="图片或视频 URL"
              />
            </div>
            {content && (
              <div className="mt-2 rounded border border-border overflow-hidden max-h-[180px] flex items-center justify-center bg-black/40">
                {/\.(mp4|webm|mov)(\?|$)/i.test(content)
                  ? <video src={content} className="max-h-[180px]" controls />
                  : <img src={content} alt="" className="max-h-[180px] object-contain" />}
              </div>
            )}
          </div>
        )}

        <div>
          <label className="text-[10px] text-muted-foreground uppercase">
            生成 Prompt {item.provider && <span className="ml-1 opacity-60">· {item.provider}/{item.model}</span>}
          </label>
          <textarea
            className="w-full mt-1 min-h-[80px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="(从未生成过 / 未记录)"
          />
        </div>

        {/* For video items: show the EXACT inputs the model received
            (keyframe image + voice audio refs persisted at shoot time)
            and clearly separate them from the transitive canvas upstream
            (which walks UP from keyframe → assets that fed the keyframe,
            and is confusing because none of those ship to Seedance). */}
        {isVideo && (storedRefs.length > 0 || storedAudios.length > 0) && (
          <div className="rounded border border-primary/40 bg-primary/5 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
              <Film className="w-3 h-3" />
              Seedance 实际输入
            </div>
            {storedRefs.length > 0 && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase mb-1">
                  Keyframe 图 ({storedRefs.length}) — omni-reference
                </div>
                <div className="flex gap-1.5 overflow-x-auto">
                  {storedRefs.map((u, i) => (
                    <img key={`s${i}`} src={u} alt="" className="h-16 w-16 object-cover rounded border border-border shrink-0" title={u} />
                  ))}
                </div>
              </div>
            )}
            {storedAudios.length > 0 ? (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase mb-1">
                  音色文件 ({storedAudios.length}) — 顺序对应 prompt 里的 音色1 / 音色2 / ...
                </div>
                <div className="space-y-1">
                  {storedAudios.map((u, i) => {
                    const voice = findVoiceByUrl(u)
                    return (
                      <div key={`a${i}`} className="flex items-center gap-2 text-[10px]">
                        <span className="text-amber-400 font-mono shrink-0">音色{i + 1}</span>
                        <span className="text-foreground/80 truncate">
                          {voice?.displayName ?? '(unknown voice)'}
                        </span>
                        <audio src={normalizeVoiceUrl(u)} controls preload="none" className="h-6 ml-auto" />
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : liveVoicesNow.length > 0 ? (
              <div className="space-y-1">
                <div className="text-[10px] text-amber-400/80 flex items-center gap-1">
                  <Mic className="w-3 h-3" />
                  本视频生成时还未绑定音色 · 现在已绑定 {liveVoicesNow.length} 个 · 重拍生效
                </div>
                {liveVoicesNow.map(({ characterName, voice }) => (
                  <div key={characterName} className="flex items-center gap-2 text-[10px] pl-4">
                    <span className="text-muted-foreground shrink-0">{characterName}</span>
                    <span className="text-foreground/70 truncate">→ {voice.displayName}</span>
                    <audio src={normalizeVoiceUrl(voice.urlPath)} controls preload="none" className="h-6 ml-auto" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-amber-400/80 flex items-center gap-1">
                <Mic className="w-3 h-3" />
                {shotCharacterNames.length === 0
                  ? '本镜头没有出场角色 — 不需要音色'
                  : '本镜头的角色还没有绑定音色 (先跑导演助手 / 演员表)'}
              </div>
            )}
          </div>
        )}

        {/* Non-video items: keep the legacy refs/upstream display.
            For video items: hide the transitive upstream — those images
            DID NOT ship to Seedance (only the keyframe did), and showing
            them as "upstream" was confusing users. */}
        {!isVideo && (storedRefs.length > 0 || live.images.length > 0) && (
          <div className="space-y-2">
            {storedRefs.length > 0 && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase mb-1">生成时使用的参考图 ({storedRefs.length})</div>
                <div className="flex gap-1.5 overflow-x-auto">
                  {storedRefs.map((u, i) => (
                    <img key={`s${i}`} src={u} alt="" className="h-16 w-16 object-cover rounded border border-border shrink-0" title={u} />
                  ))}
                </div>
              </div>
            )}
            {live.images.length > 0 && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase mb-1">上游当前连入 ({live.images.length})</div>
                <div className="flex gap-1.5 overflow-x-auto">
                  {live.images.map((u, i) => (
                    <img key={`l${i}`} src={u} alt="" className="h-16 w-16 object-cover rounded border border-primary/50 shrink-0" title={u} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-between gap-2 pt-1">
          <button
            className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent inline-flex items-center gap-1"
            onClick={regenerate}
          >
            <Sparkles className="w-3 h-3" /> 用 Prompt 重新生成
          </button>
          <div className="flex gap-2">
            <button className="px-3 py-1.5 text-xs rounded border border-border hover:bg-accent" onClick={onClose}>取消</button>
            <button className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90" onClick={commit}>保存</button>
          </div>
        </div>
      </div>
    </div>
  )
}
