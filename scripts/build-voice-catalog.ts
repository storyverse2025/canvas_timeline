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

function parseFromCollection(collection: string): { gender: VoiceGender; age: VoiceAge } {
  let gender: VoiceGender = 'unknown'
  let age: VoiceAge = 'unknown'

  if (/(男声|男音|男配|男主|男生|男性|男版)/.test(collection)) gender = 'male'
  else if (/(女声|女音|女配|女主|女生|女性|女版)/.test(collection)) gender = 'female'

  if (/孩童|童声|小孩/.test(collection)) age = 'child'
  else if (/老年|爷爷|奶奶|大爷|大妈/.test(collection)) age = 'elderly'
  else if (/中年/.test(collection)) age = 'middle'
  else if (/青年/.test(collection)) age = 'youth'
  else if (/成年|成熟/.test(collection)) age = 'adult'

  return { gender, age }
}

function parseFromFilename(name: string, base: { gender: VoiceGender; age: VoiceAge }) {
  let { gender, age } = base
  // Filename-level overrides — more specific than the folder bucket.
  if (gender === 'unknown') {
    if (/(男声|男音|大叔|男主|男版|爷爷|大爷|爸爸|父亲|老男人|哥|弟|先生)/.test(name)) gender = 'male'
    else if (/(女声|女音|大姐|女主|女版|奶奶|大妈|妈妈|母亲|老女人|姐|妹|小姐|姑娘|少女|阿姨)/.test(name)) gender = 'female'
  }
  if (age === 'unknown') {
    if (/(童声|小孩|宝宝|小学|小朋友)/.test(name)) age = 'child'
    else if (/(老人|老者|老男|老女|爷爷|奶奶|大爷|大妈|年迈)/.test(name)) age = 'elderly'
    else if (/(中年|大叔|大姐|中年男|中年女)/.test(name)) age = 'middle'
    else if (/(少女|青年|小哥哥|小姐姐|大学|学生)/.test(name)) age = 'youth'
  }
  return { gender, age }
}

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
  const collectionParse = parseFromCollection(collection)
  const { gender, age } = parseFromFilename(filename, collectionParse)
  const { displayName, sampleSnippet } = parseDisplayName(filename)
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
