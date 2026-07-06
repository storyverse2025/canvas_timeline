/**
 * cinematographer-agent — shoots beat-video clips via Seedance 2.0 and
 * revises generation prompts when director-agent.critiqueVideoConsistency
 * flags issues.
 *
 * Two async-generator verbs:
 *   - shoot(req)  → BeatVideoResult { url, prompt, durationSeconds, refs }
 *   - revise(req) → BeatVideoResult with the LLM-rewritten prompt that
 *                   addresses each VideoConsistencyIssue, then re-shoots
 *
 * Caller-side (useStoryboardGenerate.generateBeatVideo) writes the
 * resulting URL back to canvas/storyboard stores — the agent stays pure.
 */

import { runCapability } from '@/lib/capabilities/client'
import { fillTemplate, parseFrontmatter } from '@/lib/agents/_shared/mustache'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import type { AgentGenerator } from '@/lib/agents/_shared/runtime/types'

import skillSource from './SKILL.md?raw'
import shootSource from './prompts/shoot.md?raw'
import reviseSource from './prompts/revise.md?raw'

import type {
  BeatVideoContextRef,
  BeatVideoRef,
  BeatVideoResult,
  BeatVideoRow,
  ReferencePackImage,
  ReviseRequest,
  ShootRequest,
  VirtualAvatarShootRef,
} from './schema'

const { body: SYSTEM } = parseFrontmatter(skillSource)
const TPL = {
  shoot: parseFrontmatter(shootSource).body,
  revise: parseFrontmatter(reviseSource).body,
}

// ─── Seedance pin ──────────────────────────────────────────────────
//
// Seedance 2.0 is the contracted camera. Pin both ids here so successive
// shoots stay deterministic and a future model bump is a one-line change.

// Provider id is the BytePlus海外 (Dreamina) route. The string 'doubao' is
// retained as a stable internal identifier so persisted IndexedDB state from
// older builds still resolves; all calls hit ark.ap-southeast.bytepluses.com.
export const SHOOT_PROVIDER = 'doubao'
// Default to Dreamina Seedance 2.0 (full) — matches projectDB.artDirection
// default. The 'Fast' variant caps at 720p / 12s and trades quality for
// throughput; full opens 1080p + 15s and matches the look user pinned in
// art direction. Operators that explicitly want Fast pass the Fast id via
// runShootBeatVideos's `model` param.
export const SHOOT_MODEL = 'dreamina-seedance-2-0-260128'
export const SHOOT_RESOLUTION_DEFAULT: '480p' | '720p' | '1080p' = '1080p'
const MIN_DURATION = 5
const MAX_DURATION = 15

function clampDuration(seconds: number): number {
  return Math.min(Math.max(Math.round(seconds), MIN_DURATION), MAX_DURATION)
}

// Rough TTS duration heuristic — we don't actually synthesize audio here,
// just estimate how long the dialogue will take so the video clip is long
// enough not to clip the line. Conservative natural speaking rates:
//   Mandarin ~3.5 chars/sec (~210 chars/min)
//   English  ~2.5 words/sec (~150 wpm)
// Returns 0 when dialogue is empty so callers can max() against it safely.
export function predictDialogueDurationSeconds(dialogue: string | undefined): number {
  if (!dialogue || !dialogue.trim()) return 0
  const chineseChars = (dialogue.match(/\p{Script=Han}/gu) ?? []).length
  const stripped = dialogue.replace(/\p{Script=Han}/gu, ' ')
  const englishWords = (stripped.match(/[A-Za-z]+/g) ?? []).length
  return chineseChars / 3.5 + englishWords / 2.5
}

// Buffer after the predicted dialogue end for breath / fade / final composition
// hold. Keeps the last syllable from getting clipped by the video tail.
const DIALOGUE_TAIL_BUFFER_SECONDS = 0.8

// Pick a duration that's long enough for the dialogue line, falling back to
// the user / row request when the dialogue is short. Returns the post-clamp
// integer seconds the Seedance call should use.
export function resolveEffectiveDurationSeconds(opts: {
  userRequested: number
  dialogue: string | undefined
}): number {
  const ttsFloor = predictDialogueDurationSeconds(opts.dialogue)
  const floor = ttsFloor > 0 ? ttsFloor + DIALOGUE_TAIL_BUFFER_SECONDS : 0
  return clampDuration(Math.max(opts.userRequested, floor))
}

