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
import { generateKeyframe as directorGenerateKeyframe } from '@/lib/agents/director-agent'
import type {
  GenerateKeyframeRequest,
  KeyframeCharacterRef,
  KeyframePropRef,
  KeyframeSceneRef,
} from '@/lib/agents/director-agent'
import { shoot as cinematographerShoot } from '@/lib/agents/cinematographer-agent'
import type { BeatVideoContextRef } from '@/lib/agents/cinematographer-agent'
import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'

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
    opts: { stylizeFacesFor2D?: boolean; taskLabel?: string } = {},
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
      const url = await _doKeyframeGen(row, opts.stylizeFacesFor2D ?? false)
      updateTask(taskId, { status: 'done', resultUrl: url, resultKind: 'image' })
      return url
    } catch (e) {
      updateRow(row.id, { status: 'todo' })
      updateTask(taskId, { status: 'failed', error: String((e as Error).message ?? e) })
      throw e
    }
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

  // The actual generation body — pure side-effectful function (canvas writes,
  // row update). Kept separate from runKeyframeGeneration so the task-status
  // bookkeeping wraps it uniformly. Defined outside useCallback because it
  // doesn't capture any unstable references — it reads stores fresh inside.
  const _doKeyframeGen = useCallback(async (
    row: StoryboardRow,
    stylizeFacesFor2D: boolean,
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
    // locked in during the dossier pass — feed them to gpt-image-2 so the
    // keyframe is rendered with genre intent, not generic cinematic style.
    const db = useProjectDB.getState()
    const artDir = db.artDirection
    const visualStyle = artDir.customStyle || artDir.stylePreset
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
      refs: row.reference_image && !resolved.some((r) => r.imageUrl === row.reference_image)
        ? [{ role: '参考 / Prior reference', imageUrl: row.reference_image }]
        : [],
      aspect: '16:9',
      stylizeFacesFor2D,
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

    // Wire edges from each resolved ref node into the keyframe and persist
    // the resolved nodeId back into the slot so future regens reuse it.
    const updatedSlots: Partial<Pick<StoryboardRow, 'character1' | 'character2' | 'prop1' | 'prop2' | 'scene'>> = {}
    for (const r of resolved) {
      if (!r.nodeId) continue
      useCanvasStore.getState().addEdge(r.nodeId, kfNodeId)
      updatedSlots[r.slotKey] = { ...r.slot, nodeId: r.nodeId, image: r.imageUrl || r.slot.image }
    }

    updateRow(row.id, {
      keyframeUrl: url,
      reference_image: url,
      keyframeNodeId: kfNodeId,
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
      const visualStyle = db.artDirection.customStyle || db.artDirection.stylePreset

      // actor-agent post-processor: appends per-character voice file URLs
      // + dialogue lines so Seedance sees a 音色文件 reference for every
      // character on stage. Pure no-op when there are no voice bindings.
      const castingCards = db.script.castingCards ?? []
      const voiceBindings = db.script.voiceBindings ?? {}
      const promptPostProcessor = async (
        basePrompt: string,
      ): Promise<{ videoPrompt: string; voiceAudioUrls: string[] }> => {
        if (Object.keys(voiceBindings).length === 0 || castingCards.length === 0) {
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
          { row, visualStyle, keyframeUrl, contextRefs, aspect: '16:9', promptPostProcessor },
          agentCtx,
        ),
        { verb: 'shoot' },
      )
      return { ...shootResult, voiceAudioUrls: attachedVoiceAudioUrls }
    }

    try {
      // Omni-reference mode (全能参考): only the keyframe goes to Seedance as
      // an image input. Character/scene/prop info threads through as TEXT
      // (contextRefs) so the model knows what to read out of the keyframe.
      let keyframeUrl = row.keyframeUrl || row.reference_image || ''
      if (!keyframeUrl) {
        throw new Error('缺少 keyframe —— 先生成 keyframe 再拍摄 beat video')
      }

      let result: { url: string; prompt: string; voiceAudioUrls: string[] }
      try {
        result = await attemptShoot(keyframeUrl)
      } catch (firstErr) {
        const msg = String((firstErr as Error).message ?? firstErr)
        if (!isPrivacyBlock(msg)) throw firstErr

        // Seedance flagged the keyframe as containing real-person privacy
        // content. Ask director-agent to render a 2D-stylized keyframe
        // (faces no longer trip the safety filter) and reshoot from that.
        // The new keyframe lands as its own canvas node (kept alongside
        // the original) and becomes the row's adopted ⭐ keyframe.
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
        const retryRow = useStoryboardStore.getState().rows.find((r) => r.id === row.id) ?? row
        Object.assign(row, retryRow)
        result = await attemptShoot(keyframeUrl)
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

      // Connect keyframe → beat video
      if (row.keyframeNodeId) {
        useCanvasStore.getState().addEdge(row.keyframeNodeId, vidNodeId)
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

  return { generateKeyframe, generateBeatVideo }
}
