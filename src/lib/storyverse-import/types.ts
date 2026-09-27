/**
 * Wire types for the StoryVerse project importer.
 *
 * The server half lives in `vite-storyverse-plugin.ts`, which reads the
 * production StoryVerse Supabase database READ-ONLY (GET against PostgREST +
 * Storage, never a write) and localizes private-bucket images into
 * `public/uploads/`. These types describe exactly what crosses that boundary.
 */

export interface SvProjectSummary {
  id: string
  title: string
  status: string
  /** ISO timestamp — the list is sorted by this (活跃时间), newest first. */
  updatedAt: string
  createdAt: string
  coverImageUrl: string
  episodes: number
  /** Storyboard frame rows. */
  frames: number
  /** How many of those frames actually have a rendered image. */
  frameImages: number
  /** Shot rows. */
  shots: number
  /** How many of those shots actually have a video. */
  shotVideos: number
  assets: number
}

export interface SvProjectListResponse {
  projects: SvProjectSummary[]
  total: number | null
  limit: number
  offset: number
}

/** One character / environment / property from the project's asset library. */
export interface SvAsset {
  id: string
  /** 'character' | 'environment' | 'property' upstream; kept loose on purpose. */
  category: string
  name: string
  /** The canonical image prompt that produced this asset. */
  prompt: string
  /** In-bucket object path — the join key for a frame's reference images. */
  storagePath: string
  /** `/uploads/...` after localization; may fall back to a legacy remote URL. */
  imageUrl: string
}

/** One storyboard frame joined with its shot (the video half of the beat). */
export interface SvRow {
  frameId: string
  shotId: string
  episodeNumber: number
  episodeTitle: string
  frameNumber: number
  shotType: string
  description: string
  /** Storyboard image prompt — carries the `[REFERENCES]` block we parse. */
  framePrompt: string
  /** Video / motion prompt from the shot. */
  shotPrompt: string
  displayPrompt: string
  dialogue: string
  durationSeconds: number
  /** Localized `/uploads/...` storyboard frame image (may be ''). */
  keyframeUrl: string
  /** Beat video — a long-lived signed URL unless localizeVideos was set. */
  videoUrl: string
  /**
   * This frame's reference images, index-aligned with the upstream
   * `reference_image_urls` array — `(image3)` in the prompt's `[REFERENCES]`
   * block is `references[2]`.
   *
   * `url` is always usable (localized, or the stored signed URL as a fallback),
   * even when `assetId` is empty or the image is a superseded asset version.
   * That matters: 13% of upstream references point at a version that is no
   * longer the asset's active one, and resolving those through the asset
   * library alone drops them.
   */
  references: SvReference[]
}

export interface SvReference {
  /** In-bucket object path; '' if the stored URL wasn't a bucket URL. */
  path: string
  /** `/uploads/...`, or the original signed URL if localization failed. */
  url: string
  /** Asset this image belongs to, matched across ALL versions; '' if unknown. */
  assetId: string
  assetName: string
  assetCategory: string
  /** False when this is a superseded version of the asset. */
  isActiveVersion: boolean
}

export interface SvEpisode {
  id: string
  number: number
  title: string
  summary: string
  /** Screenplay text, if the episode has one. */
  script: string
}

export interface SvBundle {
  project: { id: string; title: string; status: string; updatedAt: string }
  episodes: SvEpisode[]
  assets: SvAsset[]
  rows: SvRow[]
  stats: { localizedFiles: number; videosLocalized: boolean; elapsedMs: number }
}
