/**
 * Pre-hydrate cleaner: scan EVERY IDB key for inline `data:image/...`,
 * `data:video/...`, `data:audio/...` base64 URLs and migrate them to
 * `/uploads/<uuid>.<ext>` paths BEFORE Zustand rehydrates.
 *
 * Why this runs at the IDB raw-string layer (not schema-aware):
 * a single bloated store can be hundreds of MB (storyboard-store hit
 * 147 MB in the field). Parsing that via JSON.parse blows past 4 GB
 * V8 heap on its own — schema-aware cleaning is too late.
 *
 * String-level regex replacement keeps the peak allocation roughly
 * equal to the source string length: one IDB read + a single Set of
 * unique data URL strings + the rewritten output. Crucially we never
 * have BOTH a 147 MB string AND its JSON.parse'd object in heap
 * simultaneously.
 *
 * Incident root cause (May 2026): user's IDB held
 *   storyboard-store    147 MB ⚠️
 *   timeline-store-v2    40 MB ⚠️
 *   canvas-item-store    41 KB
 * Earlier passes only cleaned canvas-item-store (4 inline 4K PNGs →
 * /uploads/), but the storyboard rows had keyframeUrl / scene.image
 * / beatVideoUrl fields ALSO holding base64 — the user generated
 * those over many sessions and the migration code in
 * data-url-migration.ts never covered storyboard.
 */

import { markNextPushAllowShrink } from '@/lib/session-backup'

const DB_NAME = 'canvas-timeline-store'
const STORE = 'kv'

// Any key bigger than this gets a ⚠️ in the size report.
const SIZE_WARN_BYTES = 5 * 1024 * 1024

// Data URLs shorter than this aren't worth the upload round-trip
// (tiny SVGs, 1×1 transparent pixels, icons). Filters out noise.
const INLINE_LEN_THRESHOLD = 1000

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
  })
}

function idbGet(db: IDBDatabase, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readonly')
      const r = t.objectStore(STORE).get(key)
      r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

function idbPut(db: IDBDatabase, key: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite')
      let ok = false
      const r = t.objectStore(STORE).put(value, key)
      r.onsuccess = () => { ok = true }
      r.onerror = () => resolve(false)
      t.oncomplete = () => resolve(ok)
      t.onabort = () => resolve(false)
      t.onerror = () => resolve(false)
    } catch { resolve(false) }
  })
}

function listKeys(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readonly')
      const r = t.objectStore(STORE).getAllKeys()
      r.onsuccess = () => resolve(Array.from(r.result as IDBValidKey[]).map(String))
      r.onerror = () => resolve([])
    } catch { resolve([]) }
  })
}

async function uploadDataUrl(dataUrl: string, filename: string): Promise<string> {
  const res = await fetch('/uploads/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, filename }),
  })
  if (!res.ok) throw new Error(`/uploads/save HTTP ${res.status}`)
  const j = (await res.json()) as { url?: string; error?: string }
  if (!j.url) throw new Error(j.error ?? 'no url returned')
  return j.url
}

interface PerStoreResult {
  key: string
  bytesBefore: number
  bytesAfter: number
  migrated: number
  failed: number
}

interface CleanResult {
  scanned: number
  migrated: number
  bytesFreed: number
  failed: number
  perStore: PerStoreResult[]
}

// All the prefixes of base64-encoded media URLs we know how to migrate.
// JSON encodes the leading `"` of a string verbatim, and base64 alphabet
// has no characters that need JSON-string escaping, so a literal indexOf
// scan finds these reliably without any regex.
const DATA_URL_QUOTED_PREFIXES = ['"data:image/', '"data:video/', '"data:audio/'] as const

/**
 * Find the next opening `"data:image|video|audio/` quoted-string start
 * in `raw` at or after `from`. Returns -1 if none.
 *
 * Pure indexOf — no regex. We saw V8's regex engine blow the call
 * stack on 147 MB inputs with multi-MB base64 quantifier matches
 * (`{1000,}` over `[A-Za-z0-9+/=]`). indexOf is O(N) iterative and
 * has no such failure mode.
 */
