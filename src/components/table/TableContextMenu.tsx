import { useEffect, useRef, useState } from 'react'
import { Trash2, Plus, Film, Image as ImageIcon, Drama, Music2, Layers, Library, Repeat } from 'lucide-react'
import { toast } from 'sonner'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useProjectDB } from '@/stores/project-db'
import { useStoryboardGenerate } from '@/hooks/useStoryboardGenerate'
import { runCapability } from '@/lib/capabilities/client'
import { enrichRow as actorEnrichRow } from '@/lib/agents/actor-agent'
import { designRow as soundDesignRow } from '@/lib/agents/sound-agent'
import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'
import { api } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import {
  buildRagGlobalArtStyleContext,
  buildRagQueries,
  buildRagQueryExtractionPrompt,
  buildRagRowRewritePrompt,
  EMPTY_RAG_SELECTION,
  parseRagExtractedQueries,
  parseRagRowPatch,
  RAG_REFERENCE_LABELS,
  selectedRagHits,
  toggleRagSelection,
  type RagReferenceGroups,
  type RagReferenceHit,
  type RagReferenceKind,
  type RagSelection,
} from './rag-row-rewrite'

export interface TableMenuState {
  rowId: string
  x: number
  y: number
}

interface Props {
  menu: TableMenuState | null
  onClose: () => void
}

interface RagModalState {
  rowId: string
  shotNumber: string
  loading: boolean
  applying: boolean
  error: string | null
  generatedQueries: Record<RagReferenceKind, string>
  groups: RagReferenceGroups
  selection: RagSelection
  feedback: string
}

const EMPTY_RAG_GROUPS: RagReferenceGroups = { art: [], action: [], camera: [] }
const RAG_KINDS: RagReferenceKind[] = ['art', 'action', 'camera']
const RAG_QUERY_LABELS: Record<RagReferenceKind, string> = {
  art: '美术 query',
  action: '动作 query',
  camera: '镜头 query',
}

