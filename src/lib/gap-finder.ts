/**
 * Gap-finder helpers.
 *
 * QuickActions in the chat panel deliberately don't ask the user to
 * specify which row / asset to act on — they detect what's missing and
 * loop. Each helper is a pure read against the canvas + storyboard
 * stores; the action handlers in QuickActions call these to figure out
 * what to dispatch.
 */

import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import type { CanvasItem } from '@/stores/canvas-item-store'
import type { StoryboardRow } from '@/types/storyboard'

export interface MissingAsset {
  /** 'character' / 'scene' / 'prop' from the canvas item's role tag. */
  kind: 'character' | 'scene' | 'prop'
  name: string
  itemId: string
}

/**
 * Canvas items spawned by canvas-elements.ensureElements for which the
 * art-director's background image task either never completed, returned
 * no URL, or has been cleared. content === '' is the marker.
 */
export function findMissingAssets(): MissingAsset[] {
  const items = useCanvasItemStore.getState().items
  const out: MissingAsset[] = []
  for (const item of Object.values(items)) {
    if (item.kind !== 'image') continue
    if (item.content.trim()) continue
    if (item.role === 'character' || item.role === 'scene' || item.role === 'prop') {
      out.push({ kind: item.role, name: item.name, itemId: item.id })
    }
  }
  return out
}

/** Storyboard rows that have no keyframe rendered yet. */
export function findRowsMissingKeyframe(): StoryboardRow[] {
  return useStoryboardStore
    .getState()
    .rows.filter((r) => !(r.keyframeUrl ?? '').trim())
}

/**
 * Rows that have a keyframe but no beat video. These are the rows
 * "ready to shoot" — the second click of the production pipeline.
 */
export function findRowsMissingBeatVideo(): StoryboardRow[] {
  return useStoryboardStore
    .getState()
    .rows.filter((r) => Boolean((r.keyframeUrl ?? '').trim()) && !(r.beatVideoUrl ?? '').trim())
}

/**
 * Rows with both a keyframe AND a beat video — candidates for
 * downstream re-shoot when the keyframe / dialogue / voice changed
 * after the video was generated. Without per-field timestamps the
 * MVP returns ALL such rows; the caller asks the user to confirm
 * before re-shooting (the operation costs ~30s × N).
 */
export function findRowsWithBothKeyframeAndVideo(): StoryboardRow[] {
  return useStoryboardStore
    .getState()
    .rows.filter((r) => Boolean((r.keyframeUrl ?? '').trim()) && Boolean((r.beatVideoUrl ?? '').trim()))
}

/**
 * Aggregate summary the project-manager-agent and the chat panel both
 * use to decide what to surface. Lightweight enough to call on every
 * render (no LLM, no network).
 */
export interface ProjectGapSummary {
  missingAssets: MissingAsset[]
  rowsMissingKeyframe: StoryboardRow[]
  rowsMissingBeatVideo: StoryboardRow[]
  rowsWithBothKeyframeAndVideo: StoryboardRow[]
  /** Approximate "what's the next reasonable action" — derived from the
   *  counts above. Used by the PM agent to weight its plan choices. */
  nextSuggestion:
    | 'run-director-assistant' // nothing exists yet
    | 'generate-missing-assets'
    | 'generate-missing-keyframes'
    | 'generate-missing-videos'
    | 'idle' // everything looks done
}

export function summarizeGaps(): ProjectGapSummary {
  const missingAssets = findMissingAssets()
  const rowsMissingKeyframe = findRowsMissingKeyframe()
  const rowsMissingBeatVideo = findRowsMissingBeatVideo()
  const rowsWithBothKeyframeAndVideo = findRowsWithBothKeyframeAndVideo()
  const allRows = useStoryboardStore.getState().rows

  let nextSuggestion: ProjectGapSummary['nextSuggestion'] = 'idle'
  if (allRows.length === 0) nextSuggestion = 'run-director-assistant'
  else if (missingAssets.length > 0) nextSuggestion = 'generate-missing-assets'
  else if (rowsMissingKeyframe.length > 0) nextSuggestion = 'generate-missing-keyframes'
  else if (rowsMissingBeatVideo.length > 0) nextSuggestion = 'generate-missing-videos'

  return {
    missingAssets,
    rowsMissingKeyframe,
    rowsMissingBeatVideo,
    rowsWithBothKeyframeAndVideo,
    nextSuggestion,
  }
}

// Re-export for callers that want a typed reference without pulling
// canvas-item-store directly.
export type { CanvasItem }
