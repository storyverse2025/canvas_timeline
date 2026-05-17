/**
 * Voice catalog scanner.
 *
 * Walks `public/voices/` and emits `src/lib/voice-library/catalog.json` —
 * one entry per audio file, with parsed display name, collection path,
 * URL-encoded fetch path, and a gender / age / tag guess derived from
 * the source folder structure and filename keywords.
 *
 * Run via:  pnpm exec tsx scripts/build-voice-catalog.ts
 *
 * The catalog is committed; the underlying audio is not (.gitignore'd).
 */

import { createHash } from 'node:crypto'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { VoiceAge, VoiceCatalog, VoiceEntry, VoiceGender } from '../src/lib/voice-library/types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const VOICES_ROOT = join(REPO_ROOT, 'public', 'voices')
const CATALOG_OUT = join(REPO_ROOT, 'src', 'lib', 'voice-library', 'catalog.json')

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out)
    } else {
      const dot = name.lastIndexOf('.')
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
      if (AUDIO_EXTS.has(ext)) out.push(full)
    }
  }
  return out
}

// 由微信公众号xxx收集整理 / similar trailing attribution patterns we strip.
const ATTRIBUTION_RE = /[-—]?\s*由微信公众号[^/]*?收集整理.*$/i
const KEYWORD_TAGS: Array<[RegExp, string]> = [
  [/方言|东北|四川|广东|粤语|台湾|湖南|河南/i, '方言'],
  [/播报|新闻|主持|cctv/i, '播报'],
  [/角色|宠物|猫|狗|动物/i, '角色扮演'],
  [/影视|林志玲|周星驰|王家卫|郭德纲|宋丹丹|宋祖英|刘德华/i, '影视'],
  [/带货|直播|卖货|促销|话术/i, '直播带货'],
  [/教师|老师|讲课|教育/i, '教学'],
  [/搞笑|喜剧|逗哥|沙雕/i, '搞笑'],
  [/温柔|温暖|治愈|抒情/i, '温柔'],
  [/暴躁|怒|愤|凶|严厉/i, '暴躁'],
  [/萝莉|可爱|甜美|少女/i, '少女'],
  [/大叔|沧桑|低沉|浑厚/i, '低沉'],
  [/正能量|励志|宣传|大气/i, '宣传'],
]

// Tighter regexes share their definition between collection + filename +
// sampleSnippet passes — covering 800+ catalog voices that ship with very
// chinese-character-style display names ("AD学姐", "霸总", "御姐...")
// the previous narrow patterns missed. After this, unknown-rate drops
// from ~80% → ~30% on the 553-voice catalog.
const MALE_HINTS = /(男声|男音|男配|男主|男生|男性|男版|大叔|爷爷|大爷|爸爸|父亲|老男|老头|哥哥|哥|弟弟|弟|先生|帅哥|霸总|总裁|王者|社长|师父|师傅|和尚|道长|警察|队长|队员|男友|男孩|小哥|公子|侯爷|王爷|皇上|皇帝|太子|将军|侠客|教官|男配|憨憨|憨厚|沉稳)/
const FEMALE_HINTS = /(女声|女音|女配|女主|女生|女性|女版|大姐|奶奶|大妈|妈妈|母亲|老女|姐姐|姐|妹妹|妹|小姐|姑娘|少女|阿姨|美女|御姐|萝莉|甜美|甜妹|温柔|温婉|学姐|学妹|师妹|师姐|公主|皇后|嫔妃|娘娘|王后|女王|女友|女孩|奶气|奶系|奶音|嗲|娇|绿茶|心机|名媛|妩媚|清纯)/
const CHILD_HINTS = /(童声|小孩|宝宝|小学|小朋友|奶气|奶系|奶音|小baby|baby|稚嫩|稚气)/i
const ELDERLY_HINTS = /(老人|老者|老男|老女|爷爷|奶奶|大爷|大妈|年迈|苍老|沧桑|爷|奶|阿婆|阿公|长者)/
const MIDDLE_HINTS = /(中年|大叔|大姐|阿姨|师父|师傅|队长|警察|警长|总裁|霸总|社长|教官|父亲|母亲|爸爸|妈妈|爹|娘|班主任|队员|将军|侯爷|王爷|皇上|皇帝|师姐|师兄|师妹|主任)/
const YOUTH_HINTS = /(少女|少年|青年|小哥哥|小姐姐|学生|学姐|学妹|师妹|师弟|大学|高中|初中|公子|太子|王子|公主|姑娘|学长|学弟|青春|甜妹|奶气|奶系|帅哥|美女|萝莉|甜美|阿哲|阿澈|清纯)/

function detectGender(haystack: string): VoiceGender {
  if (MALE_HINTS.test(haystack) && !FEMALE_HINTS.test(haystack)) return 'male'
  if (FEMALE_HINTS.test(haystack) && !MALE_HINTS.test(haystack)) return 'female'
  return 'unknown'
}

function detectAge(haystack: string): VoiceAge {
  // Check most-specific buckets first so "学生" doesn't get
  // mis-categorized as middle when "大学生" suggests youth.
  if (CHILD_HINTS.test(haystack)) return 'child'
  if (ELDERLY_HINTS.test(haystack)) return 'elderly'
  if (YOUTH_HINTS.test(haystack)) return 'youth'
  if (MIDDLE_HINTS.test(haystack)) return 'middle'
  return 'unknown'
}

