/**
 * LLM-generated session title.
 *
 * Run at director-assistant start: takes the user's raw scriptText and
 * returns a 6-12 字 Chinese title that's stable enough to appear in the
 * cross-machine session picker. Persisted to `useProjectDB.script.sessionTitle`
 * so the vite-session-snapshot-plugin's `derivePreviewTitle` can prefer it
 * over the first 60 chars of script text (the prior fallback).
 *
 * Failures are non-fatal: the pipeline keeps the existing title (if any) so
 * a transient LLM hiccup doesn't blow away a previously good title.
 */

import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'
import { useProjectDB } from '@/stores/project-db'

const TITLE_SYSTEM = '你是给短视频项目起标题的资深编剧。请用 6-12 个汉字归纳剧本核心，输出一个标题。要求：直接点出剧本最尖锐的冲突或最具体的意象，避免空洞名词（"故事/旅程/世界"），避免"——"破折号花活，不要 emoji，不要书名号。只输出标题文本本身，不要任何解释、不要引号、不要 markdown。'

const TITLE_BANNED_CHARS = /[「」《》""''【】\[\]()（）]/g

/**
 * Generate (or refresh) the session title for the current project. Idempotent
 * — call at runOptimize start; if it has already been generated for this
 * scriptText (cheap content-hash check), reuse the cached title.
 */
export async function ensureSessionTitle(scriptText: string): Promise<string> {
  const trimmed = scriptText.trim()
  if (!trimmed) return useProjectDB.getState().script.sessionTitle ?? ''

  const existing = useProjectDB.getState().script.sessionTitle?.trim()
  // If we already have a non-trivial title, keep it. The user may have hand-
  // edited it, and the script text rarely changes meaningfully across re-runs.
  if (existing && existing.length >= 4 && existing.length <= 24) return existing

  const llm = createCapabilityLLM()
  let raw: string
  try {
    raw = await llm.complete(
      [{ role: 'user', content: trimmed.slice(0, 1200) }],
      { system: TITLE_SYSTEM },
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[session-title] LLM call failed; keeping existing title:', (err as Error).message)
    return existing ?? ''
  }

  // Clean: strip quotes/brackets, take first line, clamp to 12 chars.
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, '') // drop accidental code fences
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0] ?? ''
  const final = cleaned.replace(TITLE_BANNED_CHARS, '').slice(0, 14).trim()
  // Reject too-short / generic responses ("ok", "好的", "标题：xxx" with the
  // colon trick already stripped to xxx). 4 chars is the practical floor for
  // a meaningful Chinese title.
  if (final.length < 4) {
    // eslint-disable-next-line no-console
    console.warn('[session-title] LLM returned empty/short title:', raw.slice(0, 80))
    return existing ?? ''
  }

  useProjectDB.getState().updateScript({ sessionTitle: final })
  return final
}
