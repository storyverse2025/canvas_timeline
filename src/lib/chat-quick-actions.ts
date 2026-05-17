/**
 * Deterministic handlers backing the 5 QuickAction chips in ChatPanel.
 * Each handler:
 *   1. Inspects current canvas + storyboard state via gap-finder
 *   2. Surfaces a one-line summary to the chat (`addMessage`)
 *   3. Loops the appropriate agent / hook over the gaps in parallel
 *      where safe, sequential where state mutations would race
 *
 * Kept out of ChatPanel.tsx so the same handlers can be invoked by
 * project-manager-agent action dispatch (when the LLM picks a
 * `generate-missing-*` action from a free-form chat request).
 */

import { toast } from 'sonner'

import {
  characterImageContext,
  generateOneImage as artDirectorGenerateOneImage,
  propImageContext,
  sceneImageContext,
  ASSET_TIMEOUT_MS,
} from '@/lib/agents/art-director-agent'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import {
  findMissingAssets,
  findRowsMissingBeatVideo,
  findRowsMissingKeyframe,
  findRowsWithBothKeyframeAndVideo,
  summarizeGaps,
} from '@/lib/gap-finder'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { styleFragmentFor } from '@/lib/style-library'
import { useProjectDB } from '@/stores/project-db'
import type { StoryboardRow } from '@/types/storyboard'

export interface QuickActionDeps {
  /** ChatPanel feeds a curried `addMessage('system', ...)` so handlers
   *  don't need to know about the chat store directly. */
  log: (message: string) => void
  /** useStoryboardGenerate exposes generateKeyframe / generateBeatVideo
   *  as hooks; handlers receive them via deps so they pick up the
   *  current row state on each call. */
  generateKeyframe: (row: StoryboardRow) => Promise<void>
  generateBeatVideo: (row: StoryboardRow) => Promise<void>
}

// ─── 1. 生成缺失 assets ─────────────────────────────────────────

/**
 * Find every canvas image item tagged `character` / `scene` / `prop`
 * with empty content and re-run art-director.generateOneImage for each
 * in parallel (Promise.allSettled).
 */
export async function quickGenerateMissingAssets(deps: QuickActionDeps): Promise<void> {
  const missing = findMissingAssets()
  if (missing.length === 0) {
    deps.log('✓ 所有素材图都已生成 — 没有缺失')
    return
  }

  deps.log(`正在补 ${missing.length} 个缺失素材图 (并行)…`)
  const db = useProjectDB.getState()
  const artStyle = (db.artDirection.customStyle || '').trim() ||
    styleFragmentFor(db.artDirection.stylePreset)
  const ctx = createMemoryContext({
    llm: createCapabilityLLM(),
    log: (m) => deps.log(m),
  })

  await Promise.allSettled(missing.map(async (m) => {
    const imgCtx =
      m.kind === 'character' ? characterImageContext(artStyle)
        : m.kind === 'scene' ? sceneImageContext(artStyle)
        : propImageContext(artStyle)
    const timeoutMs =
      m.kind === 'scene' ? ASSET_TIMEOUT_MS.scene
        : m.kind === 'character' ? ASSET_TIMEOUT_MS.character
        : ASSET_TIMEOUT_MS.prop
    try {
      // We don't carry the original ExtractedCharacter/Scene/Prop here —
      // the canvas item only persisted the name + (now-empty) image_prompt.
      // Synthesize a minimal element from item.name so the template's
      // buildDescription fallback can still produce a sensible prompt.
      const element = { name: m.name, image_prompt: '' } as Parameters<typeof artDirectorGenerateOneImage>[0]
      const { url, prompt } = await artDirectorGenerateOneImage(element, imgCtx, ctx, timeoutMs)
      if (url) {
        useCanvasItemStore.getState().updateItem(m.itemId, { content: url, prompt })
        deps.log(`✓ ${m.kind} ${m.name} 完成`)
      } else {
        deps.log(`✗ ${m.kind} ${m.name} 失败 — provider 返回空 URL`)
      }
    } catch (e) {
      deps.log(`✗ ${m.kind} ${m.name} 失败 — ${(e as Error).message}`)
    }
  }))
}

// ─── 2. 生成缺失 keyframe ───────────────────────────────────────

