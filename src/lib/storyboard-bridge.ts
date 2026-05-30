/**
 * Bridge-row orchestrator.
 *
 * Walks every adjacent pair (row[i], row[i+1]) in the storyboard table,
 * extracts the actual last frame of i's beatVideoUrl and the first frame
 * of i+1's beatVideoUrl (falling back to keyframe images, or skipping
 * frames entirely when nothing is available), asks director-agent to
 * judge whether a bridging row would smooth the cut, and inserts the
 * proposed rows back into the storyboard store.
 *
 * The new rows carry status='todo' with empty keyframeUrl / beatVideoUrl
 * so the user clicks ✨ to actually generate them — exactly the contract
 * the user asked for ("不需要生成 keyframe 或新的 video，让用户去点击生成").
 *
 * Element slots (character1/character2/scene/prop1/prop2) are resolved by
 * NAME against the asset store: the agent returns names like "Alice" and
 * this orchestrator turns them into ElementSlot { image, description,
 * nodeId } so the new row renders thumbnails in the table and the
 * subsequent keyframe-generation step has the same refs the adjacent
 * rows already use.
 */

import { useStoryboardStore } from '@/stores/storyboard-store'
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useProjectDB } from '@/stores/project-db'
import {
  generateKeyframe as directorGenerateKeyframe,
  proposeBridgeRow,
} from '@/lib/agents/director-agent'
import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'
import { extractFirstFrame, extractLastFrame } from '@/lib/video-frame'
import { getArtStyle } from '@/lib/canvas-elements'
import type {
  BridgeJudge,
  BridgeRowProposal,
  GenerateKeyframeRequest,
  KeyframeCharacterRef,
  KeyframePropRef,
  KeyframeSceneRef,
  ProposeBridgeRowRequest,
} from '@/lib/agents/director-agent'
import type { Asset } from '@/types/asset'
import type { ElementSlot, StoryboardRow } from '@/types/storyboard'

const EMPTY_SLOT: ElementSlot = { image: '', description: '', nodeId: '' }

export interface BridgeInsertion {
  /** Storyboard row id of the row the new bridge was inserted after. */
  afterRowId: string
  /** Newly-created bridge row id. */
  newRowId: string
  /** Why the agent thought a bridge was needed (shown in the toast log). */
  reason: string
  /**
   * Keyframe URL the pipeline generated for this bridge row. Populated
   * by the gpt-image-2 step that runs immediately after insertion, using
   * the prev clip's last frame + next clip's first frame as conditioning
   * references. Undefined when keyframe generation was skipped or
   * failed — the user can still click ✨ in the table to retry.
   */
  keyframeUrl?: string
  /** Surfaced when keyframe gen failed; empty string when it succeeded. */
  keyframeError?: string
}

export interface BridgePipelineProgress {
  pairIndex: number
  totalPairs: number
  prevShot: string
  nextShot: string
  judge: BridgeJudge
  inserted?: BridgeInsertion
}

export interface BridgePipelineResult {
  pairsExamined: number
  inserted: BridgeInsertion[]
  /** Free-form per-pair notes for the toast / chat log. */
  skipped: Array<{ prevShot: string; nextShot: string; reason: string }>
}

function findAssetByName(assets: Asset[], name: string | undefined): Asset | undefined {
  if (!name) return undefined
  const n = name.trim().toLowerCase()
  if (!n) return undefined
  return assets.find((a) => (a.name ?? '').trim().toLowerCase() === n)
}

function slotForAssetName(
  assets: Asset[],
  name: string | undefined,
): ElementSlot | undefined {
  const a = findAssetByName(assets, name)
  if (!a || !a.imageUrl) return undefined
  return { image: a.imageUrl, description: a.description ?? a.name, nodeId: '' }
}

/**
 * Best-effort visual frame for a given row's video position. Tries the
 * actual video frame first (CORS / decode permitting), then falls back to
 * the keyframe image, then to nothing.
 */
