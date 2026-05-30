/**
 * script-agent — the script-domain orchestrator.
 *
 * Interview-before-work protocol (v2):
 *  - Hard constraints (项目类型 / 总时长 / 平台-受众 / 视觉风格 / 故事目标 /
 *    角色数量 / 输入形态 / 子工作流) are auto-inferred from the script text +
 *    canvas context. 平台/受众 is locked to "成人 / 院线" per product spec.
 *  - The actual interview consists of 3-5 LLM-generated questions that point
 *    at this specific script's ambiguities — main character motive, ending
 *    direction, antagonist identity, key prop function, etc. The LLM produces
 *    the question list, the user answers each via the standard Question/Answer
 *    runtime protocol, and the answers are threaded into expand-script as
 *    `scriptClarifications`.
 *
 * After the interview, emits a recap as a progress turn (so the user sees what
 * settings the LLM is about to receive), then either delegates to a sub-agent
 * or runs the default expand-script flow.
 */

import { z } from 'zod'

import { delegate } from '@/lib/agents/_shared/runtime/runner'
import type {
  AgentGenerator,
  AgentModule,
  Answer,
  Question,
  QuestionOption,
} from '@/lib/agents/_shared/runtime/types'
import type { ProjectContext } from '@/lib/agents/_shared/context/types'
import {
  fillTemplate,
  parseFrontmatter,
} from '@/lib/agents/_shared/mustache'

import {
  type CharacterCount,
  type PlatformAudience,
  type ProjectType,
  type ScriptClarification,
  type ScriptDossier,
  type ScriptInputShape,
  type ScriptInterviewAnswers,
  type ScriptRequest,
  type ScriptSubAgent,
  type StoryGoal,
  type Taboo,
  type VisualStyle,
  ProjectTypeSchema,
  StoryGoalSchema,
  CharacterCountSchema,
  ScriptInputShapeSchema,
  ScriptDossierSchema,
} from './schema'

import skillSource from './SKILL.md?raw'
import expandScriptSource from './prompts/expand-script.md?raw'
import askScriptQuestionsSource from './prompts/ask-script-questions.md?raw'

const { body: SCRIPT_AGENT_SYSTEM } = parseFrontmatter(skillSource)
const { body: EXPAND_SCRIPT_TEMPLATE } = parseFrontmatter(expandScriptSource)
const { body: ASK_SCRIPT_QUESTIONS_TEMPLATE } = parseFrontmatter(askScriptQuestionsSource)

// ─── Label tables ──────────────────────────────────────────────
// These no longer drive user-facing options (we don't ask static questions
// anymore); they exist purely so the expand-script prompt receives the same
// human-readable label strings that were used before this refactor. Keep them
// in sync with the schema enums so labelOf() never falls through to the raw
// kebab-case value.

const PROJECT_TYPE_LABELS: Array<{ value: ProjectType; label: string }> = [
  { value: 'short-video-30s', label: '短视频 (15-30秒)' },
  { value: 'short-video-60s', label: '短视频 (30-60秒)' },
  { value: 'ai-comic-series', label: 'AI 漫剧 (单集 10-30 分钟)' },
  { value: 'short-drama-episode', label: '短剧单集 (10-30 分钟)' },
  { value: 'mv', label: 'MV (3-5 分钟)' },
  { value: 'commercial', label: '广告 (15-60秒)' },
  { value: 'educational', label: '教育视频 (3-10 分钟)' },
  { value: 'feature-film', label: '院线长片 (90-120 分钟)' },
  { value: 'other', label: '其他 / 未定' },
]

const PLATFORM_AUDIENCE_LABELS: Array<{ value: PlatformAudience; label: string }> = [
  { value: 'douyin-kuaishou-vertical', label: '抖音/快手' },
  { value: 'bilibili', label: 'B 站' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'wechat-video', label: '微信视频号' },
  { value: 'cinema', label: '院线（成人受众）' },
  { value: 'tv', label: '电视' },
  { value: 'cross-platform', label: '跨平台 / 未定' },
]

