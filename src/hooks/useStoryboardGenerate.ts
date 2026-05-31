import { useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import { toast } from 'sonner'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useAssetStore } from '@/stores/asset-store'
import { useProjectDB } from '@/stores/project-db'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import type { StoryboardRow, ElementSlot } from '@/types/storyboard'
import type { AssetType } from '@/types/asset'
import { generateKeyframe as directorGenerateKeyframe, critiqueVideoConsistency as directorCritiqueVideo, critiqueKeyframe as directorCritiqueKeyframe, formatKeyframeFeedbackForNext } from '@/lib/agents/director-agent'
import type { CritiqueKeyframeResult } from '@/lib/agents/director-agent'
import type {
  GenerateKeyframeRequest,
  KeyframeCharacterRef,
  KeyframePropRef,
  KeyframeSceneRef,
} from '@/lib/agents/director-agent'
import { shoot as cinematographerShoot, revise as cinematographerRevise, shootMultiStrategy as cinematographerShootMultiStrategy } from '@/lib/agents/cinematographer-agent'
import type { BeatVideoContextRef } from '@/lib/agents/cinematographer-agent'
import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'
import { getArtStyle } from '@/lib/canvas-elements'
import { extractFirstFrame, extractLastFrame } from '@/lib/video-frame'

/**
 * Resolve a slot to the canvas node that should feed the keyframe.
 *
 * Priority:
 *   1. Existing canvas node referenced by `slot.nodeId`.
 *   2. Asset in the asset store whose imageUrl matches `slot.image`
 *      — if so, reuse (or create) its on-canvas AssetNode so the keyframe
 *      visibly derives from the asset node.
 *   3. Asset in the asset store whose name/description fuzzily matches the
 *      slot's text (only if the slot has no image).
 *   4. Existing image item node on the canvas with the same image content.
 *   5. Fallback: create a new image/text item node.
 *
 * Returns `{ nodeId, imageUrl }` so callers can both wire the edge and
 * collect the canonical reference image URL.
 */
function resolveSlotNode(
  slot: ElementSlot,
  preferredTypes: AssetType[],
  label: string,
  baseX: number,
  baseY: number,
): { nodeId: string; imageUrl: string } {
  const canvas = useCanvasStore.getState()
  const assetStore = useAssetStore.getState()

  // 1. Honor existing slot.nodeId if the node still exists.
  // Read the URL LIVE from whichever store actually owns the image:
  //   - asset-store (legacy upload pipeline)
  //   - canvas-item-store (art-director-agent's parallel background asset
  //     generation — items are created with content:'' and patched later
  //     as runAssetImageGenerationInBackground settles). Without this live
  //     read, a storyboard parsed BEFORE assets finished would persist
  //     slot.image:'' forever, and the keyframe call would receive an
  //     empty imageUrls[] for character/scene/prop refs.
  if (slot.nodeId) {
    const existing = canvas.nodes.find((n) => n.id === slot.nodeId)
    if (existing) {
      const assetId = existing.data?.assetId as string | undefined
      const itemId = existing.data?.itemId as string | undefined
      const itemContent = itemId
        ? useCanvasItemStore.getState().items[itemId]?.content
        : undefined
      const url = assetId
        ? assetStore.getAssetById(assetId)?.imageUrl || slot.image || itemContent
        : itemContent || slot.image
      return { nodeId: existing.id, imageUrl: url || '' }
    }
  }

  if (!slot.image && !slot.description) return { nodeId: '', imageUrl: '' }

  // 2. Match against an asset in the asset store by image URL.
  let asset = slot.image
    ? assetStore.assets.find((a) => a.imageUrl && a.imageUrl === slot.image)
    : undefined

  // 3. Fall back to name/description match (preferred kinds first).
  if (!asset && slot.description) {
    const desc = slot.description.trim().toLowerCase()
    if (desc) {
      for (const kind of preferredTypes) {
        asset = assetStore.assets.find((a) => {
          if (a.type !== kind) return false
          const n = (a.name ?? '').trim().toLowerCase()
          const d = (a.description ?? '').trim().toLowerCase()
          return (n && (desc.includes(n) || n.includes(desc))) ||
                 (d && (desc.includes(d) || d.includes(desc)))
        })
        if (asset) break
      }
    }
  }

  if (asset) {
    const existing = canvas.getNodeByAssetId(asset.id)
    if (existing) {
      return { nodeId: existing.id, imageUrl: asset.imageUrl ?? slot.image }
    }
    const nodeId = canvas.addNode(asset.id, { x: baseX, y: baseY })
    return { nodeId, imageUrl: asset.imageUrl ?? slot.image }
  }

  // 4. Look for an existing image item node with the same content.
  if (slot.image) {
    const items = useCanvasItemStore.getState().items
    for (const node of canvas.nodes) {
      const itemId = node.data?.itemId as string | undefined
      if (!itemId) continue
      const item = items[itemId]
      if (item?.kind === 'image' && item.content === slot.image) {
        return { nodeId: node.id, imageUrl: slot.image }
      }
    }
  }

  // 5. Create a new item node (image if we have one, else text).
  const kind = slot.image ? 'image' : 'text'
  const itemId = useCanvasItemStore.getState().addItem({
    kind,
    name: label,
    content: slot.image || slot.description,
  })
  const nodeId = useCanvasStore.getState().addItemNode(
    itemId, kind,
    { x: baseX, y: baseY },
    kind === 'image' ? { width: 160, height: 120 } : { width: 200, height: 100 },
  )
  return { nodeId, imageUrl: slot.image }
}

/**
 * Build the ordered list of role-bound reference images for a keyframe row.
 * Returns one entry per non-empty slot, in a stable order, so the prompt
 * labels ("image1", "image2", …) line up with the inputs array.
 */
