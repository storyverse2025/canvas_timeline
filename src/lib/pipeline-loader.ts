import { useAssetStore } from '@/stores/asset-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useChatStore } from '@/stores/chat-store'

const BASE = '/testdata'

function randomPos(x: number, y: number) {
  return { x, y }
}

function addAsset(
  type: 'character' | 'scene' | 'prop' | 'keyframe',
  name: string,
  imageUrl: string | undefined,
  prompt: string | undefined,
  sourceId: string | undefined,
  pos: { x: number; y: number }
) {
  const assetId = useAssetStore.getState().addAsset({
    type, name, imageUrl, prompt, sourceId,
    status: imageUrl ? 'completed' : 'pending',
    tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: type, label: name }],
  })
  useCanvasStore.getState().addNode(assetId, pos)
  return assetId
}

// ─── Step 1: Load script_bible.json → Keyframe timeline items ───

export async function loadStep1_Script(): Promise<{ nodeCount: number; shotCount: number }> {
  const res = await fetch(`${BASE}/script_bible.json`)
  const data = await res.json()
  const timeline = useTimelineStore.getState()

  let shotCount = 0

  const beats = data.outline_beats || []
  const keyframeTrack = timeline.tracks.find((t) => t.type === 'keyframe')
    ?? (() => { timeline.initDefaultTracks(); return timeline.tracks.find((t) => t.type === 'keyframe')! })()

  let startTime = 0
  for (const beat of beats) {
    const duration = 12
    timeline.addItem(keyframeTrack.id, {
      label: `Beat ${beat.id}: ${beat.label}`,
      startTime,
      duration,
    })
    startTime += duration
    shotCount++
  }

  useChatStore.getState().addMessage('system',
    `Step 1 complete: Loaded "${data.title}" - ${shotCount} keyframe timeline items from ${beats.length} beats`)
  return { nodeCount: 0, shotCount }
}

// ─── Step 2: Load assets.json → Character, Scene, Prop assets ───

export async function loadStep2_Assets(): Promise<{ nodeCount: number }> {
  const res = await fetch(`${BASE}/assets.json`)
  const data = await res.json()
  let nodeCount = 0

  for (let i = 0; i < data.characters.length; i++) {
    const char = data.characters[i]
    addAsset('character', `${char.name} (${char.role})`,
      char.image_url ? `${BASE}/${char.image_url}` : undefined,
      char.prompt, char.id, randomPos(100, i * 200))
    nodeCount++
  }

  for (let i = 0; i < data.scenes.length; i++) {
    const scene = data.scenes[i]
    addAsset('scene', scene.name,
      scene.image_url ? `${BASE}/${scene.image_url}` : undefined,
      scene.prompt, scene.id, randomPos(350, i * 200))
    nodeCount++
  }

  for (let i = 0; i < data.props.length; i++) {
    const prop = data.props[i]
    addAsset('prop', prop.name,
      prop.image_url ? `${BASE}/${prop.image_url}` : undefined,
      prop.prompt, prop.id, randomPos(600, i * 200))
    nodeCount++
  }

  useChatStore.getState().addMessage('system',
    `Step 2 complete: ${data.characters.length} characters, ${data.scenes.length} scenes, ${data.props.length} props → ${nodeCount} assets`)
  return { nodeCount }
}

// ─── Step 3: Load storyboard.json → Keyframe assets linked to timeline ───

export async function loadStep3_Keyframes(): Promise<{ nodeCount: number }> {
  const res = await fetch(`${BASE}/storyboard.json`)
  const data = await res.json()
  const timeline = useTimelineStore.getState()
  const mapping = useMappingStore.getState()
  let nodeCount = 0

  const keyframeTrack = timeline.tracks.find((t) => t.type === 'keyframe')
  if (!keyframeTrack) {
    useChatStore.getState().addMessage('system', 'No keyframe track — run Step 1 first')
    return { nodeCount: 0 }
  }

  const frames = data.episodes[0].frames

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    const label = `KF ${frame.beat_number}: ${(frame.summary || '').slice(0, 50)}`
    const assetId = addAsset('keyframe', label,
      frame.image_url ? `${BASE}/${frame.image_url}` : undefined,
      frame.prompt, frame.id, randomPos(850, (frame.beat_number - 1) * 200))
    nodeCount++

    // Link asset to matching timeline item by beat number
    const matchItem = keyframeTrack.items.find((item) => {
      const m = item.label.match(/Beat\s*(\d+)/)
      return m && parseInt(m[1]) === frame.beat_number
    })
    if (matchItem) {
      timeline.updateItem(matchItem.id, { assetId })
      mapping.addLinkByAsset(assetId, matchItem.id, 0.9, true)
    }
  }

  useChatStore.getState().addMessage('system',
    `Step 3 complete: ${nodeCount} keyframe assets created and linked to timeline items`)
  return { nodeCount }
}

// ─── Step 4: Create BGM and dialogue timeline items ───

export async function loadStep4_Audio(): Promise<{ nodeCount: number }> {
  const timeline = useTimelineStore.getState()

  const bgmTrack = timeline.tracks.find((t) => t.type === 'bgm')
  const dialogueTrack = timeline.tracks.find((t) => t.type === 'dialogue')

  if (bgmTrack) {
    timeline.addItem(bgmTrack.id, {
      label: 'BGM - 借命一击',
      startTime: 0,
      duration: 120,
      color: '#f59e0b',
    })
  }

  const sfxBeats = [
    { beat: 2, label: 'SFX: 剑锋相撞火花', dur: 3 },
    { beat: 5, label: 'SFX: 阵纹血祭激活', dur: 5 },
    { beat: 6, label: 'SFX: 魂火爆燃', dur: 4 },
    { beat: 8, label: 'SFX: 印记碎裂', dur: 3 },
    { beat: 9, label: 'SFX: 暴雨倾盆', dur: 6 },
  ]

  if (dialogueTrack) {
    let startTime = 0
    for (const sfx of sfxBeats) {
      timeline.addItem(dialogueTrack.id, {
        label: sfx.label,
        startTime,
        duration: sfx.dur,
      })
      startTime += sfx.dur + 2
    }
  }

  useChatStore.getState().addMessage('system',
    `Step 4 complete: 1 BGM + ${sfxBeats.length} SFX timeline items created`)
  return { nodeCount: 1 + sfxBeats.length }
}

// ─── Step 5: Load shots.json → Update timeline item data ───

export async function loadStep5_VideoShots(): Promise<{ shotCount: number }> {
  const res = await fetch(`${BASE}/shots.json`)
  const data = await res.json()
  const timeline = useTimelineStore.getState()

  let shotCount = 0
  const keyframeTrack = timeline.tracks.find((t) => t.type === 'keyframe')
  if (!keyframeTrack) return { shotCount: 0 }

  const shots = data.episodes[0].shots

  for (const shotData of shots) {
    const existing = keyframeTrack.items.find((item) => {
      const m = item.label.match(/Beat\s*(\d+)/)
      return m && parseInt(m[1]) === shotData.beat_number
    })
    if (existing) {
      timeline.updateItem(existing.id, {
        data: {
          videoUrl: shotData.video_url ? `${BASE}/${shotData.video_url}` : undefined,
          description: shotData.description,
          prompt: shotData.prompt,
          qualityScore: shotData.quality_score,
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
  useAssetStore.getState().setAssets([])
  useCanvasStore.getState().clearAll()
  useTimelineStore.getState().setTracks([])
  useTimelineStore.getState().initDefaultTracks()
  useMappingStore.getState().clearLinks()
}