function findNextDataUrlStart(raw: string, from: number): number {
  let best = -1
  for (const prefix of DATA_URL_QUOTED_PREFIXES) {
    const i = raw.indexOf(prefix, from)
    if (i !== -1 && (best === -1 || i < best)) best = i
  }
  return best
}

/**
 * Walk `raw` and collect every unique inline base64 data URL bigger
 * than INLINE_LEN_THRESHOLD chars. Caller passes the result to the
 * uploader.
 */
function extractDataUrls(raw: string): Set<string> {
  const out = new Set<string>()
  let pos = 0
  while (pos < raw.length) {
    const start = findNextDataUrlStart(raw, pos)
    if (start === -1) break
    // start points at the opening `"` of the quoted JSON string.
    const contentStart = start + 1
    // Find the closing `"`. Base64 chars don't include `"` so a plain
    // indexOf gives us the right boundary in O(N).
    const contentEnd = raw.indexOf('"', contentStart)
    if (contentEnd === -1) break
    const dataUrl = raw.substring(contentStart, contentEnd)
    if (dataUrl.length >= INLINE_LEN_THRESHOLD && dataUrl.includes(';base64,')) {
      out.add(dataUrl)
    }
    pos = contentEnd + 1
  }
  return out
}

/**
 * One-pass rewrite: emit `raw` to a string array, substituting any
 * data URL that has a replacement entry. Skipping the .split()/.join()
 * approach because that ran a separate full scan per replaced URL
 * (O(N×M)) and built throwaway arrays each pass.
 */
function rewriteWithReplacements(raw: string, replacements: Map<string, string>): string {
  const parts: string[] = []
  let pos = 0
  while (pos < raw.length) {
    const start = findNextDataUrlStart(raw, pos)
    if (start === -1) {
      parts.push(raw.substring(pos))
      break
    }
    // Emit everything up to and including the opening quote.
    parts.push(raw.substring(pos, start + 1))
    const contentStart = start + 1
    const contentEnd = raw.indexOf('"', contentStart)
    if (contentEnd === -1) {
      // Unterminated — emit the rest as-is and bail.
      parts.push(raw.substring(contentStart))
      break
    }
    const dataUrl = raw.substring(contentStart, contentEnd)
    const replacement = replacements.get(dataUrl)
    parts.push(replacement ?? dataUrl)
    parts.push('"') // closing quote
    pos = contentEnd + 1
  }
  return parts.join('')
}

async function cleanOneStore(db: IDBDatabase, key: string): Promise<PerStoreResult> {
  const raw = await idbGet(db, key)
  if (!raw) return { key, bytesBefore: 0, bytesAfter: 0, migrated: 0, failed: 0 }
  const bytesBefore = raw.length

  // Fast pre-check: avoid the regex run if the string doesn't even
  // contain the substring. Skips the typical case (clean store) at
  // near-zero cost.
  if (!raw.includes('data:image/') && !raw.includes('data:video/') && !raw.includes('data:audio/')) {
    return { key, bytesBefore, bytesAfter: bytesBefore, migrated: 0, failed: 0 }
  }

  const urls = extractDataUrls(raw)
  if (urls.size === 0) {
    return { key, bytesBefore, bytesAfter: bytesBefore, migrated: 0, failed: 0 }
  }

  // eslint-disable-next-line no-console
  console.log(`[pre-hydrate-clean] ${key}: found ${urls.size} unique data URL(s), uploading…`)

  // Sequential uploads — concurrent would hold N × multi-MB POST bodies
  // in heap simultaneously, exactly what we're trying to avoid here.
  // A 1 MB POST takes ~50ms locally so 30 sequential uploads finish
  // in ~1.5s. Trade UX latency for not blowing the page during cleanup.
  const replacement = new Map<string, string>()
  let failed = 0
  let idx = 0
  for (const dataUrl of urls) {
    try {
      const url = await uploadDataUrl(dataUrl, `${key}-${idx++}`)
      replacement.set(dataUrl, url)
    } catch (e) {
      failed++
      // eslint-disable-next-line no-console
      console.warn(`[pre-hydrate-clean] upload failed in ${key}:`, (e as Error).message)
    }
  }

  if (replacement.size === 0) {
    return { key, bytesBefore, bytesAfter: bytesBefore, migrated: 0, failed }
  }

  // Single-pass rewrite via indexOf scanning — see comments on
  // rewriteWithReplacements. The previous split/join approach was
  // O(N×M) and also kept the original 147 MB string alive while
  // building 30 throwaway arrays of substrings, doubling peak heap.
  const cleaned = rewriteWithReplacements(raw, replacement)

  const ok = await idbPut(db, key, cleaned)

  // Verify the write actually persisted. We've seen timeline-store-v2
  // reappear at 40 MB minutes after a confirmed clean — almost
  // certainly Zustand's persist middleware writing the in-memory
  // state back. This readback at least tells us whether the IDB
  // commit itself was real.
  const verify = await idbGet(db, key)
  const verifiedLen = verify?.length ?? 0
  const verifyOk = verifiedLen === cleaned.length
  // eslint-disable-next-line no-console
  console.log(
    `[pre-hydrate-clean] ${key}: ${(bytesBefore / 1024).toFixed(0)}KB → ${(cleaned.length / 1024).toFixed(0)}KB ` +
    `(migrated ${replacement.size}, failed ${failed}, idb-write ${ok ? 'ok' : 'FAILED'}, ` +
    `verify ${verifyOk ? 'ok' : `MISMATCH actual=${(verifiedLen / 1024).toFixed(0)}KB`})`,
  )

  return {
    key,
    bytesBefore,
    bytesAfter: cleaned.length,
    migrated: replacement.size,
    failed,
  }
}

