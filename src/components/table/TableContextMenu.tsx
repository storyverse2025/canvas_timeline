import { useEffect, useRef } from 'react'
import { Trash2, Plus, Wand2, Film, Image as ImageIcon, Drama, Music2, Layers } from 'lucide-react'
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
import type { StoryboardRow } from '@/types/storyboard'
import { cn } from '@/lib/utils'

export interface TableMenuState {
  rowId: string
  x: number
  y: number
}

interface Props {
  menu: TableMenuState | null
  onClose: () => void
}

export function TableContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const rows = useStoryboardStore((s) => s.rows)
  const removeRow = useStoryboardStore((s) => s.removeRow)
  const insertRowAfter = useStoryboardStore((s) => s.insertRowAfter)
  const { generateKeyframe, generateBeatVideo, generateBeatVideoMultiStrategy } = useStoryboardGenerate()

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

  if (!menu || !row) return null

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

  const handleGenBeatVideo = () => {
    onClose()
    generateBeatVideo(row)
  }

  const handleGenBeatVideoMultiStrategy = () => {
    onClose()
    generateBeatVideoMultiStrategy(row, 2)
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
    <div
      ref={ref}
      className="fixed z-[60] min-w-[180px] rounded-md border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-lg py-1 text-sm"
      style={{ left: menu.x, top: menu.y }}
    >
      <MenuBtn icon={ImageIcon} label="生成 Keyframe" onClick={handleGenKeyframe} />
      <MenuBtn icon={Film} label="生成 Beat Video" onClick={handleGenBeatVideo} />
      <MenuBtn icon={Layers} label="拍 2 方案 (multi-strategy)" onClick={handleGenBeatVideoMultiStrategy} />
      <MenuBtn icon={Drama} label="演员完善表演 (actor-agent)" onClick={handleActorEnrich} />
      <MenuBtn icon={Music2} label="音频设计 BGM/SFX/混音 (sound-agent)" onClick={handleSoundDesign} />
      <div className="my-1 border-t border-zinc-800" />
      <MenuBtn icon={Plus} label="插入过渡分镜 (AI)" onClick={handleInsertTransition} />
      <div className="my-1 border-t border-zinc-800" />
      <MenuBtn icon={Trash2} label="删除分镜" onClick={handleDelete} danger />
    </div>
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