export function TableContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [ragModal, setRagModal] = useState<RagModalState | null>(null)
  const rows = useStoryboardStore((s) => s.rows)
  const removeRow = useStoryboardStore((s) => s.removeRow)
  const insertRowAfter = useStoryboardStore((s) => s.insertRowAfter)
  const { generateKeyframe, generateKeyframesIterative, generateBeatVideo, generateBeatVideoMultiStrategy } = useStoryboardGenerate()

  const row = rows.find((r) => r.id === menu?.rowId)
  const rowIdx = rows.findIndex((r) => r.id === menu?.rowId)

  useEffect(() => {
    if (!menu) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menu, onClose])

  if (!menu || !row) {
    return ragModal ? <RagReferenceModal modal={ragModal} setModal={setRagModal} /> : null
  }

  const handleDelete = () => {
    removeRow(menu.rowId)
    onClose()
    toast.success(`已删除镜头 ${row.shot_number}`)
  }

  const handleInsertTransition = async () => {
    onClose()
    const nextRow = rows[rowIdx + 1]
    const prevDesc = row.visual_description || row.storyboard_prompts || ''
    const nextDesc = nextRow?.visual_description || nextRow?.storyboard_prompts || '结束'

    toast.info('正在生成过渡分镜…')
    try {
      const result = await runCapability({
        capability: 'shot-extraction',
        inputs: [{ kind: 'text', text:
          `在以下两个镜头之间插入一个自然的过渡镜头：
前一镜头 (${row.shot_number}): ${prevDesc}
后一镜头 (${nextRow?.shot_number ?? '结束'}): ${nextDesc}

只生成一个过渡镜头，输出 JSON 格式：
{
  "shot_number": "${row.shot_number}T",
  "duration": 3,
  "visual_description": "...",
  "shot_size": "...",
  "character_actions": "...",
  "emotion_mood": "...",
  "emotion_atmosphere": "...(情绪+氛围感，指导镜头语言)",
  "character_motivation": "...(角色为什么这样行动/说话)",
  "character_psychology": "...(心理纠结/潜台词/处境压力)",
  "performance_guidance": "...(演员可执行的表演动作)",
  "lighting_atmosphere": "...",
  "dialogue": "",
  "storyboard_prompts": "...(英文 prompt for image generation)",
  "motion_prompts": "...(英文 prompt for video generation)"
}` }],
      })

      const text = result.outputs[0]?.text ?? ''
      let parsed: Record<string, unknown>
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/)
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text)
      } catch {
        toast.error('AI 返回格式解析失败')
        return
      }

      const newRowId = insertRowAfter(menu.rowId, {
        shot_number: String(parsed.shot_number ?? `${row.shot_number}T`),
        duration: Number(parsed.duration) || 3,
        visual_description: String(parsed.visual_description ?? ''),
        reference_image: '',
        shot_size: String(parsed.shot_size ?? ''),
        character_actions: String(parsed.character_actions ?? ''),
        emotion_mood: String(parsed.emotion_mood ?? ''),
        emotion_atmosphere: String(parsed.emotion_atmosphere ?? ''),
        character_motivation: String(parsed.character_motivation ?? ''),
        character_psychology: String(parsed.character_psychology ?? ''),
        performance_guidance: String(parsed.performance_guidance ?? ''),
        scene_tags: String(parsed.scene_tags ?? ''),
        lighting_atmosphere: String(parsed.lighting_atmosphere ?? ''),
        sound_effects: String(parsed.sound_effects ?? ''),
        dialogue: String(parsed.dialogue ?? ''),
        storyboard_prompts: String(parsed.storyboard_prompts ?? ''),
        motion_prompts: String(parsed.motion_prompts ?? ''),
        bgm: '',
        mixing_brief: '',
        visual_anchor: '',
        character1: row.character1 ?? { image: '', description: '', nodeId: '' },
        character2: row.character2 ?? { image: '', description: '', nodeId: '' },
        prop1: row.prop1 ?? { image: '', description: '', nodeId: '' },
        prop2: row.prop2 ?? { image: '', description: '', nodeId: '' },
        scene: row.scene ?? { image: '', description: '', nodeId: '' },
        status: 'todo',
      })

      toast.success(`已插入过渡分镜 ${parsed.shot_number ?? 'T'}`)

      // Auto-generate keyframe for the new transition row
      const newRow = useStoryboardStore.getState().rows.find((r) => r.id === newRowId)
      if (newRow) {
        generateKeyframe(newRow)
      }
    } catch (e) {
      toast.error('过渡分镜生成失败', { description: String((e as Error).message).slice(0, 200) })
    }
  }

  const handleGenKeyframe = () => {
    onClose()
    generateKeyframe(row)
  }

  const handleGenKeyframeIterative = () => {
    onClose()
    generateKeyframesIterative(row, 4)
  }

  const handleGenBeatVideo = () => {
    onClose()
    generateBeatVideo(row)
  }

  const handleGenBeatVideoMultiStrategy = () => {
    onClose()
    generateBeatVideoMultiStrategy(row, 2)
  }

  const handleRagSearch = async () => {
    onClose()
    const queries = buildRagQueries(row)
    if (!queries.art && !queries.action && !queries.camera) {
      toast.error('查 RAG 参考需要分镜描述', { description: '先在分镜表填 visual_description / action / storyboard prompt' })
      return
    }
    setRagModal({
      rowId: row.id,
      shotNumber: row.shot_number,
      loading: true,
      applying: false,
      error: null,
      generatedQueries: queries,
      groups: EMPTY_RAG_GROUPS,
      selection: { ...EMPTY_RAG_SELECTION },
      feedback: '',
    })
    try {
      const globalArtStyle = buildRagGlobalArtStyleContext()
      const queryResult = await runCapability({
        capability: 'freeform-text',
        inputs: [{ kind: 'text', text: buildRagQueryExtractionPrompt({ globalArtStyle, row }) }],
      })
      const extractedQueries = parseRagExtractedQueries(queryResult.outputs[0]?.text ?? '', queries)
      setRagModal((m) => m && m.rowId === row.id ? { ...m, generatedQueries: extractedQueries } : m)
      const [art, action, camera] = await Promise.all([
        api.artRag.search({ query: extractedQueries.art, topK: 10, outputMediaType: 'video' }),
        api.artRag.search({ query: extractedQueries.action, topK: 10, outputMediaType: 'video' }),
        api.artRag.search({ query: extractedQueries.camera, topK: 10, outputMediaType: 'video' }),
      ])
      const corpusCount = Math.min(art.corpus_count ?? 0, action.corpus_count ?? 0, camera.corpus_count ?? 0)
      if (corpusCount < 20000) {
        throw new Error(`RAG 数据库不对：当前 corpus=${corpusCount}，期望至少 20000 个视频 prompt`)
      }
      const tooFew = [
        ['美术', art.hits.length],
        ['动作', action.hits.length],
        ['镜头', camera.hits.length],
      ].filter(([, n]) => Number(n) < 10)
      if (tooFew.length > 0) {
        throw new Error(`RAG 结果不足 10 条：${tooFew.map(([name, n]) => `${name}=${n}`).join(' / ')}。请调整 query 或检查库。`)
      }
      setRagModal((m) => m && m.rowId === row.id ? {
        ...m,
        loading: false,
        generatedQueries: extractedQueries,
        groups: {
          art: art.hits,
          action: action.hits,
          camera: camera.hits,
        },
      } : m)
      toast.success(`RAG 找到参考：美术 ${art.hits.length} / 动作 ${action.hits.length} / 镜头 ${camera.hits.length}`, {
        description: `已确认视频库 ${corpusCount.toLocaleString()} 条`,
      })
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      toast.error('RAG 查询失败', { description: msg.slice(0, 200) })
      setRagModal((m) => m && m.rowId === row.id ? { ...m, loading: false, error: msg } : m)
    }
  }

  const updateRow = useStoryboardStore.getState().updateRow

  const handleSoundDesign = async () => {
    onClose()
    const db = useProjectDB.getState()
    try {
      const ctx = createMemoryContext({ llm: createCapabilityLLM() })
      const brief = await runAgentWithChatBridge(
        'sound-agent',
        soundDesignRow(
          {
            row,
            creativeBrief: db.script.creativeBrief,
            visualStyle: db.artDirection.customStyle || db.artDirection.stylePreset,
            // Right-click "音频设计" is the user explicitly asking for a
            // fresh take; overwrite any hand-edited bgm/sfx/mixing fields.
            overwrite: true,
          },
          ctx,
        ),
        { verb: 'design-row' },
      )
      updateRow(menu.rowId, brief)
      toast.success(`镜头 ${row.shot_number} 音频设计完成`, {
        description: 'BGM + SFX + mixing brief 已填入表格，可在编辑面板内调整',
      })
    } catch (e) {
      toast.error('音频设计失败', { description: String((e as Error).message).slice(0, 200) })
    }
  }

  const handleActorEnrich = async () => {
    onClose()
    const db = useProjectDB.getState()
    const castingCards = db.script.castingCards ?? []
    if (castingCards.length === 0) {
      toast.error('暂无角色卡 — 先用导演助手跑一遍剧本生成', {
        description: 'actor-agent 需要 casting cards 才能扮演角色',
      })
      return
    }
    try {
      const ctx = createMemoryContext({ llm: createCapabilityLLM() })
      const enriched = await runAgentWithChatBridge(
        'actor-agent',
        actorEnrichRow(
          {
            row,
            castingCards,
            scene: row.scene?.description
              ? { name: row.scene?.description.split(/[,，。]/)[0]?.trim(), description: row.scene.description }
              : undefined,
            creativeBrief: db.script.creativeBrief,
            visualStyle: db.artDirection.customStyle || db.artDirection.stylePreset,
          },
          ctx,
        ),
        { verb: 'enrich-row' },
      )
      updateRow(menu.rowId, enriched)
      toast.success(`镜头 ${row.shot_number} 表演已完善`)
    } catch (e) {
      toast.error('演员完善失败', { description: String((e as Error).message).slice(0, 200) })
    }
  }

  return (
    <>
    <div
      ref={ref}
      className="fixed z-[60] min-w-[180px] rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-lg py-1 text-sm"
      style={{ left: menu.x, top: menu.y }}
    >
      <MenuBtn icon={ImageIcon} label="生成 Keyframe" onClick={handleGenKeyframe} />
      <MenuBtn icon={Repeat} label="迭代生成 4 个 Keyframe (AI judge)" onClick={handleGenKeyframeIterative} />
      <MenuBtn icon={Film} label="生成 Beat Video" onClick={handleGenBeatVideo} />
      <MenuBtn icon={Layers} label="拍 2 方案 (multi-strategy)" onClick={handleGenBeatVideoMultiStrategy} />
      <MenuBtn icon={Library} label="查 RAG 美术参考" onClick={handleRagSearch} />
      <MenuBtn icon={Drama} label="演员完善表演 (actor-agent)" onClick={handleActorEnrich} />
      <MenuBtn icon={Music2} label="音频设计 BGM/SFX/混音 (sound-agent)" onClick={handleSoundDesign} />
      <div className="my-1 border-t border-zinc-800" />
      <MenuBtn icon={Plus} label="插入过渡分镜 (AI)" onClick={handleInsertTransition} />
      <div className="my-1 border-t border-zinc-800" />
      <MenuBtn icon={Trash2} label="删除分镜" onClick={handleDelete} danger />
    </div>
    {ragModal && <RagReferenceModal modal={ragModal} setModal={setRagModal} />}
    </>
  )
}