export async function preHydrateCleanIdb(): Promise<CleanResult> {
  const db = await openDb()
  if (!db) return { scanned: 0, migrated: 0, bytesFreed: 0, failed: 0, perStore: [] }

  // Size diagnostic across every IDB key — surfaces unexpected hogs
  // (chat-store growing to 50 MB+, etc.) without touching them.
  const allKeys = await listKeys(db)
  const sizes: { key: string; bytes: number }[] = []
  for (const k of allKeys) {
    const v = await idbGet(db, k)
    sizes.push({ key: k, bytes: v?.length ?? 0 })
  }
  sizes.sort((a, b) => b.bytes - a.bytes)
  // eslint-disable-next-line no-console
  console.log('[pre-hydrate-clean] IDB key sizes:\n' + sizes.map((s) =>
    `  ${(s.bytes / 1024).toFixed(0).padStart(7)}KB  ${s.key}` +
    (s.bytes > SIZE_WARN_BYTES ? ' ⚠️ large' : '')
  ).join('\n'))

  // Clean every key. The per-key fast-path on lines above bails out
  // instantly if a store has no inline data URLs — net cost is ~one
  // substring check per clean store.
  //
  // Per-store try/catch is critical: a single store failing to clean
  // must NOT abort the rest. Previous version threw on storyboard-
  // store (regex stack overflow) and silently left timeline-store-v2
  // unscanned, so Zustand still loaded 40 MB after, OOM-crashed the
  // renderer.
  const perStore: PerStoreResult[] = []
  let migrated = 0
  let failed = 0
  let bytesFreed = 0
  let scanned = 0
  for (const { key } of sizes) {
    try {
      const r = await cleanOneStore(db, key)
      perStore.push(r)
      scanned++
      migrated += r.migrated
      failed += r.failed
      bytesFreed += r.bytesBefore - r.bytesAfter
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[pre-hydrate-clean] ${key} cleanup threw, leaving as-is:`, (e as Error).message)
      failed++
      perStore.push({ key, bytesBefore: 0, bytesAfter: 0, migrated: 0, failed: 1 })
    }
  }

  // If we shrunk anything significantly, the next auto-push would
  // get rejected by the server's shrink-overwrite guard (designed to
  // prevent a 1-row partial-hydrate from clobbering a 50 MB good
  // snapshot). Mark the next push as legitimate shrink.
  if (bytesFreed > 100 * 1024) {
    try { markNextPushAllowShrink() } catch { /* best effort */ }
  }

  return { scanned, migrated, bytesFreed, failed, perStore }
}