async function frameForRow(
  row: StoryboardRow,
  side: 'first' | 'last',
): Promise<string | undefined> {
  if (row.beatVideoUrl) {
    const url = side === 'last'
      ? await extractLastFrame(row.beatVideoUrl)
      : await extractFirstFrame(row.beatVideoUrl)
    if (url) return url
  }
  if (row.keyframeUrl) return row.keyframeUrl
  if (row.reference_image) return row.reference_image
  return undefined
}

/** Build the verb request for a single pair. */
function buildPairRequest(
  prev: StoryboardRow,
  next: StoryboardRow,
  prevLastFrameUrl: string | undefined,
  nextFirstFrameUrl: string | undefined,
  knownNames: { characters: string[]; scenes: string[]; props: string[] },
  projectMeta: { projectType?: string; projectTone?: string },
): ProposeBridgeRowRequest {
  return {
    prevRow: {
      shot_number: prev.shot_number,
      duration: prev.duration,
      visual_description: prev.visual_description,
      character_actions: prev.character_actions,
      emotion_mood: prev.emotion_mood,
      emotion_atmosphere: prev.emotion_atmosphere,
      lighting_atmosphere: prev.lighting_atmosphere,
      shot_size: prev.shot_size,
      dialogue: prev.dialogue,
      character1_name: prev.character1?.description || undefined,
      character2_name: prev.character2?.description || undefined,
      scene_name: prev.scene?.description || undefined,
    },
    nextRow: {
      shot_number: next.shot_number,
      duration: next.duration,
      visual_description: next.visual_description,
      character_actions: next.character_actions,
      emotion_mood: next.emotion_mood,
      emotion_atmosphere: next.emotion_atmosphere,
      lighting_atmosphere: next.lighting_atmosphere,
      shot_size: next.shot_size,
      dialogue: next.dialogue,
      character1_name: next.character1?.description || undefined,
      character2_name: next.character2?.description || undefined,
      scene_name: next.scene?.description || undefined,
    },
    prevLastFrameUrl,
    nextFirstFrameUrl,
    projectType: projectMeta.projectType,
    projectTone: projectMeta.projectTone,
    knownCharacterNames: knownNames.characters,
    knownSceneNames: knownNames.scenes,
    knownPropNames: knownNames.props,
  }
}

function bridgeShotNumber(prevShot: string, nextShot: string): string {
  const prevN = parseFloat((prevShot || '').replace(/[^\d.]/g, ''))
  const nextN = parseFloat((nextShot || '').replace(/[^\d.]/g, ''))
  if (Number.isFinite(prevN) && Number.isFinite(nextN)) {
    return `S${((prevN + nextN) / 2).toFixed(1)}`
  }
  return `${prevShot || '?'} → ${nextShot || '?'} 桥接`
}

/**
 * Turn a BridgeRowProposal into the row-shape the storyboard store
 * expects (StoryboardRow minus id+createdAt). Resolves slot names to
 * actual ElementSlot URLs via the asset store, fills duration to a safe
 * default, and forces empty keyframe / beatVideo / status='todo'.
 */