function RagReferenceModal({
  modal,
  setModal,
}: {
  modal: RagModalState
  setModal: React.Dispatch<React.SetStateAction<RagModalState | null>>
}) {
  const updateRow = useStoryboardStore.getState().updateRow
  const picked = selectedRagHits(modal.groups, modal.selection)
  const pickedCount = RAG_KINDS.reduce((sum, kind) => sum + picked[kind].length, 0)

  const toggle = (kind: RagReferenceKind, id: string) => {
    setModal((m) => m ? { ...m, selection: toggleRagSelection(m.selection, kind, id, 3) } : m)
  }

  const apply = async () => {
    const targetRow = useStoryboardStore.getState().rows.find((r) => r.id === modal.rowId)
    if (!targetRow) {
      toast.error('分镜 row 已不存在')
      setModal(null)
      return
    }
    if (pickedCount === 0 && !modal.feedback.trim()) {
      toast.error('先选参考或输入反馈', { description: '每类最多选 3 条，或者手写修改要求。' })
      return
    }
    setModal((m) => m ? { ...m, applying: true, error: null } : m)
    try {
      const prompt = buildRagRowRewritePrompt(targetRow, modal.groups, modal.selection, modal.feedback)
      const result = await runCapability({
        capability: 'freeform-text',
        inputs: [{ kind: 'text', text: prompt }],
      })
      const text = result.outputs[0]?.text ?? ''
      const patch = parseRagRowPatch(text)
      if (Object.keys(patch).length === 0) throw new Error('AI 没有返回可写入的 row 字段')
      updateRow(targetRow.id, patch)
      toast.success(`RAG 参考已改写镜头 ${targetRow.shot_number}`)
      setModal(null)
    } catch (e) {
      const msg = String((e as Error).message ?? e)
      toast.error('RAG 改写失败', { description: msg.slice(0, 200) })
      setModal((m) => m ? { ...m, applying: false, error: msg } : m)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-6">
      <div className="w-[min(1180px,96vw)] max-h-[90vh] rounded-xl border border-zinc-700 bg-zinc-950 text-zinc-100 shadow-2xl flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">RAG 参考选择 · {modal.shotNumber}</div>
            <div className="text-[11px] text-zinc-400">美术 / 动作 / 镜头各显示前 10 条，每类最多选 3 条；再用手动反馈让 AI 改写当前分镜 row。</div>
          </div>
          <button className="text-xs px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800" onClick={() => setModal(null)}>关闭</button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          <details className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" open={!modal.loading}>
            <summary className="cursor-pointer select-none text-xs font-medium text-zinc-200">
              RAG LLM 生成的 query
              <span className="ml-2 text-[10px] font-normal text-zinc-500">用于检索 art / action / camera 三个视频 prompt 桶</span>
            </summary>
            <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-2">
              {RAG_KINDS.map((kind) => (
                <div key={kind} className="rounded border border-zinc-800 bg-zinc-950/60 p-2">
                  <div className="mb-1 text-[10px] font-medium text-zinc-400">{RAG_QUERY_LABELS[kind]}</div>
                  <div className="whitespace-pre-wrap break-words text-[11px] leading-snug text-zinc-200">
                    {modal.generatedQueries[kind] || '（暂无 query）'}
                  </div>
                </div>
              ))}
            </div>
          </details>

          {modal.loading ? (
            <div className="text-sm text-zinc-400 py-10 text-center">正在检索 RAG top 10 × 3…</div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {RAG_KINDS.map((kind) => (
                <div key={kind} className="rounded-lg border border-zinc-800 bg-zinc-900/60 overflow-hidden">
                  <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
                    <span className="text-xs font-medium">{RAG_REFERENCE_LABELS[kind]}</span>
                    <span className="text-[10px] text-zinc-400">已选 {modal.selection[kind].length}/3</span>
                  </div>
                  <div className="max-h-[46vh] overflow-auto p-2 space-y-2">
                    {modal.groups[kind].length === 0 ? (
                      <div className="text-[11px] text-zinc-500 p-3">无结果</div>
                    ) : modal.groups[kind].slice(0, 10).map((hit, i) => (
                      <RagHitCard
                        key={hit.id}
                        hit={hit}
                        index={i}
                        selected={modal.selection[kind].includes(hit.id)}
                        disabled={!modal.selection[kind].includes(hit.id) && modal.selection[kind].length >= 3}
                        onToggle={() => toggle(kind, hit.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
            <label className="text-xs font-medium">手动反馈 / 修改方向</label>
            <textarea
              className="w-full min-h-[86px] text-xs rounded border border-zinc-700 bg-zinc-950 px-2 py-2 outline-none focus:border-primary resize-y"
              value={modal.feedback}
              onChange={(e) => setModal((m) => m ? { ...m, feedback: e.target.value } : m)}
              placeholder="例：参考第一个的冷色金属更衣室美术，第二个的拉链动作，但镜头更克制，避免低俗；改写 storyboard_prompts 和 motion_prompts。"
            />
            {modal.error && <div className="text-[11px] text-red-300">{modal.error}</div>}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-between">
          <div className="text-[11px] text-zinc-400">已选 {pickedCount} 条参考。AI 只会改写文案字段，不会动 keyframe/video URL。</div>
          <button
            className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            disabled={modal.loading || modal.applying}
            onClick={apply}
          >
            {modal.applying ? 'AI 改写中…' : '用所选参考 + 反馈改写 row'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RagHitCard({
  hit,
  index,
  selected,
  disabled,
  onToggle,
}: {
  hit: RagReferenceHit
  index: number
  selected: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const sim = Math.round(hit.similarity * 100)
  return (
    <button
      className={cn(
        'w-full text-left rounded border p-2 transition-colors',
        selected ? 'border-emerald-400 bg-emerald-500/10' : 'border-zinc-800 hover:border-zinc-600 bg-zinc-950/60',
        disabled && 'opacity-45 cursor-not-allowed',
      )}
      disabled={disabled}
      onClick={onToggle}
      title={hit.prompt}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] text-zinc-400">#{index + 1}</span>
        <span className="text-[10px] text-emerald-300">{sim}% 相似</span>
        {hit.source_name && <span className="text-[10px] text-zinc-500 truncate">· {hit.source_name}</span>}
      </div>
      <div className="text-[11px] leading-snug text-zinc-200 line-clamp-4">{hit.prompt}</div>
      {hit.output_media_url && (
        <a
          href={hit.output_media_url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-1 inline-block text-[10px] text-sky-300 hover:underline"
        >
          预览 {hit.output_media_type ?? 'media'}
        </a>
      )}
    </button>
  )
}

function MenuBtn({ icon: Icon, label, onClick, danger }: {
  icon: React.ElementType; label: string; onClick: () => void; danger?: boolean
}) {
  return (
    <button
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800',
        danger && 'text-red-400 hover:!bg-red-500/10',
      )}
      onClick={onClick}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  )
}
