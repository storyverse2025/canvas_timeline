import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useChatStore } from '@/stores/chat-store'
import type { ScriptNodeData, VisualAssetNodeData, AudioBlockNodeData } from '@/types/canvas'

const BASE = '/testdata'

// ─── Step 1: Load script_bible.json → Script nodes + Shots ───

export async function loadStep1_Script(): Promise<{ nodeCount: number; shotCount: number }> {
  const res = await fetch(`${BASE}/script_bible.json`)
  const data = await res.json()
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()

  let nodeCount = 0
  let shotCount = 0

  const ep = data.episodes[0]
  const beats = data.outline_beats || []

  // Parse script_elements to extract beat content
  const beatContents: Record<number, { narration: string; dialogues: { speaker: string; text: string }[] }> = {}
  let currentBeat = 0
  for (const el of ep.script_elements) {
    if (el.type === 'action' && el.content.includes('【Beat')) {
      const m = el.content.match(/【Beat\s*(\d+)】/)
      if (m) currentBeat = parseInt(m[1])
      if (!beatContents[currentBeat]) beatContents[currentBeat] = { narration: '', dialogues: [] }
      // Remove the beat marker prefix for narration
      beatContents[currentBeat].narration = el.content.replace(/【Beat\s*\d+】/, '').trim()
    }
    if (el.type === 'dialogue' && currentBeat > 0) {
      if (!beatContents[currentBeat]) beatContents[currentBeat] = { narration: '', dialogues: [] }
      // Find the preceding character element
      const idx = ep.script_elements.indexOf(el)
      let speaker = '旁白'
      for (let i = idx - 1; i >= 0; i--) {
        if (ep.script_elements[i].type === 'character') {
          speaker = ep.script_elements[i].content
          break
        }
      }
      beatContents[currentBeat].dialogues.push({ speaker, text: el.content })
    }
  }

  for (const beat of beats) {
    const beatNum = beat.id
    const content = beatContents[beatNum] || { narration: '', dialogues: [] }
    const shotId = timeline.addShot(`Beat ${beatNum}: ${beat.label} - ${beat.description}`, 12)
    shotCount++

    const yBase = (beatNum - 1) * 200

    // Narration node
    if (content.narration) {
      const nid = canvas.addNode('script', {
        scriptType: 'narration',
        content: content.narration.slice(0, 200),
        beatNumber: beatNum,
        tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beatNum}` }],
      } as ScriptNodeData, { x: 0, y: yBase })
      nodeCount++
      timeline.linkNodeToShot(shotId, nid)
      mapping.addLinkToShot(nid, shotId)
    }

    // Dialogue nodes
    for (let i = 0; i < content.dialogues.length; i++) {
      const dlg = content.dialogues[i]
      const did = canvas.addNode('script', {
        scriptType: 'dialogue',
        content: dlg.text,
        characterName: dlg.speaker,
        beatNumber: beatNum,
        tags: [
          { id: `t-${Date.now()}-${Math.random()}`, category: 'character', label: dlg.speaker },
          { id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beatNum}` },
        ],
      } as ScriptNodeData, { x: 300 + i * 280, y: yBase })
      nodeCount++
      timeline.linkNodeToShot(shotId, did)
      mapping.addLinkToShot(did, shotId)
    }
  }

  useChatStore.getState().addMessage('system',
    `Step 1 complete: Loaded "${data.title}" - ${shotCount} shots, ${nodeCount} script nodes from ${beats.length} beats`)
  return { nodeCount, shotCount }
}

// ─── Step 2: Load assets.json → Character, Scene, Prop nodes ───

export async function loadStep2_Assets(): Promise<{ nodeCount: number }> {
  const res = await fetch(`${BASE}/assets.json`)
  const data = await res.json()
  const canvas = useCanvasStore.getState()

  let nodeCount = 0

  // Characters
  for (let i = 0; i < data.characters.length; i++) {
    const char = data.characters[i]
    canvas.addNode('visual', {
      assetType: 'character',
      imageUrl: char.image_url ? `${BASE}/${char.image_url}` : undefined,
      label: `${char.name} (${char.role})`,
      sourceId: char.id,
      prompt: char.prompt,
      tags: [
        { id: `t-${Date.now()}-${Math.random()}`, category: 'character', label: char.name },
      ],
    } as VisualAssetNodeData, { x: 700, y: i * 250 })
    nodeCount++
  }

  // Scenes
  for (let i = 0; i < data.scenes.length; i++) {
    const scene = data.scenes[i]
    canvas.addNode('visual', {
      assetType: 'scene',
      imageUrl: scene.image_url ? `${BASE}/${scene.image_url}` : undefined,
      label: scene.name,
      sourceId: scene.id,
      prompt: scene.prompt,
      tags: [
        { id: `t-${Date.now()}-${Math.random()}`, category: 'scene', label: scene.name },
      ],
    } as VisualAssetNodeData, { x: 1000, y: i * 250 })
    nodeCount++
  }

  // Props
  for (let i = 0; i < data.props.length; i++) {
    const prop = data.props[i]
    canvas.addNode('visual', {
      assetType: 'prop',
      imageUrl: prop.image_url ? `${BASE}/${prop.image_url}` : undefined,
      label: prop.name,
      sourceId: prop.id,
      prompt: prop.prompt,
      tags: [
        { id: `t-${Date.now()}-${Math.random()}`, category: 'prop', label: prop.name },
      ],
    } as VisualAssetNodeData, { x: 1300, y: i * 250 })
    nodeCount++
  }

  useChatStore.getState().addMessage('system',
    `Step 2 complete: ${data.characters.length} characters, ${data.scenes.length} scenes, ${data.props.length} props → ${nodeCount} visual nodes`)
  return { nodeCount }
}