function proposalToStoryboardRow(
  prev: StoryboardRow,
  next: StoryboardRow,
  proposal: BridgeRowProposal,
  assets: Asset[],
): Omit<StoryboardRow, 'id' | 'createdAt'> {
  const dur = Math.min(6, Math.max(2, Number(proposal.duration) || 3))

  // Slot resolution: prefer the agent's pick by name; if it didn't pick
  // anything (or picked an unknown name), inherit the slot from prev/next
  // so the bridge thumbnail isn't a blank square. Scene falls back to
  // prev.scene; characters fall back to whoever was in prev that is
  // ALSO in next (most likely the through-line for the transition).
  const slotByName = (
    name: string,
    fallback: ElementSlot | undefined,
  ): ElementSlot => slotForAssetName(assets, name) ?? fallback ?? { ...EMPTY_SLOT }

  const inheritedScene = prev.scene && prev.scene.image
    ? prev.scene
    : next.scene && next.scene.image
      ? next.scene
      : undefined

  // Through-line characters: pick the prev character whose description
  // appears in either next.character1 or next.character2.
  const sameDesc = (a: ElementSlot | undefined, b: ElementSlot | undefined) =>
    !!a && !!b && a.description && b.description && a.description.trim() === b.description.trim()
  const carryChar1 = sameDesc(prev.character1, next.character1) || sameDesc(prev.character1, next.character2)
    ? prev.character1
    : undefined
  const carryChar2 = sameDesc(prev.character2, next.character1) || sameDesc(prev.character2, next.character2)
    ? prev.character2
    : undefined

  return {
    shot_number: proposal.shot_number || bridgeShotNumber(prev.shot_number, next.shot_number),
    duration: dur,
    status: 'todo',
    visual_description: proposal.visual_description,
    reference_image: '',
    shot_size: proposal.shot_size,
    character_actions: proposal.character_actions,
    emotion_mood: proposal.emotion_mood,
    emotion_atmosphere: proposal.emotion_atmosphere,
    character_motivation: '',
    character_psychology: '',
    performance_guidance: '',
    scene_tags: '',
    lighting_atmosphere: proposal.lighting_atmosphere,
    sound_effects: proposal.sound_effects,
    mixing_brief: '',
    dialogue: proposal.dialogue,
    storyboard_prompts: proposal.storyboard_prompts || proposal.visual_description,
    motion_prompts: proposal.motion_prompts,
    bgm: '',
    visual_anchor: proposal.visual_anchor,
    character1: slotByName(proposal.character1_name, carryChar1),
    character2: slotByName(proposal.character2_name, carryChar2),
    prop1: slotByName(proposal.prop1_name, undefined),
    prop2: slotByName(proposal.prop2_name, undefined),
    scene: slotByName(proposal.scene_name, inheritedScene),
    // Intentionally leave undefined — user clicks ✨ to fill these.
    keyframeUrl: undefined,
    beatVideoUrl: undefined,
    keyframeNodeId: undefined,
    beatVideoNodeId: undefined,
    referenceNodeId: undefined,
  }
}

/**
 * Generate a keyframe for the freshly-inserted bridge row using
 * gpt-image-2, conditioned on:
 *   - the prev clip's last frame (or its keyframe, when no video yet)
 *   - the next clip's first frame (same fallback)
 *   - whatever character / scene / prop slots the bridge row carries
 *
 * Persists the result onto the row + a fresh canvas item + image node so
 * the keyframe shows up in the table AND on the canvas (matching the
 * behavior of useStoryboardGenerate.generateKeyframe). The video step is
 * intentionally NOT triggered — that stays a user-driven ✨ click.
 *
 * Returns the keyframe URL on success, undefined on a soft failure
 * (logged + non-fatal so the bridge loop continues).
 */
