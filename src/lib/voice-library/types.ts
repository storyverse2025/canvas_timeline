/**
 * Voice library types — catalog entries scanned out of `public/voices/`.
 *
 * The audio files themselves live under `public/voices/` (excluded from git
 * via .gitignore — ~470MB). Only this catalog + the metadata it carries is
 * checked in. Vite serves the audio at `/voices/...` and `urlPath` is the
 * URL-encoded path the browser fetches.
 */

export type VoiceGender = 'male' | 'female' | 'mixed' | 'unknown'
export type VoiceAge = 'child' | 'youth' | 'adult' | 'middle' | 'elderly' | 'unknown'

export interface VoiceEntry {
  /** Stable id derived from the relative path. Use this as the binding key. */
  id: string
  /** Filename without the trailing `-由微信公众号...收集整理` tag + extension. */
  displayName: string
  /** Path of subcategory folders the file lives in, joined by `/`. */
  collection: string
  /** URL-encoded path Vite serves the audio at, e.g. `/voices/800%2B%E9%9F%B3%E8%89%B2/.../file.mp3`. */
  urlPath: string
  /** Path on disk relative to public/voices — for scripts only, not the browser. */
  relativePath: string
  gender: VoiceGender
  age: VoiceAge
  /** Short tag list inferred from path + filename keywords (`方言`, `播报`, `角色扮演`, ...). */
  tags: string[]
  /** First ~200 chars of the spoken sample, extracted from the filename
   *  between the leading dash and the `-由微信公众号...` tag. Empty if no
   *  sample text can be parsed out. */
  sampleSnippet: string
  sizeBytes: number
}

export interface VoiceCatalog {
  /** When the scanner ran. */
  generatedAt: string
  /** Total number of voices in the catalog. */
  count: number
  /** Source root under public/. */
  publicRoot: string
  voices: VoiceEntry[]
}