function buildContextRefLine(contextRefs: BeatVideoContextRef[]): string {
  return contextRefs
    .filter((ref) => ref.description?.trim())
    .map((ref) => `- ${ref.role}：${ref.description!.trim()}`)
    .join('\n')
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function buildMotionDescription(req: {
  row: BeatVideoRow
  visualStyle?: string
  contextRefs?: BeatVideoContextRef[]
  /** True when a multi-reference pack replaces the single keyframe as the
   *  image inputs — the 参考素材用途 block then defers to the pack legend. */
  hasReferencePack?: boolean
}): string {
  const r = req.row
  const contextLines = buildContextRefLine(req.contextRefs ?? [])
  const blocks: string[] = []

  blocks.push([
    '【Seedance 2.0 视频生成指令】',
    r.shot_number ? `镜头编号：${r.shot_number}` : '',
    r.duration ? `目标时长：${clampDuration(r.duration)}秒（Seedance 支持 4–15 秒；本系统安全夹到 5–15 秒）` : '',
    '把上传的关键帧/导演分镜参考理解为视频生成依据；输出必须是干净的全屏电影画面。',
  ].filter(Boolean).join('\n'))

  const subjectScene = [
    cleanText(r.visual_description) ? `画面主体/场景：${cleanText(r.visual_description)}` : '',
    cleanText(r.shot_size) ? `景别：${cleanText(r.shot_size)}` : '',
    cleanText(r.lighting_atmosphere) ? `光影氛围：${cleanText(r.lighting_atmosphere)}` : '',
    cleanText(req.visualStyle) ? `视觉风格：${cleanText(req.visualStyle)}` : '',
  ].filter(Boolean)
  if (subjectScene.length) blocks.push(`【主体 / 场景 / 风格】\n${subjectScene.join('\n')}`)

  if (req.hasReferencePack) {
    blocks.push([
      '【参考素材用途】',
      // No hardcoded slot order here — the pack's composition varies per
      // row (身份版可能缺席、场景可能缺席), and a stale order listing sends
      // the model to the wrong indices. The legend is the only authority.
      '- 多参考输入模式：各参考图的职责与编号以【参考图】legend 为准，@图片N 明确指向对应主体；CASTING 依据见 legend 标注。',
      contextLines,
    ].filter(Boolean).join('\n'))
  } else if (contextLines) {
    blocks.push([
      '【参考素材用途】',
      '- 首帧：当前 keyframe / image1 锁定开场构图、角色、服装、场景和光影。',
      contextLines,
      '- 上述角色/场景/道具参考主要通过提示词约束；除显式 reference-pack 模式外，不额外塞图片给 Seedance。',
    ].join('\n'))
  } else {
    blocks.push([
      '【参考素材用途】',
      '- 首帧：当前 keyframe / image1 锁定开场构图、角色、服装、场景和光影。',
      '- 若存在第二张导演分镜图，只读取调度、走位、节奏，不要渲染边框/箭头/文字。',
    ].join('\n'))
  }

  const performance = [
    cleanText(r.character_actions) ? `角色动作：${cleanText(r.character_actions)}` : '',
    cleanText(r.emotion_mood) ? `情绪：${cleanText(r.emotion_mood)}` : '',
    cleanText(r.emotion_atmosphere) ? `情绪氛围：${cleanText(r.emotion_atmosphere)}` : '',
    cleanText(r.character_motivation) ? `动机：${cleanText(r.character_motivation)}` : '',
    cleanText(r.character_psychology) ? `心理：${cleanText(r.character_psychology)}` : '',
    cleanText(r.performance_guidance) ? `表演指导：${cleanText(r.performance_guidance)}` : '',
  ].filter(Boolean)
  if (performance.length) {
    blocks.push(`【表演与情绪】\n${performance.join('\n')}\n**面部表情必须清晰可见且随情绪逐拍变化**——镜头要给到脸，眼神/眉形/嘴型/下颌张力要演出上面的情绪，不能是面无表情的呆脸（面瘫会让画面出戏）。同时落到呼吸、手部、身体重心、步伐节奏等可见表演。`)
  }

  const motion = cleanText(r.motion_prompts)
  if (motion) {
    blocks.push(`【分时段动作与运镜】\n${motion}\n8秒以上必须按时间段执行；镜头运动、景别、角色走位和情绪变化要连续。`)
  }

  const storyboard = cleanText(r.storyboard_prompts)
  if (storyboard) {
    blocks.push([
      '【导演分镜格信息】',
      storyboard,
      '如果参考图是多格导演分镜图，请按格子顺序理解为动作/情绪/镜头推进；不要理解为最终视频的分屏画面；not a literal split-screen.',
    ].join('\n'))
  }

  const audio = [
    cleanText(r.dialogue) ? `对白：${cleanText(r.dialogue)}` : '',
    cleanText(r.sound_effects) ? `音效：${cleanText(r.sound_effects)}` : '',
    // row.bgm is the MIXER's brief, not a generation instruction. Surfacing
    // it positively here re-broke the No-Music-Bed hard rule from #94 (the
    // model reads "BGM: 紧张弦乐" and lays down a score). Keep it strictly
    // as a mood reference with an explicit negative.
    cleanText(r.bgm)
      ? `情绪基调参考（仅供表演/节奏理解）：${cleanText(r.bgm)} —— 但输出音轨严禁出现任何 BGM/配乐/音乐，配乐由后期混音阶段单独处理。`
      : '',
  ].filter(Boolean)
  if (audio.length) {
    blocks.push(`【声音设计】\n${audio.join('\n')}\n声音必须与动作节奏贴合；只保留对白与画内音效，禁止任何配乐。`)
  }

  blocks.push('【一致性约束】\n保持角色身份、服装、场景、光影、运动方向连续；不要添加无关角色；不要改变核心服装和身份。\n若本段文字规划（景别/光影/运镜）与参考图实际画面冲突，以参考图为准 —— 参考图是已经通过审片的最终视觉。')

  return blocks.join('\n\n')
}

/**
 * Build the row context string passed to the cinematography-describe LLM
 * step. The model uses these textual cues alongside the keyframe image to
 * ground its description in this specific shot rather than producing
 * generic cinematography prose.
 */
function buildCinematographyContext(row: BeatVideoRow, visualStyle?: string): string {
  const lines: string[] = []
  if (row.shot_number) lines.push(`镜头编号：${row.shot_number}`)
  if (row.shot_size) lines.push(`景别（用户已选）：${row.shot_size}`)
  if (row.visual_description) lines.push(`画面：${row.visual_description}`)
  if (row.character_actions) lines.push(`角色动作：${row.character_actions}`)
  if (row.motion_prompts) lines.push(`运镜参考：${row.motion_prompts}`)
  if (row.lighting_atmosphere) lines.push(`光影：${row.lighting_atmosphere}`)
  if (row.emotion_mood) lines.push(`情绪：${row.emotion_mood}`)
  if (visualStyle) lines.push(`视觉风格锁定：${visualStyle}`)
  return [
    '请基于这张分镜板（director storyboard sheet）+ 下面的行字段，写出本镜头的镜头/光线/动作语言：',
    '',
    ...lines,
    '',
    '只输出 4-8 行中文，每行一句，不要标题、不要 JSON、不要 emoji。',
  ].join('\n')
}

/**
 * Read the keyframe image and produce a 4-8 line cinematography paragraph
 * (镜头 / 光线 / 动作). Wired into shoot() so the Seedance text prompt
 * carries explicit camera / lighting / motion language now that the
 * keyframe itself dropped those text labels in favor of pure storyboard
 * panels + diagrams.
 *
 * Failure handling: returns empty string. The shoot proceeds with just
 * dialogue + SFX in the text prompt and the keyframe as the image input —
 * worse than having the cinematography block, but still useful.
 */
async function describeKeyframeCinematography(opts: {
  keyframeUrl: string
  row: BeatVideoRow
  visualStyle?: string
}): Promise<string> {
  try {
    const r = await runCapability({
      capability: 'cinematography-describe',
      inputs: [
        { kind: 'text', text: buildCinematographyContext(opts.row, opts.visualStyle) },
        { kind: 'image', url: opts.keyframeUrl },
      ],
    })
    return (r.outputs[0]?.text ?? '').trim()
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[cinematographer-agent] cinematography-describe failed (${(e as Error).message}); falling back to dialogue/SFX-only prompt`)
    return ''
  }
}

/**
 * The image legend.
 *
 * Both images travel to Seedance as reference_image (omni-reference / 全能参考
 * mode — the only way Seedance accepts two images alongside dialogue audio;
 * it rejects mixing a literal first_frame role with reference_image). Since
 * neither carries the API-level first_frame role, the prompt itself spells out
 * the intended roles: image1 (the clean frame) should anchor the opening
 * composition / first frame, and image2 (the multi-panel grid) is the
 * director's storyboard "thinking diagram" — read staging / blocking / pacing
 * from it but never render its panels, borders, or labels.
 *
 * Single-image (no grid) keeps the original one-line legend.
 */
/**
 * Reference-pack URL discipline (see .claude/skills/canvas-seedance-video-prompt):
 * http(s) raster URLs, data:image rasters, and root-relative /uploads/ paths
 * may ship to Seedance — the capability server inlines /uploads/ files to
 * data: URLs before the provider call (see vite-capabilities-plugin's
 * isSeedanceMediaUrl / inlineLocalRefsInContentParts; every generated
 * keyframe / identity sheet is persisted there, so rejecting them here
 * silently emptied the reference pack down to a single scene image).
 * Rejects other relative paths, stale node markers, asset:// (those travel
 * via the dedicated avatar param), and SVG data URLs.
 */
export function isValidReferenceImageUrl(url: string | undefined): url is string {
  if (!url || !url.trim()) return false
  const u = url.trim()
  if (/^data:image\/(png|jpe?g|webp|gif|bmp);/i.test(u)) return true
  if (/^\/uploads\/\S+$/i.test(u)) return true
  return /^https?:\/\/\S+$/i.test(u)
}

function buildImageLegend(
  _keyframeUrl: string,
  hasStoryboardRef = false,
  avatarRefs: VirtualAvatarShootRef[] = [],
  referencePack: ReferencePackImage[] = [],
): string {
  const lines: string[] = []
  if (referencePack.length > 0) {
    lines.push(
      '【REFERENCE IMAGES / 参考图】 (全能参考 / omni-reference，多参考输入合成):',
    )
    referencePack.forEach((ref, i) => {
      const idx = i + 1
      const subject = ref.subject ? `，@${ref.subject} 即指向这张图中的主体` : ''
      lines.push(`- image${idx} / @图片${idx} = ${ref.label} —— ${ref.usage}${subject}。`)
    })
    // CASTING 依据 — computed from the pack's actual composition, never
    // hardcoded to @图片1 (pack contents vary per row; in a pack whose
    // image1 is the empty scene plate a hardcoded anchor sends the model
    // hunting for faces in an image that deliberately has none).
    const charRefs = referencePack
      .map((ref, i) => ({ ref, idx: i + 1 }))
      .filter(({ ref }) => ref.kind === 'character')
    if (charRefs.length > 0) {
      lines.push(
        `CASTING 依据 / casting anchor：${charRefs
          .map(({ ref, idx }) => `@图片${idx}${ref.subject ? `（${ref.subject}）` : ''}`)
          .join('、')} —— 角色脸型、发型、服装、体态以这些图为准。`,
      )
    } else {
      const cameraIdx = referencePack.findIndex((r) => r.kind === 'camera')
      if (cameraIdx >= 0) {
        lines.push(
          `CASTING 依据 / casting anchor：@图片${cameraIdx + 1}（机位截图中的角色造型）—— 角色脸型、发型、服装、体态以这张图中出现的角色为准。`,
        )
      }
    }
    lines.push(
      '严禁把任何参考图的分格、边框、箭头、标注文字、ID 块渲染进画面；参考图只提供身份/场景/调度/构图信息。',
    )
  } else if (!hasStoryboardRef) {
    lines.push(
      '【REFERENCE IMAGE / 参考图】 (omni-reference / 全能参考):',
      '- image1 / @图片1 = Keyframe (the director storyboard sheet — read casting, scene, blocking, lighting from it; do NOT shoot the sheet itself).',
      'CASTING 依据 / casting anchor：@图片1。',
    )
  } else {
    lines.push(
      '【REFERENCE IMAGES / 参考图】 (全能参考 / omni-reference，两张都是参考图):',
      '- image1 / @图片1 = 首帧图 / clean first frame —— 以这张作为视频的开场首帧与主构图，casting、场景、配色、光线都以它为准。',
      '- image2 / @图片2 = 导演思维图 / director storyboard sheet —— 仅作导演调度参考：读取走位、调度、节奏、多拍动作演进。严禁把图板的分格、边框、箭头、时间标签、文字渲染进画面；画面长相以 @图片1 为准。',
      'CASTING 依据 / casting anchor：@图片1（首帧图）。',
    )
  }
  // Virtual-avatar references for 真人 styles. They are appended AFTER the
  // keyframe (+grid) / reference-pack image_url parts server-side, so their
  // @图片N index is the running image count. Each line ties the index to a
  // named character so the model locks that character's face/appearance to
  // the approved avatar.
  const baseImageCount = referencePack.length > 0 ? referencePack.length : hasStoryboardRef ? 2 : 1
  avatarRefs.forEach((ref, i) => {
    const idx = baseImageCount + i + 1
    lines.push(
      `- image${idx} / @图片${idx} = 虚拟人像「${ref.characterName}」(${ref.slotLabel}) —— ` +
        `视频里这个角色的脸、五官、发型、气质严格以这张为准，全程保持一致；这是经过审核的合规人像。`,
    )
  })
  return lines.join('\n')
}

function assembleShootPrompt(req: {
  row: BeatVideoRow
  keyframeUrl: string
  storyboardRefUrl?: string
  referencePack?: ReferencePackImage[]
  contextRefs?: BeatVideoContextRef[]
  visualStyle?: string
  cinematography?: string
  virtualAvatarRefs?: VirtualAvatarShootRef[]
}): string {
  const pack = (req.referencePack ?? []).filter((p) => isValidReferenceImageUrl(p.url))
  const dialogueAndSfx = buildMotionDescription({ ...req, hasReferencePack: pack.length > 0 })
  const hasStoryboardRef = Boolean(
    req.storyboardRefUrl?.trim() && req.storyboardRefUrl.trim() !== req.keyframeUrl,
  )
  const legend = buildImageLegend(req.keyframeUrl, hasStoryboardRef, req.virtualAvatarRefs ?? [], pack)
  // The cinematography-describe step reads req.keyframeUrl — in pack mode
  // that image sits at whatever index the pack put it (usually the 机位
  // tail), NOT @图片1. Label with the true index so the model attributes
  // the analysis to the right reference.
  const analyzedIdx = pack.length > 0 ? pack.findIndex((p) => p.url === req.keyframeUrl) : 0
  const analyzedLabel = analyzedIdx >= 0 ? `基于 @图片${analyzedIdx + 1} / image${analyzedIdx + 1} 的分析` : '基于机位/首帧参考图的分析'
  const cinematographyBlock = req.cinematography?.trim()
    ? `【镜头语言 / CINEMATOGRAPHY】（${analyzedLabel}）\n${req.cinematography.trim()}`
    : ''
  return fillTemplate(TPL.shoot, {
    imageLegend: legend,
    cinematographyBlock,
    dialogueAndSfx,
  }).trim()
}

async function callFirstLastFrame(opts: {
  prompt: string
  firstFrameUrl: string
  lastFrameUrl: string
  durationSeconds: number
  aspect: '16:9' | '9:16' | '1:1' | '4:3'
  resolution: '480p' | '720p' | '1080p'
}): Promise<string> {
  // Seedance's first-last-frame mode interpolates between two reference
  // images. Used for bridge / transition clips so the cut from prev →
  // bridge → next reads as a real motion transition rather than three
  // independent shots cobbled together.
  //
  // Voice audio refs are intentionally omitted — transition clips don't
  // carry dialogue (the bridge proposal sets dialogue: '' for the same
  // reason). If a future bridge does have dialogue, we'd need to switch
  // to a model that accepts both end-frames AND voice refs.
  const r = await runCapability({
    capability: 'first-last-frame',
    inputs: [
      { kind: 'text', text: opts.prompt },
      { kind: 'image', url: opts.firstFrameUrl },
      { kind: 'image', url: opts.lastFrameUrl },
    ],
    params: {
      provider: SHOOT_PROVIDER,
      model: SHOOT_MODEL,
      duration: String(opts.durationSeconds),
      aspect: opts.aspect,
      resolution: opts.resolution,
    },
  })
  const url = r.outputs[0]?.url
  if (!url) throw new Error('cinematographer: first-last-frame returned no url')
  return url
}

async function callSeedance(opts: {
  prompt: string
  keyframeUrl: string
  storyboardRefUrl?: string
  /** Validated multi-reference pack. Non-empty → replaces keyframe+grid as
   *  the image inputs (see ShootRequest.referencePack). */
  referencePack?: ReferencePackImage[]
  voiceAudioUrls?: string[]
  durationSeconds: number
  aspect: '16:9' | '9:16' | '1:1' | '4:3'
  resolution: '480p' | '720p' | '1080p'
  invitedImageAssetIds?: string[]
  /** `asset://<id>` virtual-avatar refs for 真人 styles (see ShootRequest). */
  avatarAssetUris?: string[]
}): Promise<string> {
  // Image inputs. Both the clean keyframe and the director storyboard grid
  // ride along as reference_image (全能参考 / omni-reference). Seedance forbids
  // tagging one image as the literal first_frame while another is a
  // reference_image ("first/last frame content cannot be mixed with reference
  // media content"), so we ship BOTH as references and let the PROMPT spell
  // out the intended roles instead: @图片1 = 首帧 / 开场构图, @图片2 = 导演思维图
  // (see buildImageLegend). mode:'reference' forces reference-to-video for the
  // image-only case; when dialogue audio is present the dispatcher promotes to
  // universal-to-video, which also tags every image reference_image.
  const storyboardRef = opts.storyboardRefUrl?.trim()
  const hasStoryboardRef = Boolean(storyboardRef && storyboardRef !== opts.keyframeUrl)
  // Multi-reference pack replaces the [keyframe, grid] pair entirely: the
  // pack already carries the storyboard + the camera/first-frame anchor at
  // its tail (角色→场景→分镜→机位截图). Seedance caps reference_image at 9;
  // leave headroom for server-appended avatar refs.
  const pack = (opts.referencePack ?? []).filter((p) => isValidReferenceImageUrl(p.url)).slice(0, 9)
  const imageInputs = pack.length > 0
    ? pack.map((p) => ({ kind: 'image' as const, url: p.url }))
    : [
        { kind: 'image' as const, url: opts.keyframeUrl },
        ...(hasStoryboardRef ? [{ kind: 'image' as const, url: storyboardRef! }] : []),
      ]

  // Virtual-avatar refs (真人 styles) travel as a dedicated param, NOT as image
  // inputs: their `asset://<id>` URIs are filtered out by the dispatcher's
  // http/data url guard, and the plugin appends them as reference_image parts
  // itself. Their presence forces reference-to-video so they don't get mixed
  // with a literal first_frame (Seedance rejects that combination).
  const avatarAssetUris = (opts.avatarAssetUris ?? []).filter((u) => u.trim()).slice(0, 6)
  // Per Ark's contract, first/last-frame roles can never mix with
  // reference media — any multi-image shipment must be all-reference.
  const forceReference = pack.length > 0 || hasStoryboardRef || avatarAssetUris.length > 0

  // PER-CHARACTER voice files travel as audio inputs (when dialogue exists)
  // so Seedance can match each spoken line to its corresponding 音色N
  // reference. The capability dispatcher auto-routes audios → universal-to-
  // video mode.
  const voiceInputs = (opts.voiceAudioUrls ?? [])
    .filter((u): u is string => Boolean(u && u.trim()))
    .slice(0, 3) // Seedance universal-to-video accepts up to 3 audios
    .map((url) => ({ kind: 'audio' as const, url }))

  // BGM suppression is done in the prompt (see shoot.md AUDIO block),
  // NOT via Seedance's generate_audio flag — that flag is a single hard
  // switch that would also kill the 人物台词 we want to keep. Trust the
  // prompt directive.
  const r = await runCapability({
    capability: 'text-to-video',
    inputs: [
      { kind: 'text', text: opts.prompt },
      ...imageInputs,
      ...voiceInputs,
    ],
    params: {
      provider: SHOOT_PROVIDER,
      model: SHOOT_MODEL,
      duration: String(opts.durationSeconds),
      aspect: opts.aspect,
      resolution: opts.resolution,
      // Two images OR avatar refs → force reference-to-video (every image is
      // reference_image). Single image keeps the legacy omni-reference hint.
      ...(forceReference ? { mode: 'reference' as const } : { reference_mode: 'omni' }),
      // Privacy-block fallback: BytePlus digital-asset ids the caller
      // pre-registered. The capability plugin translates these to the
      // Seedance body's `invited_images` field.
      ...(opts.invitedImageAssetIds?.length
        ? { invitedImageAssetIds: opts.invitedImageAssetIds }
        : {}),
      // 真人 style: virtual-avatar `asset://` refs. The plugin appends each as
      // a reference_image content part; the prompt legend (image3/image4…)
      // ties them to characters.
      ...(avatarAssetUris.length ? { avatarAssetUris } : {}),
    },
  })
  const url = r.outputs[0]?.url
  if (!url) throw new Error('cinematographer: text-to-video returned no url')
  return url
}

// ─── Verb: shoot ───────────────────────────────────────────────────

export async function* shoot(
  req: ShootRequest,
  ctx: ProjectContext,
): AgentGenerator<BeatVideoResult> {
  const shot = req.row.shot_number ?? '?'
  const durationSeconds = resolveEffectiveDurationSeconds({
    userRequested: req.durationSecondsOverride ?? req.row.duration ?? MIN_DURATION,
    dialogue: req.row.dialogue,
  })
  const aspect = req.aspect ?? '16:9'
  const resolution = req.resolution ?? SHOOT_RESOLUTION_DEFAULT

  if (!req.keyframeUrl) {
    throw new Error(
      'cinematographer: shoot requires keyframeUrl (omni-reference mode needs the director keyframe as the single reference image). Generate the keyframe first.',
    )
  }

  yield {
    type: 'progress',
    message: `cinematographer: reading keyframe for cinematography language (shot ${shot})`,
  }
  const cinematography = await describeKeyframeCinematography({
    keyframeUrl: req.keyframeUrl,
    row: req.row,
    visualStyle: req.visualStyle,
  })
  if (cinematography) {
    yield {
      type: 'progress',
      message: `cinematographer: ${cinematography.split('\n').length}-line cinematography block ready`,
    }
  }

  yield {
    type: 'progress',
    message: `cinematographer: composing Seedance prompt for shot ${shot} (${durationSeconds}s, ${aspect}, ${resolution}, omni-reference)`,
  }

  const basePrompt = assembleShootPrompt({
    row: req.row,
    keyframeUrl: req.keyframeUrl,
    storyboardRefUrl: req.storyboardRefUrl,
    referencePack: req.referencePack,
    contextRefs: req.contextRefs,
    visualStyle: req.visualStyle,
    cinematography,
    virtualAvatarRefs: req.virtualAvatarRefs,
  })

  void ctx
  // Caller-supplied augmenter runs after the cinematographer prompt is
  // assembled and before Seedance is invoked. actor-agent.attachVoiceRefs
  // both rewrites the prompt (adds 音色1/音色2 dialogue block) AND returns
  // the audio URLs to ship as inputs alongside the keyframe.
  const augmented = req.promptPostProcessor ? await req.promptPostProcessor(basePrompt) : basePrompt
  const prompt = typeof augmented === 'string' ? augmented : augmented.videoPrompt
  const voiceAudioUrls = typeof augmented === 'string' ? undefined : augmented.voiceAudioUrls

  const packSize = (req.referencePack ?? []).filter((p) => isValidReferenceImageUrl(p.url)).length
  const mode = req.transitionFrames
    ? 'first-last-frame transition'
    : packSize > 0
      ? `multi-reference pack ×${packSize}`
      : 'omni-reference'
  yield {
    type: 'progress',
    message: `cinematographer: rolling on Seedance (${SHOOT_PROVIDER}/${SHOOT_MODEL}, ${mode})${
      voiceAudioUrls?.length ? ` + ${voiceAudioUrls.length} voice ref${voiceAudioUrls.length === 1 ? '' : 's'}` : ''
    }`,
  }
  const url = req.transitionFrames
    ? await callFirstLastFrame({
        prompt,
        firstFrameUrl: req.transitionFrames.firstFrameUrl,
        lastFrameUrl: req.transitionFrames.lastFrameUrl,
        durationSeconds, aspect, resolution,
      })
    : await callSeedance({
        prompt, keyframeUrl: req.keyframeUrl, storyboardRefUrl: req.storyboardRefUrl,
        referencePack: req.referencePack,
        voiceAudioUrls, durationSeconds, aspect, resolution,
        invitedImageAssetIds: req.invitedImageAssetIds,
        avatarAssetUris: req.virtualAvatarRefs?.map((r) => r.assetUri),
      })

  yield {
    type: 'result',
    payload: {
      url,
      prompt,
      durationSeconds,
      keyframeUrl: req.keyframeUrl,
      contextRefs: req.contextRefs ?? [],
    },
  }
}

// ─── Verb: revise ──────────────────────────────────────────────────

/**
 * Format director critique items as a numbered list for the revise prompt.
 * Severity is included so the LLM can prioritize blocking > major > minor.
 */
function formatFeedbackForRevise(feedback: ReviseRequest['feedback']): string {
  if (feedback.length === 0) return '(无 — 上一版通过，但导演要求重拍)'
  return feedback
    .map((f, i) => {
      const fix = f.fix ? ` → fix: ${f.fix}` : ''
      return `${i + 1}. [${f.severity}] (${f.aspect}) ${f.summary}${fix}`
    })
    .join('\n')
}

export async function* revise(
  req: ReviseRequest,
  ctx: ProjectContext,
): AgentGenerator<BeatVideoResult> {
  const shot = req.row.shot_number ?? '?'
  const durationSeconds = resolveEffectiveDurationSeconds({
    userRequested: req.durationSecondsOverride ?? req.row.duration ?? MIN_DURATION,
    dialogue: req.row.dialogue,
  })
  const aspect = req.aspect ?? '16:9'
  const resolution = req.resolution ?? SHOOT_RESOLUTION_DEFAULT

  if (!req.keyframeUrl) {
    throw new Error('cinematographer: revise requires keyframeUrl (omni-reference mode)')
  }

  yield {
    type: 'progress',
    message: `cinematographer: revising shot ${shot} based on ${req.feedback.length} director note(s)`,
  }

  // Ask the LLM to rewrite the prompt addressing each feedback item, then
  // we re-shoot with the rewritten prompt.
  const reviseInstruction = fillTemplate(TPL.revise, {
    previousPrompt: req.previous.prompt,
    feedback: formatFeedbackForRevise(req.feedback),
  })

  const revisedPrompt = (await ctx.llm.complete(
    [{ role: 'user', content: reviseInstruction }],
    { system: SYSTEM, signal: ctx.abort },
  )).trim()

  if (!revisedPrompt) {
    throw new Error('cinematographer: revise LLM returned empty rewrite')
  }

  yield {
    type: 'progress',
    message: `cinematographer: re-rolling on Seedance with revised prompt`,
  }
  // Re-ship the SAME reference set as the original shoot: without the
  // avatar asset refs a 真人 shot that only passed the privacy filter via
  // approved personas fails (or drifts faces) on the reshoot, and without
  // the pack/grid the reshoot loses its staging anchors.
  const url = await callSeedance({
    prompt: revisedPrompt,
    keyframeUrl: req.keyframeUrl,
    storyboardRefUrl: req.storyboardRefUrl,
    referencePack: req.referencePack,
    durationSeconds, aspect, resolution,
    avatarAssetUris: req.virtualAvatarRefs?.map((r) => r.assetUri),
  })

  yield {
    type: 'result',
    payload: {
      url,
      prompt: revisedPrompt,
      durationSeconds,
      keyframeUrl: req.keyframeUrl,
      contextRefs: req.contextRefs ?? [],
    },
  }
}

// ─── Verb: shootMultiStrategy ─────────────────────────────────────
//
// Generate N variants of the same shot in parallel, each with a different
// "strategy overlay" appended to the base prompt. Callers (currently the
// shot-editor multi-strategy panel) hand the array of variants back to
// the user so a human can pick the winner — no automated judge in this
// MVP. Cost scales linearly with N; default is 2.

const STRATEGY_OVERLAYS: Record<string, { description: string; overlay: string }> = {
  stable: {
    description: '保守稳定 — 镜头节奏内敛，构图忠实于 keyframe',
    overlay: '【STRATEGY OVERLAY: STABLE】\nKeep the camera restrained. Match the keyframe composition tightly. Subtle motion only; do not invent extra camera moves the keyframe does not suggest.',
  },
  balanced: {
    description: '中庸平衡 — 在 keyframe 忠实度和镜头活力之间取中',
    overlay: '【STRATEGY OVERLAY: BALANCED】\nModerate camera energy. Balance fidelity to keyframe with engaging motion. One clear camera move, no more.',
  },
  kinetic: {
    description: '激进有力 — 推拉摇移更夸张，节奏更紧',
    overlay: '【STRATEGY OVERLAY: KINETIC】\nDynamic, expressive camera. Push the action harder than the keyframe alone suggests. Stronger motion arcs, more aggressive framing changes.',
  },
}

export function pickStrategies(n: number): Array<{ name: string; description: string; overlay: string }> {
  if (n <= 1) return [{ name: 'default', description: '默认', overlay: '' }]
  const k = n === 2 ? ['stable', 'kinetic'] : ['stable', 'balanced', 'kinetic']
  return k.slice(0, n).map((name) => ({
    name,
    description: STRATEGY_OVERLAYS[name]!.description,
    overlay: STRATEGY_OVERLAYS[name]!.overlay,
  }))
}

export interface MultiStrategyRequest extends ShootRequest {
  /** Number of variants to render in parallel. Clamped to [2, 3]. */
  variants?: number
}

export async function* shootMultiStrategy(
  req: MultiStrategyRequest,
  ctx: ProjectContext,
): AgentGenerator<import('./schema').MultiStrategyResult> {
  const shot = req.row.shot_number ?? '?'
  const n = Math.min(3, Math.max(2, req.variants ?? 2))
  const durationSeconds = resolveEffectiveDurationSeconds({
    userRequested: req.durationSecondsOverride ?? req.row.duration ?? MIN_DURATION,
    dialogue: req.row.dialogue,
  })
  const aspect = req.aspect ?? '16:9'
  const resolution = req.resolution ?? SHOOT_RESOLUTION_DEFAULT

  if (!req.keyframeUrl) {
    throw new Error('cinematographer: shootMultiStrategy requires keyframeUrl')
  }

  void ctx

  yield {
    type: 'progress',
    message: `cinematographer: reading keyframe for cinematography language (shot ${shot}, ${n}-variant multi-strategy)`,
  }
  const cinematography = await describeKeyframeCinematography({
    keyframeUrl: req.keyframeUrl,
    row: req.row,
    visualStyle: req.visualStyle,
  })

  const basePrompt = assembleShootPrompt({
    row: req.row,
    keyframeUrl: req.keyframeUrl,
    storyboardRefUrl: req.storyboardRefUrl,
    referencePack: req.referencePack,
    contextRefs: req.contextRefs,
    visualStyle: req.visualStyle,
    cinematography,
    virtualAvatarRefs: req.virtualAvatarRefs,
  })

  const augmented = req.promptPostProcessor ? await req.promptPostProcessor(basePrompt) : basePrompt
  const prompt = typeof augmented === 'string' ? augmented : augmented.videoPrompt
  const voiceAudioUrls = typeof augmented === 'string' ? undefined : augmented.voiceAudioUrls

  const strategies = pickStrategies(n)
  const variantPrompts = strategies.map((s) => ({
    ...s,
    prompt: s.overlay ? `${prompt}\n\n${s.overlay}` : prompt,
  }))

  yield {
    type: 'progress',
    message: `cinematographer: rolling ${variantPrompts.length} parallel variants (${variantPrompts.map((v) => v.name).join(' / ')}) on Seedance — cost ${variantPrompts.length}×`,
  }

  const settled = await Promise.allSettled(
    variantPrompts.map((v) =>
      callSeedance({
        prompt: v.prompt,
        keyframeUrl: req.keyframeUrl,
        storyboardRefUrl: req.storyboardRefUrl,
        referencePack: req.referencePack,
        voiceAudioUrls,
        durationSeconds,
        aspect,
        resolution,
        invitedImageAssetIds: req.invitedImageAssetIds,
        avatarAssetUris: req.virtualAvatarRefs?.map((r) => r.assetUri),
      }),
    ),
  )

  const variants = settled
    .map((r, i) => ({ result: r, strategy: variantPrompts[i]! }))
    .filter((x): x is { result: PromiseFulfilledResult<string>; strategy: typeof variantPrompts[number] } =>
      x.result.status === 'fulfilled',
    )
    .map((x) => ({
      strategyName: x.strategy.name,
      strategyDescription: x.strategy.description,
      url: x.result.value,
      prompt: x.strategy.prompt,
      durationSeconds,
    }))

  const failures = settled
    .map((r, i) => ({ result: r, strategy: variantPrompts[i]! }))
    .filter((x): x is { result: PromiseRejectedResult; strategy: typeof variantPrompts[number] } =>
      x.result.status === 'rejected',
    )
    .map((x) => ({
      strategyName: x.strategy.name,
      reason: (x.result.reason as Error)?.message ?? String(x.result.reason),
    }))

  if (variants.length === 0) {
    throw new Error(
      `cinematographer: all ${n} variants failed. First failure: ${failures[0]?.reason ?? 'unknown'}`,
    )
  }

  yield {
    type: 'result',
    payload: {
      variants,
      failures,
      keyframeUrl: req.keyframeUrl,
      contextRefs: req.contextRefs ?? [],
    },
  }
}

// Pure helpers — exported for tests + reuse.
export {
  buildMotionDescription,
  buildContextRefLine,
  buildImageLegend,
  assembleShootPrompt,
  clampDuration,
}

// ─── Module metadata ──────────────────────────────────────────────

export const cinematographerAgent = {
  meta: {
    name: 'cinematographer-agent',
    description: 'Shoots and revises beat-video clips via Seedance 2.0',
    model: 'claude-sonnet-4-5',
  },
  systemPrompt: SYSTEM,
  shoot,
  revise,
  shootMultiStrategy,
} as const

export type {
  BeatVideoContextRef,
  BeatVideoRef,
  BeatVideoResult,
  BeatVideoRow,
  ReferencePackImage,
  ShootRequest,
  ReviseRequest,
  ShootVariant,
  MultiStrategyResult,
  VirtualAvatarShootRef,
} from './schema'