const VISUAL_STYLE_LABELS: Array<{ value: VisualStyle; label: string }> = [
  { value: 'follow-canvas-style', label: '跟随画布美术风格' },
  { value: 'anime-2d', label: '二次元 / 动漫' },
  { value: 'liveaction-film', label: '真人 / 电影' },
  { value: '3d-cg', label: '3D / CG' },
  { value: 'comic-book', label: '漫画 / 分镜手绘' },
  { value: 'painterly', label: '水彩 / 油画 / 手绘' },
  { value: 'other', label: '其他 / 自定义' },
]

const STORY_GOAL_LABELS: Array<{ value: StoryGoal; label: string }> = [
  { value: 'move-audience', label: '感动观众' },
  { value: 'comedy-relief', label: '搞笑解压' },
  { value: 'suspense-thriller', label: '紧张悬疑' },
  { value: 'romance-healing', label: '浪漫治愈' },
  { value: 'provoke-thought', label: '启发思考' },
  { value: 'sales-conversion', label: '卖货 / 转化' },
  { value: 'teach', label: '教学' },
  { value: 'spark-discussion', label: '引发讨论' },
]

const CHARACTER_COUNT_LABELS: Array<{ value: CharacterCount; label: string }> = [
  { value: 'solo', label: '1 人独白' },
  { value: 'duo', label: '2 人对话' },
  { value: 'small-ensemble', label: '3-5 人群像' },
  { value: 'large-ensemble', label: '6+ 人群像' },
]

const TABOO_LABELS: Array<{ value: Taboo; label: string }> = [
  { value: 'avoid-violence', label: '避免暴力' },
  { value: 'avoid-sexual', label: '避免性内容' },
  { value: 'avoid-political', label: '避免政治敏感' },
  { value: 'child-safe', label: '适合儿童' },
  { value: 'brand-safe', label: '品牌不可碰话题' },
]

const INPUT_SHAPE_LABELS: Array<{ value: ScriptInputShape; label: string }> = [
  { value: 'rough-idea', label: '一句话想法' },
  { value: 'partial-script', label: '局部大纲 / 部分剧本' },
  { value: 'complete-draft', label: '完整剧本草稿' },
  { value: 'specific-scene', label: '单场戏' },
]

const SUB_AGENT_LABELS: Array<{ value: ScriptSubAgent; label: string }> = [
  { value: 'default', label: '完整 Script → Casting 契约 (默认)' },
  { value: 'framework-qa', label: '七层框架问答' },
  { value: 'writing-expansion', label: '完整剧本扩写' },
  { value: 'doctor-roundtable', label: '圆桌会诊（只诊断）' },
  { value: 'dialogue-doctor', label: '台词医生（逐句诊断）' },
]

// ─── Heuristic recommendations ──────────────────────────────────────

function recommendInputShape(text: string): ScriptInputShape {
  const len = text.trim().length
  if (len < 200) return 'rough-idea'
  if (len < 1500) return 'partial-script'
  return 'complete-draft'
}

function recommendProjectType(text: string): ProjectType {
  const t = text.toLowerCase()
  if (/漫剧|多格分镜|panels?\b/i.test(text)) return 'ai-comic-series'
  if (/\bmv\b|music\s*video|歌词|主歌|副歌/i.test(text)) return 'mv'
  if (/广告|tvc\b|品牌|commercial/i.test(t)) return 'commercial'
  if (/教育|tutorial|教学|课程/i.test(t)) return 'educational'
  if (/院线|长片|feature/i.test(t)) return 'feature-film'
  const len = text.trim().length
  if (len < 300) return 'short-video-30s'
  if (len < 800) return 'short-video-60s'
  return 'short-drama-episode'
}

/**
 * When the caller has already locked `totalDurationSeconds`, infer the
 * project type from the duration. The keyword-based recommendation still
 * overrides if it's a more specific type (MV, commercial, educational) —
 * those carry information the duration alone can't capture.
 */