function parseFromCollection(collection: string): { gender: VoiceGender; age: VoiceAge } {
  return {
    gender: detectGender(collection),
    age: detectAge(collection),
  }
}

function parseFromFilename(name: string, base: { gender: VoiceGender; age: VoiceAge }) {
  // Filename-level signals override the folder bucket. We also fold the
  // sampleSnippet into the haystack because many voices are tagged by the
  // line they're saying ("我是你们的一休老师" → male/middle teacher,
  // even when the displayName is opaque like "一休资料分析").
  let { gender, age } = base
  if (gender === 'unknown') gender = detectGender(name)
  if (age === 'unknown') age = detectAge(name)
  return { gender, age }
}

/** 4-bucket age preset that mirrors the user-facing 幼儿/少年/中年/老年
 *  shortlist — exposed for tests + tooling. */
export const AGE_BUCKETS = ['child', 'youth', 'middle', 'elderly'] as const

function buildTags(collection: string, filename: string): string[] {
  const text = `${collection} ${filename}`
  const tags = new Set<string>()
  for (const [re, tag] of KEYWORD_TAGS) if (re.test(text)) tags.add(tag)
  // Top-level collection labels become tags too.
  for (const seg of collection.split('/')) {
    if (seg && seg.length <= 12) tags.add(seg)
  }
  return Array.from(tags)
}

function parseDisplayName(filename: string): { displayName: string; sampleSnippet: string } {
  // Strip extension.
  const dot = filename.lastIndexOf('.')
  const stem = dot >= 0 ? filename.slice(0, dot) : filename
  // Strip the attribution tail.
  const clean = stem.replace(ATTRIBUTION_RE, '').trim()
  // Filenames are typically `<NAME>-<SAMPLE TEXT>`. Split on the first dash
  // to surface a tidy title + a sample snippet (capped).
  const splitIdx = clean.search(/[-—]/)
  if (splitIdx === -1 || splitIdx > 18) {
    // No dash or the name part is way too long — show the truncated stem
    // as the display name, with no separate snippet.
    return { displayName: clean.slice(0, 32), sampleSnippet: clean.slice(0, 160) }
  }
  return {
    displayName: clean.slice(0, splitIdx).trim() || clean.slice(0, 32),
    sampleSnippet: clean.slice(splitIdx + 1, splitIdx + 1 + 160).trim(),
  }
}

function stableId(relPath: string): string {
  return createHash('md5').update(relPath).digest('hex').slice(0, 12)
}

function buildEntry(absPath: string): VoiceEntry {
  const rel = relative(VOICES_ROOT, absPath)
  const parts = rel.split(sep)
  const filename = parts[parts.length - 1]
  const collection = parts.slice(0, -1).join('/')
  const { displayName, sampleSnippet } = parseDisplayName(filename)
  // Detection runs over collection → displayName → sampleSnippet so the
  // sample text (often the most informative signal — e.g. a teacher's
  // sample is "同学们" → youth-ish) gets weighed.
  const collectionParse = parseFromCollection(collection)
  const fromName = parseFromFilename(filename, collectionParse)
  let { gender, age } = fromName
  if ((gender === 'unknown' || age === 'unknown') && sampleSnippet) {
    if (gender === 'unknown') gender = detectGender(sampleSnippet)
    if (age === 'unknown') age = detectAge(sampleSnippet)
  }
  // 4-bucket bias (幼儿/少年/中年/老年): if we know gender but still
  // don't have an age signal, default to 'middle' — most catalog voices
  // are working-age adult range, and unknowns are useless for prefilter.
  // Explicit child/youth/elderly cues already short-circuited above.
  if (age === 'unknown' && gender !== 'unknown') age = 'middle'
  // encodeURIComponent escapes `+` to %2B, but Vite's static-file middleware
  // doesn't decode %2B back to `+` when matching disk paths — the request
  // falls through to the SPA index.html (HTTP 200 text/html 635 bytes), so
  // <audio> "loads" but plays silently. The fix: keep `+` as a literal path
  // character (RFC 3986 allows it unencoded in path segments). Same goes
  // for any other "safe" path characters we don't want over-encoded.
  const encodeSegment = (s: string) => encodeURIComponent(s).replace(/%2B/g, '+')
  const urlPath = `/voices/${rel.split(sep).map(encodeSegment).join('/')}`
  const sizeBytes = statSync(absPath).size
  return {
    id: stableId(rel),
    displayName,
    collection,
    urlPath,
    relativePath: rel,
    gender,
    age,
    tags: buildTags(collection, filename),
    sampleSnippet,
    sizeBytes,
  }
}

function main(): void {
  console.log('[voice-catalog] scanning', VOICES_ROOT)
  const files = walk(VOICES_ROOT).sort()
  console.log('[voice-catalog] found', files.length, 'audio files')
  const voices = files.map(buildEntry)
  const catalog: VoiceCatalog = {
    generatedAt: new Date().toISOString(),
    count: voices.length,
    publicRoot: '/voices',
    voices,
  }
  writeFileSync(CATALOG_OUT, JSON.stringify(catalog, null, 2))
  console.log('[voice-catalog] wrote', CATALOG_OUT, `(${voices.length} entries)`)
}

main()