interface SlotRef {
  role: string                 // human label, e.g. "角色1"
  description: string          // slot's text description, used in prompt
  preferredTypes: AssetType[]  // asset kinds to prefer when matching
  slotKey: 'character1' | 'character2' | 'prop1' | 'prop2' | 'scene'
  slot: ElementSlot
}

function collectSlotRefs(row: StoryboardRow): SlotRef[] {
  const slots: SlotRef[] = [
    { role: '角色1', slotKey: 'character1', slot: row.character1, preferredTypes: ['character'], description: row.character1?.description ?? '' },
    { role: '角色2', slotKey: 'character2', slot: row.character2, preferredTypes: ['character'], description: row.character2?.description ?? '' },
    { role: '道具1', slotKey: 'prop1',      slot: row.prop1,      preferredTypes: ['prop'],      description: row.prop1?.description ?? '' },
    { role: '道具2', slotKey: 'prop2',      slot: row.prop2,      preferredTypes: ['prop'],      description: row.prop2?.description ?? '' },
    { role: '场景',  slotKey: 'scene',      slot: row.scene,      preferredTypes: ['scene', 'keyframe'], description: row.scene?.description ?? '' },
  ]
  return slots.filter((s) => !!s.slot?.image || !!s.slot?.description)
}

export function useStoryboardGenerate() {
  const updateRow = useStoryboardStore((s) => s.updateRow)
  const startTask = useLibtvTasksStore((s) => s.startTask)
  const updateTask = useLibtvTasksStore((s) => s.updateTask)

  /**
   * Core keyframe-generation logic. Used by:
   *   - generateKeyframe (public, user-triggered from the table)
   *   - generateBeatVideo's privacy-block retry (programmatic, with
   *     stylizeFacesFor2D: true so faces survive Seedance's safety filter)
   *
   * Returns the new keyframe URL on success. Throws on failure. Side
   * effects: new canvas item + node (role='keyframe'), edges from refs,
   * row update so the new keyframe becomes the adopted one (⭐).
   */
  const runKeyframeGeneration = useCallback(async (
    row: StoryboardRow,
    opts: { stylizeFacesFor2D?: boolean; taskLabel?: string; feedbackNote?: string } = {},
  ): Promise<string> => {
    const taskId = uuid()
    startTask({
      id: taskId,
      nodeId: `sb-kf-${row.id}`,
      itemId: row.id,
      prompt: opts.taskLabel ?? 'Keyframe',
    })
    updateTask(taskId, { status: 'polling' })
    updateRow(row.id, { status: 'in_progress' })

    try {
      const url = await _doKeyframeGen(row, opts.stylizeFacesFor2D ?? false, opts.feedbackNote ?? '')
      updateTask(taskId, { status: 'done', resultUrl: url, resultKind: 'image' })
      return url
    } catch (e) {
      updateRow(row.id, { status: 'todo' })
      updateTask(taskId, { status: 'failed', error: String((e as Error).message ?? e) })
      throw e
    }
    // _doKeyframeGen omitted: declared later in the same scope (TDZ if listed)
    // and its identity is stable for this hook lifetime — matches the original
    // dep list before feedbackNote was threaded through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTask, updateTask, updateRow])

  const generateKeyframe = useCallback(async (row: StoryboardRow) => {
    if (!row.storyboard_prompts?.trim() && !row.visual_description?.trim()) {
      toast.error('缺少画面描述或分镜提示词')
      return
    }
    try {
      await runKeyframeGeneration(row)
      toast.success(`Keyframe ${row.shot_number} 生成完成`)
    } catch (e) {
      toast.error('Keyframe 生成失败', { description: String((e as Error).message).slice(0, 200) })
    }
  }, [runKeyframeGeneration])

  // ─── Iterative refine: N sequential keyframes with AI judge between ──
  //
  // For each iteration:
  //   1. Generate keyframe (using prev iteration's critique as feedbackNote)
  //   2. Vision LLM critiques the result against the row's intent
  //   3. Critique becomes the next iteration's feedbackNote
  //
  // Every iteration's grid + clean keyframes land on canvas next to each
  // other (same wiring as the single-shot path), so all N candidates are
  // immediately comparable. User adopts the best one via the existing
  // ⭐ flow on ImageCanvasNode. Cost = N × (2 image gen + 1 vision call).
  //
  // No early-exit: even if iteration 1 scores 10/10, we still run all N
  // so the user gets the full A/B set. Future toggle could short-circuit
  // on high score.
  const generateKeyframesIterative = useCallback(async (row: StoryboardRow, n: number = 4) => {
    if (!row.storyboard_prompts?.trim() && !row.visual_description?.trim()) {
      toast.error('缺少画面描述或分镜提示词')
      return
    }
    const clamped = Math.max(2, Math.min(6, Math.floor(n)))
    const taskId = uuid()
    startTask({ id: taskId, nodeId: `sb-kf-iter-${row.id}`, itemId: row.id, prompt: `Keyframe ×${clamped} (iterative)` })
    updateTask(taskId, { status: 'polling' })

    const candidates: Array<{ iter: number; url: string; critique: CritiqueKeyframeResult }> = []
    let feedbackNote = ''
    try {
      for (let i = 0; i < clamped; i++) {
        const iterLabel = `iter ${i + 1}/${clamped}`
        // Generate this iteration's keyframe — runKeyframeGeneration's
        // existing canvas wiring drops both grid + clean nodes for us.
        const freshRow = useStoryboardStore.getState().rows.find((r) => r.id === row.id) ?? row
        const url = await runKeyframeGeneration(freshRow, {
          taskLabel: `Keyframe (${iterLabel})`,
          feedbackNote: feedbackNote || undefined,
        })

        // Critique the clean variant when present (cleaner judging signal
        // than the multi-panel grid sheet); fall back to grid otherwise.
        const reReadRow = useStoryboardStore.getState().rows.find((r) => r.id === row.id) ?? row
        const judgeUrl = reReadRow.keyframeCleanUrl || url
        const critiqueCtx = createMemoryContext({ llm: createCapabilityLLM() })
        const critique = await runAgentWithChatBridge(
          'director-agent',
          directorCritiqueKeyframe(
            {
              keyframeUrl: judgeUrl,
              row: reReadRow,
              expected: {
                characters: [reReadRow.character1?.description, reReadRow.character2?.description]
                  .filter((d): d is string => Boolean(d?.trim())),
                scene: reReadRow.scene?.description || undefined,
                props: [reReadRow.prop1?.description, reReadRow.prop2?.description]
                  .filter((d): d is string => Boolean(d?.trim())),
              },
            },
            critiqueCtx,
          ),
          { verb: `critique-keyframe ${row.shot_number ?? '?'} ${iterLabel}` },
        )
        candidates.push({ iter: i + 1, url, critique })
        feedbackNote = formatKeyframeFeedbackForNext(critique, i + 1)
      }

      const best = [...candidates].sort((a, b) => b.critique.score - a.critique.score)[0]
      updateTask(taskId, { status: 'done', resultUrl: best?.url, resultKind: 'image' })
      const scoresLine = candidates.map((c) => `${c.iter}: ${c.critique.score}/10`).join(' · ')
      toast.success(`Keyframe ×${clamped} 迭代完成`, {
        description: `分数 ${scoresLine}. 最高分 iter ${best?.iter}（已留在画布上，点击它的 ⭐ 采用）。`,
      })
    } catch (e) {
      updateTask(taskId, { status: 'failed', error: String((e as Error).message ?? e) })
      toast.error('迭代生成失败', { description: String((e as Error).message).slice(0, 200) })
    }
  }, [runKeyframeGeneration, startTask, updateTask])

  // The actual generation body — pure side-effectful function (canvas writes,
  // row update). Kept separate from runKeyframeGeneration so the task-status
  // bookkeeping wraps it uniformly. Defined outside useCallback because it
  // doesn't capture any unstable references — it reads stores fresh inside.
  const _doKeyframeGen = useCallback(async (
    row: StoryboardRow,
    stylizeFacesFor2D: boolean,
    feedbackNote: string = '',
  ): Promise<string> => {
    // Re-instate the original generateKeyframe body, parametrized by
    // stylizeFacesFor2D so the privacy-block retry can opt in.
    void 0
    // ── BEGIN original body ──────────────────────────────────────────

    // Compute canvas placement for new nodes up front so the resolver
    // can place freshly-created asset/item nodes near the keyframe.
    const rows = useStoryboardStore.getState().rows
    const rowIdx = rows.findIndex((r) => r.id === row.id)
    const baseX = 400
    const baseY = rowIdx * 300

    // Resolve every populated slot to a real canvas node (asset node preferred),
    // collect the canonical image URL for each one. Track nodeId per imageUrl
    // so we can wire canvas edges after the agent returns.
    const slotRefs = collectSlotRefs(row)
    const offsetByKey: Record<SlotRef['slotKey'], number> = {
      character1: -140, character2: -70, prop1: 70, prop2: 140, scene: 0,
    }
    const resolved: Array<{ slotKey: SlotRef['slotKey']; role: string; description: string; nodeId: string; imageUrl: string; slot: ElementSlot }> = []
    for (const sr of slotRefs) {
      const { nodeId, imageUrl } = resolveSlotNode(
        sr.slot, sr.preferredTypes,
        `${sr.role}-${row.shot_number}`,
        baseX - 300, baseY + offsetByKey[sr.slotKey],
      )
      if (!nodeId && !imageUrl) continue
      resolved.push({ slotKey: sr.slotKey, role: sr.role, description: sr.description, nodeId, imageUrl, slot: sr.slot })
    }

    // Map resolved slots into director-agent's structured input.
    // imageUrls is an array because a single character/scene/prop may have
    // multiple reference images (three-view, multiple angles, etc.). The
    // current storyboard schema is one image per slot, so we send [url] for
    // now; the agent's API is ready for the day a slot grows to N angles.
    const characters: KeyframeCharacterRef[] = resolved
      .filter((r) => r.slotKey === 'character1' || r.slotKey === 'character2')
      .map((r) => ({
        name: r.slot.description?.split(/[，,。\n]/)[0]?.trim() || r.role,
        description: r.description,
        imageUrls: r.imageUrl ? [r.imageUrl] : [],
      }))
    const sceneSlot = resolved.find((r) => r.slotKey === 'scene')
    const scene: KeyframeSceneRef | undefined = sceneSlot
      ? {
          name: sceneSlot.slot.description?.split(/[，,。\n]/)[0]?.trim() || '场景',
          description: sceneSlot.description,
          imageUrls: sceneSlot.imageUrl ? [sceneSlot.imageUrl] : [],
        }
      : undefined
    const props: KeyframePropRef[] = resolved
      .filter((r) => r.slotKey === 'prop1' || r.slotKey === 'prop2')
      .map((r) => ({
        name: r.slot.description?.split(/[，,。\n]/)[0]?.trim() || r.role,
        description: r.description,
        imageUrls: r.imageUrl ? [r.imageUrl] : [],
      }))

    // Pull project-level metadata from the project DB for the header bar.
    // The creativeBrief carries TYPE / TONE / GENRE that script-agent
    // locked in during the dossier pass — feed them to the image model so
    // the keyframe is rendered with genre intent, not generic cinematic
    // style. visualStyle MUST be the resolved prose (via getArtStyle), not
    // the stylePreset slug — feeding "3d_arcane_painterly_hybrid" verbatim
    // to the image model is meaningless and lands every render in the
    // model's default 2D infographic look.
    const db = useProjectDB.getState()
    const artDir = db.artDirection
    const visualStyle = getArtStyle({ customStyle: artDir.customStyle, stylePreset: artDir.stylePreset })
    const brief = db.script.creativeBrief

    const req: GenerateKeyframeRequest = {
      row,
      shotDurationSeconds: Math.max(1, Math.round(row.duration ?? 5)),
      projectTitle: db.script.text?.split('\n')[0]?.slice(0, 40) || `Shot ${row.shot_number}`,
      projectType: brief?.projectType,
      projectTone: brief?.tone,
      genre: brief?.genre,
      visualStyle,
      characters: characters.slice(0, 2),
      scene,
      props,
      // DO NOT pass row.reference_image as a ref. After the first batch
      // run, reference_image holds the previously-generated keyframe
      // (line ~363 writes it back). Feeding it back creates a feedback
      // loop where the model copies last run's mistakes — characters
      // drift further from their canvas-asset references each pass.
      // The keyframe is OUTPUT, not INPUT. The asset images on the
      // canvas (resolved above into characters/scene/props) are the
      // only sources of identity.
      refs: [],
      aspect: '16:9',
      stylizeFacesFor2D,
      feedbackNote: feedbackNote || undefined,
    }

    const agentCtx = createMemoryContext({ llm: createCapabilityLLM() })
    const result = await runAgentWithChatBridge(
      'director-agent',
      directorGenerateKeyframe(req, agentCtx),
      { verb: stylizeFacesFor2D ? 'generate-keyframe (2D-stylized retry)' : 'generate-keyframe' },
    )
    const url = result.url

    // Tag with role='keyframe' so ImageCanvasNode can flag the adopted
    // one with a ⭐ badge. Each regenerate creates a NEW item (old
    // keyframes stay on the canvas), and the row's keyframeUrl is the
    // single source of truth for which item is currently adopted.
    const kfItemId = useCanvasItemStore.getState().addItem({
      kind: 'image',
      name: `KF-${row.shot_number}`,
      content: url,
      prompt: result.prompt,
      role: 'keyframe',
    })

    // Stagger regenerated keyframes horizontally so they don't stack on
    // the original (every new node would otherwise land at the same
    // (baseX, baseY) and the user would only see the topmost one — the
    // ⭐ star + privacy retry both became invisible because of this).
    // Count existing role='keyframe' items belonging to this row by name
    // match (KF-S1 etc.) and offset by (count × (width + gap)).
    const KF_WIDTH = 280
    const KF_GAP = 24
    const existingItems = useCanvasItemStore.getState().items
    const siblingCount = Object.values(existingItems).filter(
      (it) =>
        it.id !== kfItemId &&
        it.role === 'keyframe' &&
        it.name === `KF-${row.shot_number}`,
    ).length
    const kfX = baseX + siblingCount * (KF_WIDTH + KF_GAP)
    const kfNodeId = useCanvasStore.getState().addItemNode(
      kfItemId, 'image',
      { x: kfX, y: baseY },
      { width: KF_WIDTH, height: 180 },
    )

    // If director-agent returned a clean keyframe variant (single
    // cinematic frame, no panel borders — see #75), drop it on the
    // canvas right next to the grid so the user can see both. Stored
    // as a separate canvas item with role='keyframe-clean' so it's
    // distinguishable from the grid sheet and won't fight for the
    // adopted-keyframe ⭐ badge.
    let kfCleanNodeId: string | undefined
    if (result.cleanUrl) {
      const kfCleanItemId = useCanvasItemStore.getState().addItem({
        kind: 'image',
        name: `KF-${row.shot_number}-clean`,
        content: result.cleanUrl,
        prompt: result.cleanPrompt ?? result.prompt,
        role: 'keyframe-clean',
      })
      kfCleanNodeId = useCanvasStore.getState().addItemNode(
        kfCleanItemId, 'image',
        { x: kfX + KF_WIDTH + KF_GAP, y: baseY },
        { width: KF_WIDTH, height: 180 },
      )
    }

    // Wire edges from each resolved ref node into both keyframes and
    // persist the resolved nodeId back into the slot so future regens
    // reuse it. The clean keyframe shares the same ref set as the grid.
    const updatedSlots: Partial<Pick<StoryboardRow, 'character1' | 'character2' | 'prop1' | 'prop2' | 'scene'>> = {}
    for (const r of resolved) {
      if (!r.nodeId) continue
      useCanvasStore.getState().addEdge(r.nodeId, kfNodeId)
      if (kfCleanNodeId) useCanvasStore.getState().addEdge(r.nodeId, kfCleanNodeId)
      updatedSlots[r.slotKey] = { ...r.slot, nodeId: r.nodeId, image: r.imageUrl || r.slot.image }
    }

    updateRow(row.id, {
      keyframeUrl: url,
      reference_image: url,
      keyframeNodeId: kfNodeId,
      keyframeCleanUrl: result.cleanUrl,
      keyframeCleanNodeId: kfCleanNodeId,
      status: 'done',
      ...updatedSlots,
    })
    return url
  }, [updateRow])

  const generateBeatVideo = useCallback(async (row: StoryboardRow) => {
    const hasMotion = Boolean(
      row.motion_prompts?.trim() ||
        row.storyboard_prompts?.trim() ||
        row.visual_description?.trim() ||
        row.character_actions?.trim(),
    )
    if (!hasMotion && !row.keyframeUrl) {
      toast.error('缺少运动提示词或 keyframe')
      return
    }

    const taskId = uuid()
    startTask({ id: taskId, nodeId: `sb-bv-${row.id}`, itemId: row.id, prompt: 'Beat Video' })
    updateTask(taskId, { status: 'polling' })

    /** Detect Seedance's privacy-content rejection. The provider returns
     *  the literal "InputImageSensitiveContentDetected.PrivacyInformation"
     *  in the error message — we don't want to match other privacy errors
     *  by accident, so the substring check is exact. */
    const isPrivacyBlock = (msg: string): boolean =>
      msg.includes('InputImageSensitiveContentDetected.PrivacyInformation')

    /** Run cinematographer.shoot once with a specific keyframe URL.
     *  Returns the shoot result PLUS the resolved voice audio URLs that
     *  were actually shipped to Seedance as `kind: 'audio'` inputs — the
     *  caller persists these on the video canvas item so the Edit panel
     *  can show the user exactly what the model received. */
    const attemptShoot = async (
      keyframeUrl: string,
      opts: {
        invitedImageAssetIds?: string[]
        transitionFrames?: { firstFrameUrl: string; lastFrameUrl: string }
      } = {},
    ): Promise<{ url: string; prompt: string; voiceAudioUrls: string[] }> => {
      // Track what the augmenter actually attached so we can return it
      // to the caller. The cinematographer's shoot result only carries
      // prompt + url; the voice URLs are an inner-closure side-effect.
      let attachedVoiceAudioUrls: string[] = []
      const contextRefs: BeatVideoContextRef[] = []
      const pushCtx = (role: string, description: string | undefined) => {
        if (!description?.trim()) return
        contextRefs.push({ role, description })
      }
      pushCtx('角色1', row.character1?.description)
      pushCtx('角色2', row.character2?.description)
      pushCtx('道具1', row.prop1?.description)
      pushCtx('道具2', row.prop2?.description)
      pushCtx('场景', row.scene?.description)

      const db = useProjectDB.getState()
      const visualStyle = getArtStyle({ customStyle: db.artDirection.customStyle, stylePreset: db.artDirection.stylePreset })

      // actor-agent post-processor: appends per-character voice file URLs
      // + dialogue lines so Seedance sees a 音色文件 reference for every
      // character on stage. Pure no-op when there are no voice bindings.
      const castingCards = db.script.castingCards ?? []
      const voiceBindings = db.script.voiceBindings ?? {}
      // eslint-disable-next-line no-console
      console.log('[voice-debug][generateBeatVideo] snapshot before shoot', {
        shot: row.shot_number,
        castingCards: castingCards.map((c) => c.name),
        voiceBindings,
        rowCharacters: [row.character1?.description, row.character2?.description].filter(Boolean),
      })
      const promptPostProcessor = async (
        basePrompt: string,
      ): Promise<{ videoPrompt: string; voiceAudioUrls: string[] }> => {
        if (Object.keys(voiceBindings).length === 0 || castingCards.length === 0) {
          // eslint-disable-next-line no-console
          console.log('[voice-debug][generateBeatVideo] SKIP attachVoiceRefs', {
            reason: Object.keys(voiceBindings).length === 0 ? 'voiceBindings empty' : 'castingCards empty',
          })
          // User-visible: explain WHY there's no 音色N block in the prompt
          // (previous behavior was a silent skip, which left the user
          // wondering why the video had no voice references).
          if (castingCards.length === 0) {
            toast.message('Beat Video 无音色块', { description: '原因：暂无 casting cards — 跑一遍导演助手生成角色卡' })
          } else if (Object.keys(voiceBindings).length === 0) {
            toast.message('Beat Video 无音色块', { description: '原因：还没有为角色绑定音色 — 在「演员表」点「重新挑选」' })
          }
          attachedVoiceAudioUrls = []
          return { videoPrompt: basePrompt, voiceAudioUrls: [] }
        }
        try {
          const { attachVoiceRefs } = await import('@/lib/agents/actor-agent')
          const { voicePublicUrl, normalizeVoiceUrl } = await import('@/lib/voice-library')
          const subCtx = createMemoryContext({ llm: createCapabilityLLM() })
          const { driveAuto } = await import('@/lib/agents/_shared/runtime/runner')
          const augmented = await driveAuto(
            attachVoiceRefs(
              {
                videoPrompt: basePrompt,
                row,
                castingCards,
                voiceBindings,
                // Normalize so any legacy %2B-encoded urls from IDB don't 404
                // when Seedance fetches them.
                voiceUrlFor: (id) => {
                  const u = voicePublicUrl(id)
                  return u ? normalizeVoiceUrl(u) : undefined
                },
              },
              subCtx,
            ),
          )
          attachedVoiceAudioUrls = augmented.voiceAudioUrls
          return {
            videoPrompt: augmented.videoPrompt,
            voiceAudioUrls: augmented.voiceAudioUrls,
          }
        } catch (e) {
          // Augmentation must never block the shoot — fall back to the base prompt.
          // eslint-disable-next-line no-console
          console.warn('[useStoryboardGenerate] attachVoiceRefs failed, shooting without voice refs:', (e as Error).message)
          attachedVoiceAudioUrls = []
          return { videoPrompt: basePrompt, voiceAudioUrls: [] }
        }
      }

      const agentCtx = createMemoryContext({ llm: createCapabilityLLM() })
      const shootResult = await runAgentWithChatBridge(
        'cinematographer-agent',
        cinematographerShoot(
          {
            row, visualStyle, keyframeUrl, contextRefs, aspect: '16:9',
            resolution: '480p',
            promptPostProcessor,
            invitedImageAssetIds: opts.invitedImageAssetIds,
            transitionFrames: opts.transitionFrames,
          },
          agentCtx,
        ),
        { verb: opts.transitionFrames
          ? 'shoot (first-last-frame transition)'
          : opts.invitedImageAssetIds?.length
            ? 'shoot (with digital-asset whitelist)'
            : 'shoot' },
      )
      return { ...shootResult, voiceAudioUrls: attachedVoiceAudioUrls }
    }

    try {
      // Omni-reference mode (全能参考): only the keyframe goes to Seedance as
      // an image input. Character/scene/prop info threads through as TEXT
      // (contextRefs) so the model knows what to read out of the keyframe.
      //
      // Prefer keyframeCleanUrl (single cinematic frame, no panel borders)
      // over keyframeUrl (multi-panel storyboard sheet) so the grid's
      // gutters + time labels don't leak into the generated video. Falls
      // back to the grid URL for rows generated before the dual-keyframe
      // build, and finally to reference_image.
      let keyframeUrl = row.keyframeCleanUrl || row.keyframeUrl || row.reference_image || ''
      if (!keyframeUrl) {
        throw new Error('缺少 keyframe —— 先生成 keyframe 再拍摄 beat video')
      }

      // Transition routing: bridge rows generate via Seedance's first-last-
      // frame mode using their neighbors' boundary frames so the clip
      // actually animates from prev → next rather than playing as an
      // independent shot. Frame extraction is best-effort (the video may
      // not be CORS-readable) — falls back to keyframes when extraction
      // fails. If neither side has a video or keyframe, we skip transition
      // mode and let the standard omni-reference path run.
      let transitionFrames: { firstFrameUrl: string; lastFrameUrl: string } | undefined
      if (row.isTransition) {
        const allRows = useStoryboardStore.getState().rows
        const idx = allRows.findIndex((r) => r.id === row.id)
        const prev = idx > 0 ? allRows[idx - 1] : undefined
        const next = idx >= 0 && idx < allRows.length - 1 ? allRows[idx + 1] : undefined
        const frameFor = async (
          neighbor: StoryboardRow | undefined,
          side: 'first' | 'last',
        ): Promise<string | undefined> => {
          if (!neighbor) return undefined
          if (neighbor.beatVideoUrl) {
            try {
              const f = side === 'last'
                ? await extractLastFrame(neighbor.beatVideoUrl)
                : await extractFirstFrame(neighbor.beatVideoUrl)
              if (f) return f
            } catch {
              // Fall through to keyframe fallback.
            }
          }
          return neighbor.keyframeCleanUrl || neighbor.keyframeUrl || neighbor.reference_image || undefined
        }
        const [firstFrameUrl, lastFrameUrl] = await Promise.all([
          frameFor(prev, 'last'),   // prev's LAST frame = transition's FIRST frame
          frameFor(next, 'first'),  // next's FIRST frame = transition's LAST frame
        ])
        if (firstFrameUrl && lastFrameUrl) {
          transitionFrames = { firstFrameUrl, lastFrameUrl }
        } else {
          toast.message('过渡帧不可用', {
            description: '前镜或后镜既无 beat video 也无 keyframe — 回退到普通生成路径',
          })
        }
      }

      let result: { url: string; prompt: string; voiceAudioUrls: string[] }
      try {
        result = await attemptShoot(keyframeUrl, { transitionFrames })
      } catch (firstErr) {
        const msg = String((firstErr as Error).message ?? firstErr)
        if (!isPrivacyBlock(msg)) throw firstErr

        // ── Fallback 1: BytePlus digital-asset 开白 ────────────────────
        // Register each character ref image as a BytePlus digital asset.
        // Once they reach Active, reshoot the SAME keyframe with the asset
        // ids attached as invited_images. The intent: the moderator sees
        // the characters as approved/owned references and stops flagging.
        // See skills/byteplus-seedance-digital-asset-open-whitelist.
        let digitalAssetSucceeded = false
        const characterRefUrls = [row.character1?.image, row.character2?.image]
          .filter((u): u is string => Boolean(u && /^https?:\/\//i.test(u)))
        if (characterRefUrls.length > 0) {
          toast.info('Seedance 隐私检测拒绝了 keyframe — 尝试 BytePlus 数字资产开白', {
            description: `注册 ${characterRefUrls.length} 张角色参考图到 digital asset，审核通过后用 invited_images 重试`,
          })
          try {
            const { registerCharacterRefs } = await import('@/lib/byteplus-digital-asset')
            const { approved, rejected } = await registerCharacterRefs(characterRefUrls)
            if (approved.length > 0) {
              if (rejected.length > 0) {
                toast.message(
                  `数字资产部分通过 (${approved.length} 通过 / ${rejected.length} 拒绝)`,
                  { description: rejected[0]?.reason?.slice(0, 200) ?? '' },
                )
              } else {
                toast.success(`数字资产开白通过 (${approved.length} 张)`)
              }
              try {
                result = await attemptShoot(keyframeUrl, { invitedImageAssetIds: approved })
                digitalAssetSucceeded = true
              } catch (assetShootErr) {
                const assetMsg = String((assetShootErr as Error).message ?? assetShootErr)
                if (!isPrivacyBlock(assetMsg)) throw assetShootErr
                toast.warning('数字资产重试仍被隐私检测拒绝 — 回退到 2D 风格化', {
                  description: assetMsg.slice(0, 200),
                })
              }
            } else {
              toast.warning(`数字资产全部被拒 — 回退到 2D 风格化`, {
                description: rejected[0]?.reason?.slice(0, 200) ?? '',
              })
            }
          } catch (registerErr) {
            // Endpoint 401/404, ARK_API_KEY missing, BytePlus needs AK/SK, etc.
            // Don't surface as a hard error — just degrade to stylization
            // and log so the user knows why this path didn't help.
            // eslint-disable-next-line no-console
            console.warn('[useStoryboardGenerate] BytePlus digital-asset registration failed:', (registerErr as Error).message)
            toast.message('BytePlus 数字资产开白失败 — 回退到 2D 风格化', {
              description: String((registerErr as Error).message).slice(0, 200),
            })
          }
        }

        if (digitalAssetSucceeded) {
          // Skip the 2D-stylize fallback; `result` already holds the
          // successful reshoot.
        } else {
        // ── Fallback 2: 2D-stylized keyframe ──────────────────────────
        // Director re-renders the keyframe with 3DCG faces so the safety
        // filter no longer reads it as a real person. New keyframe lands
        // as its own canvas node and becomes the row's adopted ⭐.
        toast.info('Seedance 隐私检测拒绝了当前 keyframe — 让 director 重画 2D 风格化版本', {
          description: '保留原 keyframe，新版会成为表格采用的 keyframe',
        })
        const freshRow = useStoryboardStore.getState().rows.find((r) => r.id === row.id) ?? row
        const newKfUrl = await runKeyframeGeneration(freshRow, {
          stylizeFacesFor2D: true,
          taskLabel: 'Keyframe (2D-stylized for Seedance privacy retry)',
        })
        keyframeUrl = newKfUrl
        toast.info('重新拍摄 Beat Video …', { description: '使用 2D 风格化 keyframe 重试' })
        // Re-read the row in case generateKeyframe mutated other fields.
        // Reassign (don't Object.assign) — the store-backed row is frozen by Immer.
        row = useStoryboardStore.getState().rows.find((r) => r.id === row.id) ?? row
        result = await attemptShoot(keyframeUrl)
        } // end if (digitalAssetSucceeded) else
      }

      // ─── Auto-revise loop: shoot → critique → revise (max 1 retry) ─
      // director-agent's storyboard-qc vision pass compares the rendered
      // video against the row's expected casting / scene / action / style.
      // If it flags major-or-blocking issues, cinematographer.revise
      // rewrites the motion prompt addressing each note and re-shoots
      // once. All progress events (critique findings, revise plan,
      // re-roll status) surface in the chat panel via runAgentWithChat-
      // Bridge so the user can watch the loop play out.
      //
      // Silently skipped if critique itself errors (no API key, vision
      // capability rate-limited, etc.) — the user already has a usable
      // first-pass video; no need to fail the whole pipeline over a QC
      // miss. Cost guardrail: exactly one revise pass per shot.
      try {
        const critiqueCtx = createMemoryContext({ llm: createCapabilityLLM() })
        const issues = await runAgentWithChatBridge(
          'director-agent',
          directorCritiqueVideo(
            { videoUrl: result.url, expectedRow: row, keyframeUrl },
            critiqueCtx,
          ),
          { verb: `critique-video ${row.shot_number}` },
        )
        const blockers = issues.filter(
          (i) => i.severity === 'major' || i.severity === 'blocking',
        )
        if (blockers.length > 0) {
          const dbAR = useProjectDB.getState()
          const visualStyleAR = getArtStyle({
            customStyle: dbAR.artDirection.customStyle,
            stylePreset: dbAR.artDirection.stylePreset,
          })
          const reviseCtx = createMemoryContext({ llm: createCapabilityLLM() })
          const revised = await runAgentWithChatBridge(
            'cinematographer-agent',
            cinematographerRevise(
              {
                previous: {
                  url: result.url,
                  prompt: result.prompt,
                  durationSeconds: row.duration ?? 5,
                  keyframeUrl,
                  contextRefs: [],
                },
                feedback: blockers,
                row,
                visualStyle: visualStyleAR,
                keyframeUrl,
                contextRefs: [],
                aspect: '16:9',
                resolution: '480p',
              },
              reviseCtx,
            ),
            { verb: `revise ${row.shot_number}` },
          )
          result = {
            url: revised.url,
            prompt: revised.prompt,
            voiceAudioUrls: result.voiceAudioUrls,
          }
          toast.success(`Beat Video ${row.shot_number} 自动修订完成`, {
            description: `Director 发现 ${blockers.length} 处主要问题，已用 cinematographer.revise 重拍`,
          })
        }
      } catch (critiqueErr) {
        // eslint-disable-next-line no-console
        console.warn(
          '[useStoryboardGenerate] auto-revise skipped:',
          (critiqueErr as Error).message,
        )
      }

      const url = result.url

      // Create beat video node on canvas, connected to keyframe
      const rows = useStoryboardStore.getState().rows
      const rowIdx = rows.findIndex((r) => r.id === row.id)
      const baseX = 750
      const baseY = rowIdx * 300

      const finalPrompt = result.prompt
      // refImages / refAudios persist the EXACT inputs Seedance got, so
      // the Edit panel can show them — distinct from the transitive
      // canvas upstream (which includes everything that fed the keyframe
      // and confuses users into thinking those images shipped to the
      // video model).
      const vidItemId = useCanvasItemStore.getState().addItem({
        kind: 'video',
        role: 'beat-video',
        name: `BV-${row.shot_number}`,
        content: url,
        prompt: finalPrompt,
        refImages: [keyframeUrl],
        refAudios: result.voiceAudioUrls,
      })
      const vidNodeId = useCanvasStore.getState().addItemNode(
        vidItemId, 'video',
        { x: baseX, y: baseY },
        { width: 360, height: 200 },
      )

      // Connect BOTH keyframes (grid + clean) → beat video so the canvas
      // shows the full provenance: the grid sheet was used for pacing/UI
      // and the clean variant was the actual omni-reference Seedance saw.
      if (row.keyframeNodeId) {
        useCanvasStore.getState().addEdge(row.keyframeNodeId, vidNodeId)
      }
      if (row.keyframeCleanNodeId && row.keyframeCleanNodeId !== row.keyframeNodeId) {
        useCanvasStore.getState().addEdge(row.keyframeCleanNodeId, vidNodeId)
      }

      updateRow(row.id, { beatVideoUrl: url, beatVideoNodeId: vidNodeId })
      updateTask(taskId, { status: 'done', resultUrl: url, resultKind: 'video' })
      toast.success(`Beat Video ${row.shot_number} 生成完成`)
    } catch (e) {
      updateTask(taskId, { status: 'failed', error: String((e as Error).message ?? e) })
      toast.error('Beat Video 生成失败', { description: String((e as Error).message).slice(0, 200) })
      throw e
    }
  }, [updateRow, startTask, updateTask])

  const generateBeatVideoMultiStrategy = useCallback(async (row: StoryboardRow, variants: 2 | 3 = 2) => {
    const keyframeUrl = row.keyframeCleanUrl || row.keyframeUrl || row.reference_image || ''
    if (!keyframeUrl) {
      toast.error('缺少 keyframe —— 先生成 keyframe 再拍多方案')
      return
    }
    const taskId = uuid()
    startTask({ id: taskId, nodeId: `sb-bv-${row.id}`, itemId: row.id, prompt: `Beat Video × ${variants}` })
    updateTask(taskId, { status: 'polling' })
    try {
      const contextRefs: BeatVideoContextRef[] = []
      const pushCtx = (role: string, description: string | undefined) => {
        if (!description?.trim()) return
        contextRefs.push({ role, description })
      }
      pushCtx('角色1', row.character1?.description)
      pushCtx('角色2', row.character2?.description)
      pushCtx('道具1', row.prop1?.description)
      pushCtx('道具2', row.prop2?.description)
      pushCtx('场景', row.scene?.description)

      const db = useProjectDB.getState()
      const visualStyle = getArtStyle({ customStyle: db.artDirection.customStyle, stylePreset: db.artDirection.stylePreset })

      const agentCtx = createMemoryContext({ llm: createCapabilityLLM() })
      const result = await runAgentWithChatBridge(
        'cinematographer-agent',
        cinematographerShootMultiStrategy(
          {
            row, visualStyle, keyframeUrl, contextRefs,
            aspect: '16:9', resolution: '480p', variants,
          },
          agentCtx,
        ),
        { verb: `shoot-multi-strategy (${variants}×)` },
      )

      if (result.variants.length === 0) {
        throw new Error('All variants failed')
      }

      // Persist every variant as its own canvas item so the user can see them
      // side-by-side; first one becomes the row's primary beatVideoUrl. The
      // user can manually adopt a different variant by clicking it on canvas
      // (existing AdoptButton flow).
      const baseX = 600
      const rowIdx = useStoryboardStore.getState().rows.findIndex((r) => r.id === row.id)
      const baseY = Math.max(0, rowIdx) * 300
      const VIDEO_WIDTH = 280
      const VIDEO_GAP = 24

      let primaryNodeId: string | undefined
      result.variants.forEach((v, i) => {
        const itemId = useCanvasItemStore.getState().addItem({
          kind: 'video',
          name: `BV-${row.shot_number}-${v.strategyName}`,
          content: v.url,
          prompt: v.prompt,
          role: i === 0 ? 'beat-video' : 'beat-video-alternate',
        })
        const nodeId = useCanvasStore.getState().addItemNode(
          itemId, 'video',
          { x: baseX + i * (VIDEO_WIDTH + VIDEO_GAP), y: baseY },
          { width: VIDEO_WIDTH, height: 160 },
        )
        // Connect both keyframes to every variant so the canvas provenance
        // is complete for each (grid + clean → variant N).
        if (row.keyframeNodeId) {
          useCanvasStore.getState().addEdge(row.keyframeNodeId, nodeId)
        }
        if (row.keyframeCleanNodeId && row.keyframeCleanNodeId !== row.keyframeNodeId) {
          useCanvasStore.getState().addEdge(row.keyframeCleanNodeId, nodeId)
        }
        if (i === 0) primaryNodeId = nodeId
      })

      const primary = result.variants[0]!
      updateRow(row.id, {
        beatVideoUrl: primary.url,
        beatVideoNodeId: primaryNodeId,
      })
      updateTask(taskId, { status: 'done', resultUrl: primary.url, resultKind: 'video' })

      const failedNote = result.failures.length > 0
        ? ` (${result.failures.length} 个方案失败: ${result.failures.map((f) => f.strategyName).join(', ')})`
        : ''
      toast.success(
        `Beat Video ${row.shot_number} × ${result.variants.length} 方案已就绪${failedNote}`,
        {
          description: `默认选用「${primary.strategyName}」(${primary.strategyDescription})；其余方案已放在画布上，右键 → 「采用为当前」可切换`,
        },
      )
    } catch (e) {
      updateTask(taskId, { status: 'failed', error: String((e as Error).message ?? e) })
      toast.error('多方案拍摄失败', { description: String((e as Error).message).slice(0, 200) })
    }
  }, [updateRow, startTask, updateTask])

  return { generateKeyframe, generateKeyframesIterative, generateBeatVideo, generateBeatVideoMultiStrategy }
}