function inferProjectTypeFromKnown(
  totalDurationSeconds: number,
  keywordRecommendation: ProjectType,
): ProjectType {
  // Specific types beat duration-based inference because they encode genre,
  // not just length.
  const specific: ProjectType[] = ['ai-comic-series', 'mv', 'commercial', 'educational']
  if (specific.includes(keywordRecommendation)) return keywordRecommendation

  if (totalDurationSeconds <= 30) return 'short-video-30s'
  if (totalDurationSeconds <= 60) return 'short-video-60s'
  if (totalDurationSeconds <= 300) return 'mv' // 1-5 minutes default to MV-length
  if (totalDurationSeconds <= 1800) return 'short-drama-episode'
  return 'feature-film'
}

function recommendStoryGoal(text: string): StoryGoal {
  if (/搞笑|笑点|喜剧|逗|滑稽/i.test(text)) return 'comedy-relief'
  if (/感动|催泪|泪|心碎|思念/i.test(text)) return 'move-audience'
  if (/悬疑|凶案|侦探|惊悚|thriller|凶杀|案件/i.test(text)) return 'suspense-thriller'
  if (/爱情|浪漫|恋|romance|告白|约会/i.test(text)) return 'romance-healing'
  if (/启发|反思|哲思|意义|存在/i.test(text)) return 'provoke-thought'
  if (/卖货|转化|促销|带货|sell/i.test(text)) return 'sales-conversion'
  if (/教学|课|讲解|teach/i.test(text)) return 'teach'
  return 'move-audience'
}

function recommendCharacterCount(text: string): CharacterCount {
  // Direct phrasing takes priority over dialogue scanning.
  if (/独白|monologue|1\s*人|一人\b|一个人/i.test(text)) return 'solo'
  if (/双人|两人|2\s*人|对话|dialogue\b/i.test(text)) return 'duo'
  if (/(三|四|五|3|4|5)\s*人|few\s+characters|small\s+ensemble/i.test(text)) return 'small-ensemble'
  if (/群像|多人|众生|大群|6\s*人|7\s*人|\d{2,}\s*人|ensemble cast/i.test(text)) return 'large-ensemble'
  // Fall back to counting distinct dialogue speakers.
  const dialogueMarkers = text.match(/[一-龥A-Za-z]{1,8}[：:](?=\s*[一-龥A-Za-z"'])/g) ?? []
  const names = new Set(dialogueMarkers.map((m) => m.replace(/[：:]/, '')))
  const n = names.size
  if (n <= 1) return 'solo'
  if (n === 2) return 'duo'
  if (n <= 5) return 'small-ensemble'
  return 'large-ensemble'
}

// ─── LLM-generated questions schema ────────────────────────────────

const GeneratedQuestionOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
})
const GeneratedQuestionSchema = z.object({
  q: z.string().min(1),
  header: z.string().min(1).optional(),
  options: z.array(GeneratedQuestionOptionSchema).min(2).max(6),
  recommended: z.string().optional(),
})
const AskScriptQuestionsResponseSchema = z.object({
  questions: z.array(GeneratedQuestionSchema).min(1).max(6),
})

type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>

// ─── Helpers ────────────────────────────────────────────────────────

interface SubAgentRunner {
  run(
    request: { scriptText: string; answers: ScriptInterviewAnswers },
    ctx: ProjectContext,
  ): AgentGenerator<ScriptDossier>
}

export interface ScriptAgentDeps {
  subAgents?: Partial<Record<Exclude<ScriptSubAgent, 'default'>, SubAgentRunner>>
  expandScriptPrompt?: string
  askScriptQuestionsPrompt?: string
}

function labelOf<T extends string>(value: T, options: Array<{ value: T; label: string }>): string {
  return options.find((o) => o.value === value)?.label ?? value
}

function extractFirstJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidates = [fence?.[1], text].filter((c): c is string => typeof c === 'string')
  for (const c of candidates) {
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start < 0 || end < 0 || end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch { /* try next */ }
  }
  throw new Error('script-agent: model output did not contain a parseable JSON object')
}