// ─── Step 3: Load storyboard.json → Keyframe nodes linked to shots ───

export async function loadStep3_Keyframes(): Promise<{ nodeCount: number }> {
  const res = await fetch(`${BASE}/storyboard.json`)
  const data = await res.json()
  const canvas = useCanvasStore.getState()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()

  let nodeCount = 0
  const frames = data.episodes[0].frames

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    const nid = canvas.addNode('visual', {
      assetType: 'keyframe',
      imageUrl: frame.image_url ? `${BASE}/${frame.image_url}` : undefined,
      label: `KF ${frame.beat_number}: ${frame.summary?.slice(0, 50) || ''}`,
      sourceId: frame.id,
      prompt: frame.prompt,
      tags: [
        { id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${frame.beat_number}` },
      ],
    } as VisualAssetNodeData, { x: -350, y: (frame.beat_number - 1) * 200 })
    nodeCount++

    // Link to matching shot
    const shot = timeline.shots.find((s) => {
      const m = s.label.match(/Beat\s*(\d+)/)
      return m && parseInt(m[1]) === frame.beat_number
    })
    if (shot) {
      timeline.linkNodeToShot(shot.id, nid)
      mapping.addLinkToShot(nid, shot.id)
    }
  }

  useChatStore.getState().addMessage('system',
    `Step 3 complete: ${nodeCount} keyframe nodes created and linked to timeline shots`)
  return { nodeCount }
}

// ─── Step 4: Create BGM audio node ───

export async function loadStep4_Audio(): Promise<{ nodeCount: number }> {
  const canvas = useCanvasStore.getState()

  // BGM node
  canvas.addNode('audio', {
    audioType: 'bgm',
    audioUrl: `${BASE}/output/episode_1/bgm.mp3`,
    duration: 120,
    label: 'BGM - 借命一击',
    tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'custom', label: 'BGM' }],
  } as AudioBlockNodeData, { x: -600, y: 0 })

  // SFX nodes for key beats
  const sfxBeats = [
    { beat: 2, label: 'SFX: 剑锋相撞火花', dur: 3 },
    { beat: 5, label: 'SFX: 阵纹血祭激活', dur: 5 },
    { beat: 6, label: 'SFX: 魂火爆燃', dur: 4 },
    { beat: 8, label: 'SFX: 印记碎裂', dur: 3 },
    { beat: 9, label: 'SFX: 暴雨倾盆', dur: 6 },
  ]

  for (let i = 0; i < sfxBeats.length; i++) {
    canvas.addNode('audio', {
      audioType: 'sfx',
      duration: sfxBeats[i].dur,
      label: sfxBeats[i].label,
      tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${sfxBeats[i].beat}` }],
    } as AudioBlockNodeData, { x: -600, y: 200 + i * 140 })
  }

  useChatStore.getState().addMessage('system',
    `Step 4 complete: 1 BGM + ${sfxBeats.length} SFX audio nodes created`)
  return { nodeCount: 1 + sfxBeats.length }
}

// ─── Step 5: Load shots.json → Video shot data on existing shots ───

export async function loadStep5_VideoShots(): Promise<{ shotCount: number }> {
  const res = await fetch(`${BASE}/shots.json`)
  const data = await res.json()
  const timeline = useTimelineStore.getState()

  let shotCount = 0
  const shots = data.episodes[0].shots

  for (const shotData of shots) {
    const existing = timeline.shots.find((s) => {
      const m = s.label.match(/Beat\s*(\d+)/)
      return m && parseInt(m[1]) === shotData.beat_number
    })
    if (existing) {
      // Update shot with video data
      timeline.updateShot(existing.id, {
        data: {
          videoUrl: shotData.video_url ? `${BASE}/${shotData.video_url}` : undefined,
          description: shotData.description,
          prompt: shotData.prompt,
          qualityScore: shotData.quality_score,
          toolUsed: shotData.tool_used,
          status: shotData.status,
        },
      })
      shotCount++
    }
  }

  useChatStore.getState().addMessage('system',
    `Step 5 complete: ${shotCount} video shots loaded with prompts and quality scores`)
  return { shotCount }
}

// ─── Step 6: Load edit_output.json → Final edit metadata ───

export async function loadStep6_FinalEdit(): Promise<void> {
  const res = await fetch(`${BASE}/edit_output.json`)
  const data = await res.json()

  const ep = data.episodes[0]
  const selectedVersion = ep.versions.find((v: { selected: boolean }) => v.selected)

  useChatStore.getState().addMessage('system',
    `Step 6 complete: Final video → ${ep.final_url}\n` +
    `Subtitles: ${ep.subtitles_url}\n` +
    `BGM: ${ep.bgm_url} (volume: ${ep.settings.bgm_volume})\n` +
    `Resolution: ${ep.settings.resolution}, Style: ${ep.settings.visual_style}\n` +
    `Selected version: v${selectedVersion?.version} - ${selectedVersion?.notes}`)
}

// ─── Clear all ───

export function clearAll() {
  useCanvasStore.getState().clearAll()
  useTimelineStore.getState().setShots([])
  useMappingStore.getState().clearLinks()
}