async function generateBridgeKeyframe(
  rowId: string,
  prevFrameUrl: string | undefined,
  nextFrameUrl: string | undefined,
  rowIndexForLayout: number,
): Promise<string | undefined> {
  const row = useStoryboardStore.getState().rows.find((r) => r.id === rowId)
  if (!row) return undefined
  if (!row.storyboard_prompts?.trim() && !row.visual_description?.trim()) {
    return undefined
  }

  // Map slot images to the structured KeyframeCharacterRef / SceneRef / PropRef
  // shape directorGenerateKeyframe wants. We don't try to do the full
  // canvas-resolution dance the useStoryboardGenerate hook does — for a
  // bridge keyframe the slot's image URL alone is enough conditioning.
  const namedSlot = (slot: ElementSlot | undefined, role: string) => {
    if (!slot?.image) return null
    const name = slot.description?.split(/[，,。\n]/)[0]?.trim() || role
    return { name, description: slot.description, imageUrl: slot.image }
  }
  const c1 = namedSlot(row.character1, '角色1')
  const c2 = namedSlot(row.character2, '角色2')
  const sc = namedSlot(row.scene, '场景')
  const p1 = namedSlot(row.prop1, '道具1')
  const p2 = namedSlot(row.prop2, '道具2')

  const characters: KeyframeCharacterRef[] = [c1, c2]
    .filter((c): c is NonNullable<typeof c1> => !!c)
    .map((c) => ({ name: c.name, description: c.description, imageUrls: [c.imageUrl] }))
  const scene: KeyframeSceneRef | undefined = sc
    ? { name: sc.name, description: sc.description, imageUrls: [sc.imageUrl] }
    : undefined
  const props: KeyframePropRef[] = [p1, p2]
    .filter((p): p is NonNullable<typeof p1> => !!p)
    .map((p) => ({ name: p.name, description: p.description, imageUrls: [p.imageUrl] }))

  // Free-form refs[] is the right slot for the prev/next frame snapshots.
  // gpt-image-2 will see them as additional reference images alongside
  // the structured character/scene refs, and the role label tells the
  // model what they are.
  const refs: GenerateKeyframeRequest['refs'] = []
  if (prevFrameUrl) refs.push({ role: '前一镜末帧 / Prev last frame', imageUrl: prevFrameUrl })
  if (nextFrameUrl) refs.push({ role: '后一镜首帧 / Next first frame', imageUrl: nextFrameUrl })

  const db = useProjectDB.getState()
  const visualStyle = getArtStyle({
    customStyle: db.artDirection.customStyle,
    stylePreset: db.artDirection.stylePreset,
  })
  const brief = db.script.creativeBrief

  const req: GenerateKeyframeRequest = {
    row: {
      storyboard_prompts: row.storyboard_prompts,
      visual_description: row.visual_description,
      lighting_atmosphere: row.lighting_atmosphere,
      emotion_mood: row.emotion_mood,
      emotion_atmosphere: row.emotion_atmosphere,
      shot_size: row.shot_size,
      character_motivation: row.character_motivation,
      character_psychology: row.character_psychology,
      performance_guidance: row.performance_guidance,
    },
    shotDurationSeconds: Math.max(1, Math.round(row.duration ?? 3)),
    projectTitle: db.script.text?.split('\n')[0]?.slice(0, 40) || `Bridge ${row.shot_number}`,
    projectType: brief?.projectType,
    projectTone: brief?.tone,
    genre: brief?.genre,
    visualStyle,
    characters: characters.slice(0, 2),
    scene,
    props,
    refs,
    aspect: '16:9',
  }

  const agentCtx = createMemoryContext({ llm: createCapabilityLLM() })
  const result = await runAgentWithChatBridge(
    'director-agent',
    directorGenerateKeyframe(req, agentCtx),
    { verb: `bridge-keyframe ${row.shot_number}` },
  )
  const url = result.url
  if (!url) return undefined

  // Mirror the hook's canvas wiring (minimal: item + node, no edges) so
  // the keyframe shows up where the user expects it. baseY follows the
  // row's vertical position in the storyboard (matching the existing
  // useStoryboardGenerate convention of `rowIdx * 300`).
  const kfItemId = useCanvasItemStore.getState().addItem({
    kind: 'image',
    name: `KF-${row.shot_number}`,
    content: url,
    prompt: result.prompt,
    role: 'keyframe',
  })
  const kfNodeId = useCanvasStore.getState().addItemNode(
    kfItemId,
    'image',
    { x: 400, y: rowIndexForLayout * 300 },
    { width: 280, height: 180 },
  )

  useStoryboardStore.getState().updateRow(row.id, {
    keyframeUrl: url,
    reference_image: url,
    keyframeNodeId: kfNodeId,
    status: 'done',
  })

  return url
}

/**
 * Walk every adjacent pair, ask director-agent for a judgement, and
 * insert proposed rows in-place. Reports per-pair progress via onProgress.
 *
 * IMPORTANT: the loop captures the row IDs ONCE up front against the
 * snapshot we read at the start of the run. Each insertion mutates the
 * store, but we only insert AFTER the snapshot row whose id we already
 * captured — so subsequent pairs continue to refer to the original rows,
 * not to the bridges we just added. (This is the correct behavior — we
 * don't want to bridge a bridge.)
 */