function persistDossier(dossier: ScriptDossier, ctx: ProjectContext): void {
  for (const card of dossier.casting_cards) {
    ctx.project.characters.add({
      name: card.name,
      description: [
        card.dramatic_function,
        card.appearance_for_image,
        card.personality_layers,
        card.performance_anchors && `表演锚点：${card.performance_anchors}`,
        card.voice_print && `声纹：${card.voice_print}`,
      ].filter(Boolean).join('\n'),
    })
  }
  for (const card of dossier.scene_cards) {
    ctx.project.scenes.add({
      name: card.name,
      description: [card.location, card.time_of_day, card.mood, card.visual_requirements]
        .filter(Boolean).join(' / '),
    })
  }
  for (const card of dossier.prop_cards) {
    ctx.project.props.add({
      name: card.name,
      description: [card.description, card.dramatic_significance].filter(Boolean).join(' — '),
    })
  }
  for (let i = 0; i < dossier.expanded_script_baseline.beat_summary.length; i++) {
    const summary = dossier.expanded_script_baseline.beat_summary[i]!
    ctx.project.beats.add({
      id: `B${i + 1}`,
      summary,
      body: summary,
    })
  }
}

function parseDossierStrict(json: unknown): ScriptDossier {
  const parsed = ScriptDossierSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `script-agent: dossier JSON failed validation: ${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
}

function formatClarificationsBlock(items: ScriptClarification[]): string {
  if (items.length === 0) return '（采访官未提出额外问题，按已锁定设定进行扩写。）'
  return items
    .map((c, i) => `Q${i + 1}: ${c.q}\nA${i + 1}: ${c.answer}`)
    .join('\n\n')
}

// ─── Agent factory ──────────────────────────────────────────────────

export function createScriptAgent(deps: ScriptAgentDeps = {}): AgentModule<
  ScriptRequest,
  ScriptDossier,
  ScriptDossier
> {
  const expandScriptTemplate = deps.expandScriptPrompt ?? EXPAND_SCRIPT_TEMPLATE
  const askScriptQuestionsTemplate =
    deps.askScriptQuestionsPrompt ?? ASK_SCRIPT_QUESTIONS_TEMPLATE

  async function* run(
    request: ScriptRequest,
    ctx: ProjectContext,
  ): AgentGenerator<ScriptDossier> {
    if (!request.scriptText || request.scriptText.trim().length === 0) {
      throw new Error('script-agent: scriptText is required')
    }

    // Merge legacy top-level totalDurationSeconds into knownContext.
    const knownContext = {
      ...(request.knownContext ?? {}),
      totalDurationSeconds:
        request.totalDurationSeconds ?? request.knownContext?.totalDurationSeconds,
    }

    // ── 1. Auto-infer the hard constraints ─────────────────────────
    // platformAudience is fixed by product spec (院线成人) and visualStyle is
    // locked by the canvas. The rest — projectType / storyGoal / characterCount
    // / inputShape — are NOT decided here: keyword/length regex on the raw
    // script misfires (a script that *mentions* 公益广告 is not itself a 广告;
    // "每一滴眼泪" in a dystopian PSA is not a tear-jerker goal; a 1500-char
    // cutoff mislabels a complete short-film script as a 部分剧本; background
    // 群众 inflate the character count). The interview LLM in step 2 already
    // reads the whole script, so it classifies all four semantically. The
    // heuristics below are kept only as a fallback for when that call fails.

    const recProjectType = recommendProjectType(request.scriptText)
    const fallbackProjectType: ProjectType =
      knownContext.totalDurationSeconds && knownContext.totalDurationSeconds > 0
        ? inferProjectTypeFromKnown(knownContext.totalDurationSeconds, recProjectType)
        : recProjectType
    const fallbackStoryGoal: StoryGoal = recommendStoryGoal(request.scriptText)
    const fallbackCharacterCount: CharacterCount = recommendCharacterCount(request.scriptText)
    const fallbackInputShape: ScriptInputShape = recommendInputShape(request.scriptText)

    // Locked: every script-agent run targets adult cinema audiences. The
    // canvas does not (yet) expose a platform picker, and the product
    // direction is 院线 across the board.
    const platformAudience: PlatformAudience = 'cinema'

    // If the canvas carries a global visual style, expand-script picks it up
    // via {{artStyle}}; we lock visualStyle to 'follow-canvas-style' so the
    // dossier explicitly defers to the canvas.
    const visualStyle: VisualStyle = 'follow-canvas-style'

    // Cast through the schema type so TS doesn't literal-narrow `subAgent`
    // to 'default' and prove the sub-agent dispatch branch unreachable.
    // When sub-agents are wired up this initializer will be replaced with
    // the LLM-selected variant.
    const subAgent = 'default' as ScriptSubAgent
    const taboos: Taboo[] = []

    const totalDurationText =
      knownContext.totalDurationSeconds && knownContext.totalDurationSeconds > 0
        ? `${knownContext.totalDurationSeconds} 秒（最终分镜表每行时长之和必须等于此总时长）`
        : '未指定（由项目类型推断）'

    // ── 2. LLM-generated clarifying questions + semantic classification ─
    // The interview LLM reads the whole script, so it both writes the
    // script-specific questions AND classifies projectType / storyGoal /
    // characterCount / inputShape (ignoring in-world words, counting only
    // dramatic characters, judging completeness not raw length). We do NOT
    // pre-feed the regex guesses — that would just bias the classifier back
    // toward their mistakes.
    yield { type: 'progress', message: 'script-agent: 让采访官读剧本、生成针对性问题并语义判定体裁/情绪目标/角色数量/输入形态' }

    const askPrompt = fillTemplate(askScriptQuestionsTemplate, {
      scriptText: request.scriptText,
      canvasContext: request.canvasContext ?? '',
      artStyle: ctx.project.style.get().promptText || ctx.project.style.get().presetId,
      totalDuration: totalDurationText,
    })

    let generatedQuestions: GeneratedQuestion[] = []
    // Filled from the classifier; left undefined so we fall back to the
    // keyword heuristics when the call fails or returns an invalid enum.
    let llmProjectType: ProjectType | undefined
    let llmStoryGoal: StoryGoal | undefined
    let llmCharacterCount: CharacterCount | undefined
    let llmInputShape: ScriptInputShape | undefined
    try {
      const askResponse = await ctx.llm.complete(
        [{ role: 'user', content: askPrompt }],
        { system: SCRIPT_AGENT_SYSTEM, signal: ctx.abort },
      )
      const rawAsk = extractFirstJsonObject(askResponse)
      const parsed = AskScriptQuestionsResponseSchema.parse(rawAsk)
      generatedQuestions = parsed.questions
      // Read the classifier fields loosely: a bad enum must never nuke the
      // questions we just parsed, so we safeParse them off the raw object.
      const rawObj = (rawAsk ?? {}) as Record<string, unknown>
      const ptParse = ProjectTypeSchema.safeParse(rawObj.inferred_project_type)
      if (ptParse.success) llmProjectType = ptParse.data
      const sgParse = StoryGoalSchema.safeParse(rawObj.inferred_story_goal)
      if (sgParse.success) llmStoryGoal = sgParse.data
      const ccParse = CharacterCountSchema.safeParse(rawObj.inferred_character_count)
      if (ccParse.success) llmCharacterCount = ccParse.data
      const isParse = ScriptInputShapeSchema.safeParse(rawObj.inferred_input_shape)
      if (isParse.success) llmInputShape = isParse.data
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      yield {
        type: 'progress',
        message: `script-agent: 采访官生成问题失败 (${detail})，跳过澄清直接进入扩写`,
      }
    }

    // Reconcile the semantic classification with the known duration and the
    // keyword fallback. Duration still bounds the length-based buckets via
    // inferProjectTypeFromKnown (so a 120s piece never becomes a feature
    // film), but a genuine genre call from the LLM (commercial / mv / …)
    // wins over the regex — and the regex no longer mislabels a dystopian
    // narrative as 广告 just because it mentions a PSA.
    const projectType: ProjectType =
      knownContext.totalDurationSeconds && knownContext.totalDurationSeconds > 0
        ? inferProjectTypeFromKnown(
            knownContext.totalDurationSeconds,
            llmProjectType ?? recProjectType,
          )
        : (llmProjectType ?? fallbackProjectType)
    const storyGoal: StoryGoal = llmStoryGoal ?? fallbackStoryGoal
    const characterCount: CharacterCount = llmCharacterCount ?? fallbackCharacterCount
    const inputShape: ScriptInputShape = llmInputShape ?? fallbackInputShape
    const projectTypeSource = llmProjectType ? '语义判定' : '关键词回退'
    const storyGoalSource = llmStoryGoal ? '语义判定' : '关键词回退'
    const characterCountSource = llmCharacterCount ? '语义判定' : '关键词回退'
    const inputShapeSource = llmInputShape ? '语义判定' : '长度回退'

    // ── 3. Yield each generated question, collect answer ───────────
    const clarifications: ScriptClarification[] = []
    for (const gen of generatedQuestions) {
      const options: QuestionOption[] = gen.options.map((o) => ({
        value: o.value,
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      }))
      const recommended =
        gen.recommended && options.some((o) => o.value === gen.recommended)
          ? gen.recommended
          : options[0]?.value ?? null
      const question: Question = {
        q: gen.q,
        ...(gen.header ? { header: gen.header } : {}),
        options,
        recommended,
      }
      const ans = (yield { type: 'question', question }) as Answer | undefined

      // Resolve the user's answer to a human-readable label so the
      // expand-script prompt reads naturally.
      const freeText = ans?.text?.trim()
      const selected = ans?.selected[0]
      const chosenValue = selected ?? recommended ?? options[0]?.value ?? ''
      const chosenLabel =
        options.find((o) => o.value === chosenValue)?.label ?? chosenValue
      const answerText = freeText
        ? `${chosenLabel}（用户补充：${freeText}）`
        : chosenLabel
      clarifications.push({ q: gen.q, answer: answerText })
    }

    const answers: ScriptInterviewAnswers = {
      projectType,
      platformAudience,
      visualStyle,
      storyGoal,
      characterCount,
      taboos,
      inputShape,
      subAgent,
      clarifications,
    }

    // ── 4. Recap ───────────────────────────────────────────────────
    // Surface every locked-in fact + every clarification before the LLM
    // call, so the user can spot any inferred-wrong setting and the new
    // script-derived Q&A is auditable.
    const recapLines: string[] = ['关键设定已锁定:']
    recapLines.push('  · 自动推断 (无需提问):')
    recapLines.push(`    - 项目类型: ${labelOf(projectType, PROJECT_TYPE_LABELS)}（${projectTypeSource}）`)
    recapLines.push(`    - 总时长: ${totalDurationText}`)
    recapLines.push(`    - 平台/受众: ${labelOf(platformAudience, PLATFORM_AUDIENCE_LABELS)}（固定）`)
    recapLines.push(`    - 视觉风格: ${labelOf(visualStyle, VISUAL_STYLE_LABELS)}`)
    if (knownContext.aspectRatio) {
      recapLines.push(`    - 画面比例: ${knownContext.aspectRatio} (沿用画布设置)`)
    }
    if (knownContext.visualStyle) {
      recapLines.push(`    - 画布美术: ${knownContext.visualStyle}`)
    }
    recapLines.push(`    - 故事目标: ${labelOf(storyGoal, STORY_GOAL_LABELS)}（${storyGoalSource}）`)
    recapLines.push(`    - 角色数量: ${labelOf(characterCount, CHARACTER_COUNT_LABELS)}（${characterCountSource}）`)
    recapLines.push(`    - 输入形态: ${labelOf(inputShape, INPUT_SHAPE_LABELS)}（${inputShapeSource}）`)
    recapLines.push(`    - 工作流: ${labelOf(subAgent, SUB_AGENT_LABELS)}`)
    if (clarifications.length > 0) {
      recapLines.push('  · 采访官针对该剧本提问的澄清:')
      for (const c of clarifications) {
        recapLines.push(`    - ${c.q} → ${c.answer}`)
      }
    } else {
      recapLines.push('  · 采访官未提出额外澄清问题')
    }
    yield { type: 'progress', message: recapLines.join('\n') }

    // ── 5. Sub-agent dispatch or default expand-script ─────────────
    if (subAgent !== 'default') {
      const runner = deps.subAgents?.[subAgent]
      if (!runner) {
        throw new Error(
          `script-agent: sub-agent "${subAgent}" is not wired yet. ` +
            `Pass deps.subAgents.${subAgent} or wait for the sub-agent migration commit.`,
        )
      }
      yield { type: 'progress', message: `delegating to ${subAgent} sub-agent` }
      const sub = runner.run({ scriptText: request.scriptText, answers }, ctx)
      const dossier = yield* delegate(sub)
      // Same clarifications-stamp as the default path so downstream
      // sees them regardless of which sub-agent produced the dossier.
      dossier.clarifications = clarifications
      persistDossier(dossier, ctx)
      yield { type: 'result', payload: dossier }
      return
    }

    yield { type: 'progress', message: 'running default expand-script flow' }

    const taboosText = taboos.length === 0
      ? '无'
      : taboos.map((t) => labelOf(t, TABOO_LABELS)).join('；')

    const filled = fillTemplate(expandScriptTemplate, {
      scriptText: request.scriptText,
      artStyle: ctx.project.style.get().promptText || ctx.project.style.get().presetId,
      canvasContext: request.canvasContext ?? '',
      existingStoryboard: request.existingStoryboard ?? '',
      projectType: labelOf(projectType, PROJECT_TYPE_LABELS),
      platformAudience: labelOf(platformAudience, PLATFORM_AUDIENCE_LABELS),
      visualStyle: labelOf(visualStyle, VISUAL_STYLE_LABELS),
      storyGoal: labelOf(storyGoal, STORY_GOAL_LABELS),
      characterCount: labelOf(characterCount, CHARACTER_COUNT_LABELS),
      taboos: taboosText,
      inputShape: labelOf(inputShape, INPUT_SHAPE_LABELS),
      totalDuration: totalDurationText,
      scriptClarifications: formatClarificationsBlock(clarifications),
    })

    const llmResponse = await ctx.llm.complete(
      [{ role: 'user', content: filled }],
      { system: SCRIPT_AGENT_SYSTEM, signal: ctx.abort },
    )

    const json = extractFirstJsonObject(llmResponse)
    const dossier = parseDossierStrict(json)
    // Stamp the ask-phase clarifications onto the dossier so downstream
    // stages (critique-timeline, art-director) can verify their output
    // against what the user actually answered. The LLM doesn't see these
    // in its output schema — they're collected by the runtime above.
    dossier.clarifications = clarifications
    persistDossier(dossier, ctx)
    yield { type: 'result', payload: dossier }
  }

  return {
    meta: {
      name: 'script-agent',
      description: 'Top-level script-domain agent',
      model: 'claude-sonnet-4-5',
    },
    systemPrompt: SCRIPT_AGENT_SYSTEM,
    run,
  }
}

export const scriptAgent = createScriptAgent()

export type {
  ScriptClarification,
  ScriptDossier,
  ScriptRequest,
  ScriptInterviewAnswers,
} from './schema'