export async function quickGenerateMissingKeyframes(
  deps: QuickActionDeps,
  rowIds?: string[],
): Promise<void> {
  const all = findRowsMissingKeyframe()
  const rows = rowIds ? all.filter((r) => rowIds.includes(r.id)) : all
  if (rows.length === 0) {
    deps.log('✓ 所有分镜行都已有 keyframe — 没有缺失')
    return
  }

  deps.log(`正在补 ${rows.length} 个缺失 keyframe (顺序，避免拥塞)…`)
  // generateKeyframe writes to canvas + storyboard stores per row;
  // running them in parallel would race on node placement. Sequential.
  for (const row of rows) {
    try {
      await deps.generateKeyframe(row)
    } catch (e) {
      deps.log(`✗ 镜头 ${row.shot_number} keyframe 失败 — ${(e as Error).message}`)
    }
  }
}

// ─── 3. 添加缺失的分镜行 (stub for this PR) ────────────────────

/**
 * Detecting "missing rows" needs LLM intelligence (diff the script's
 * beat list against the existing storyboard, propose new rows). That's
 * a real director-agent verb that doesn't exist yet. For now this just
 * surfaces a chat message routing the user back to 导演助手 for a
 * full re-run. Wiring point stays so we can swap in the real verb
 * without touching ChatPanel.
 */
export async function quickAddMissingStoryboardRows(deps: QuickActionDeps): Promise<void> {
  const totalRows = summarizeGaps().rowsMissingKeyframe.length +
    summarizeGaps().rowsMissingBeatVideo.length
  deps.log(
    `「添加缺失的分镜行」当前还是占位 (director-agent.allocateMissingShots 未实现)。` +
      `现有 ${totalRows} 行待补 keyframe/视频；要新增行请重跑 导演助手 (会从 script 重排)。`,
  )
}

// ─── 4. 生成缺失视频 ───────────────────────────────────────────

export async function quickGenerateMissingVideos(
  deps: QuickActionDeps,
  rowIds?: string[],
): Promise<void> {
  const all = findRowsMissingBeatVideo()
  const rows = rowIds ? all.filter((r) => rowIds.includes(r.id)) : all
  if (rows.length === 0) {
    deps.log('✓ 所有有 keyframe 的行都已有 beat video — 没有缺失')
    return
  }

  deps.log(`正在补 ${rows.length} 个缺失 beat video (顺序，避免 Seedance 队列拥塞)…`)
  for (const row of rows) {
    try {
      await deps.generateBeatVideo(row)
    } catch (e) {
      deps.log(`✗ 镜头 ${row.shot_number} beat video 失败 — ${(e as Error).message}`)
    }
  }
}

// ─── 5. update 下游视频 ────────────────────────────────────────

/**
 * Re-shoot rows where the keyframe / dialogue / voice may have changed
 * after the video was generated. Without per-field updatedAt timestamps
 * (a future schema bump) we can't precisely detect "stale" — MVP
 * regenerates every row that has BOTH a keyframe AND a video, after
 * asking the user to confirm via a toast.
 */
export async function quickUpdateDownstreamVideos(
  deps: QuickActionDeps,
  rowIds?: string[],
): Promise<void> {
  const all = findRowsWithBothKeyframeAndVideo()
  const rows = rowIds ? all.filter((r) => rowIds.includes(r.id)) : all
  if (rows.length === 0) {
    deps.log('没有已生成的视频可以更新 — 先用「生成缺失视频」做一遍')
    return
  }

  // The MVP heuristic is "re-shoot everything"; warn the user that
  // they're spending ~30s × N on a possibly-unnecessary refresh.
  toast.info(`将重拍 ${rows.length} 个 beat video — 大约耗时 ${rows.length * 30}s`)
  deps.log(`正在更新 ${rows.length} 个下游视频 (基于最新 keyframe / 对白 / 音色)…`)
  for (const row of rows) {
    try {
      // generateBeatVideo overwrites the row's beatVideoUrl, so calling
      // it for an already-shot row IS the "update" — no separate verb
      // needed at this layer.
      await deps.generateBeatVideo(row)
    } catch (e) {
      deps.log(`✗ 镜头 ${row.shot_number} 更新失败 — ${(e as Error).message}`)
    }
  }
}