export async function runBridgePipeline(
  onProgress?: (p: BridgePipelineProgress) => void,
): Promise<BridgePipelineResult> {
  const snapshot = useStoryboardStore.getState().rows.slice()
  const pairs: Array<[StoryboardRow, StoryboardRow]> = []
  for (let i = 0; i < snapshot.length - 1; i++) {
    pairs.push([snapshot[i]!, snapshot[i + 1]!])
  }

  const assets = useAssetStore.getState().assets
  const knownNames = {
    characters: assets.filter((a) => a.type === 'character').map((a) => a.name).filter(Boolean),
    scenes: assets.filter((a) => a.type === 'scene').map((a) => a.name).filter(Boolean),
    props: assets.filter((a) => a.type === 'prop').map((a) => a.name).filter(Boolean),
  }
  const projectMeta = {
    projectType: useProjectDB.getState().script.creativeBrief?.projectType,
    projectTone: useProjectDB.getState().script.creativeBrief?.tone,
  }

  const inserted: BridgeInsertion[] = []
  const skipped: BridgePipelineResult['skipped'] = []
  const agentCtx = createMemoryContext({ llm: createCapabilityLLM() })

  for (let i = 0; i < pairs.length; i++) {
    const [prev, next] = pairs[i]!
    let prevFrame: string | undefined
    let nextFrame: string | undefined
    try {
      ;[prevFrame, nextFrame] = await Promise.all([
        frameForRow(prev, 'last'),
        frameForRow(next, 'first'),
      ])
    } catch {
      // Frame extraction must never block the judgement — fall through.
    }
    const req = buildPairRequest(prev, next, prevFrame, nextFrame, knownNames, projectMeta)
    let judge: BridgeJudge
    try {
      judge = await runAgentWithChatBridge(
        'director-agent',
        proposeBridgeRow(req, agentCtx),
        { verb: `propose-bridge ${prev.shot_number ?? '?'}→${next.shot_number ?? '?'}` },
      )
    } catch (err) {
      judge = { needed: false, reason: `judge 失败: ${(err as Error).message}` }
    }

    let insertion: BridgeInsertion | undefined
    if (judge.needed && judge.bridge) {
      // Re-resolve the latest assets in case the user added something
      // between iterations of a long-running scan.
      const freshAssets = useAssetStore.getState().assets
      const rowInput = proposalToStoryboardRow(prev, next, judge.bridge, freshAssets)
      const newId = useStoryboardStore.getState().insertRowAfter(prev.id, rowInput)
      insertion = { afterRowId: prev.id, newRowId: newId, reason: judge.reason }
      // Immediately generate the bridge keyframe with gpt-image-2 using
      // prev-last-frame + next-first-frame as conditioning refs. Failures
      // here are non-fatal — the row stays insertable, the user can hit ✨
      // in the table to retry. Sequential (no Promise.all) to avoid
      // hammering gpt-image-2's rate limit across a multi-pair scan.
      try {
        // The freshly-inserted row sits at original-prev-index + 1 + i,
        // but for layout purposes we just want it visually near the prev
        // row — use the source pair index as the y bucket.
        const url = await generateBridgeKeyframe(newId, prevFrame, nextFrame, i)
        if (url) {
          insertion.keyframeUrl = url
          insertion.keyframeError = ''
        } else {
          insertion.keyframeError = 'gpt-image-2 返回空 URL'
        }
      } catch (kfErr) {
        insertion.keyframeError = (kfErr as Error).message ?? String(kfErr)
      }
      inserted.push(insertion)
    } else {
      skipped.push({
        prevShot: prev.shot_number ?? '?',
        nextShot: next.shot_number ?? '?',
        reason: judge.reason || '观感无割裂，跳过',
      })
    }

    onProgress?.({
      pairIndex: i,
      totalPairs: pairs.length,
      prevShot: prev.shot_number ?? '?',
      nextShot: next.shot_number ?? '?',
      judge,
      inserted: insertion,
    })
  }

  return { pairsExamined: pairs.length, inserted, skipped }
}
