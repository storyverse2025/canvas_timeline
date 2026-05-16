/**
 * script-agent — the script-domain orchestrator.
 *
 * Interview-before-work protocol follows .claude/skills/ai-script-creation-skill/SKILL.md:
 * eight clarification questions covering 项目类型, 平台/受众, 风格, 故事目标,
 * 角色数量, 禁忌内容, 输入形态, and sub-agent flow. Each question pre-selects a
 * recommended answer inferred from the script text + canvas context so a
 * detailed input still flows through in a few clicks.
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
  type ScriptDossier,
  type ScriptInputShape,
  type ScriptInterviewAnswers,
  type ScriptRequest,
  type ScriptSubAgent,
  type StoryGoal,
  type Taboo,
  type VisualStyle,
  ScriptDossierSchema,
  ScriptInputShapeSchema,
  ScriptSubAgentSchema,
} from './schema'

import skillSource from './SKILL.md?raw'
import expandScriptSource from './prompts/expand-script.md?raw'

const { body: SCRIPT_AGENT_SYSTEM } = parseFrontmatter(skillSource)
const { body: EXPAND_SCRIPT_TEMPLATE } = parseFrontmatter(expandScriptSource)

// ─── Interview options ──────────────────────────────────────────────

const PROJECT_TYPE_OPTIONS: Array<{ value: ProjectType; label: string }> = [
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

const PLATFORM_AUDIENCE_OPTIONS: Array<{ value: PlatformAudience; label: string; description: string }> = [
  { value: 'douyin-kuaishou-vertical', label: '抖音/快手', description: '竖屏 9:16，青年受众，节奏快' },
  { value: 'bilibili', label: 'B 站', description: '横屏 16:9，青少年-青年，二次元/动漫深度内容' },
  { value: 'youtube', label: 'YouTube', description: '横屏 16:9，全球/全年龄' },
  { value: 'wechat-video', label: '微信视频号', description: '熟人社交场域，中年商务向' },
  { value: 'cinema', label: '院线', description: '成年观众，长片，2.35:1 / 1.85:1' },
  { value: 'tv', label: '电视', description: '家庭/全年龄' },
  { value: 'cross-platform', label: '跨平台 / 未定', description: '保留多种比例与节奏可能' },
]

const VISUAL_STYLE_OPTIONS: Array<{ value: VisualStyle; label: string }> = [
  { value: 'follow-canvas-style', label: '跟随画布美术风格' },
  { value: 'anime-2d', label: '二次元 / 动漫' },
  { value: 'liveaction-film', label: '真人 / 电影' },
  { value: '3d-cg', label: '3D / CG' },
  { value: 'comic-book', label: '漫画 / 分镜手绘' },
  { value: 'painterly', label: '水彩 / 油画 / 手绘' },
  { value: 'other', label: '其他 / 自定义' },
]

const STORY_GOAL_OPTIONS: Array<{ value: StoryGoal; label: string }> = [
  { value: 'move-audience', label: '感动观众' },
  { value: 'comedy-relief', label: '搞笑解压' },
  { value: 'suspense-thriller', label: '紧张悬疑' },
  { value: 'romance-healing', label: '浪漫治愈' },
  { value: 'provoke-thought', label: '启发思考' },
  { value: 'sales-conversion', label: '卖货 / 转化' },
  { value: 'teach', label: '教学' },
  { value: 'spark-discussion', label: '引发讨论' },
]

const CHARACTER_COUNT_OPTIONS: Array<{ value: CharacterCount; label: string }> = [
  { value: 'solo', label: '1 人独白' },
  { value: 'duo', label: '2 人对话' },
  { value: 'small-ensemble', label: '3-5 人群像' },
  { value: 'large-ensemble', label: '6+ 人群像' },
]

const TABOO_OPTIONS: Array<{ value: Taboo; label: string }> = [
  { value: 'avoid-violence', label: '避免暴力' },
  { value: 'avoid-sexual', label: '避免性内容' },
  { value: 'avoid-political', label: '避免政治敏感' },
  { value: 'child-safe', label: '适合儿童' },
  { value: 'brand-safe', label: '品牌不可碰话题' },
]

const INPUT_SHAPE_OPTIONS: Array<{ value: ScriptInputShape; label: string; description: string }> = [
  { value: 'rough-idea', label: '一句话想法', description: '需要从零搭结构和节拍' },
  { value: 'partial-script', label: '局部大纲 / 部分剧本', description: '已有几条线，需要补齐' },
  { value: 'complete-draft', label: '完整剧本草稿', description: '主要需要诊断与清洁，不要重写' },
  { value: 'specific-scene', label: '单场戏', description: '只扩这一场，前后不动' },
]

const SUB_AGENT_OPTIONS: Array<{ value: ScriptSubAgent; label: string; description: string }> = [
  { value: 'default', label: '完整 Script → Casting 契约 (默认)', description: 'expand-script：框架+扩写+诊断+选角卡+视觉指令' },
  { value: 'framework-qa', label: '七层框架问答', description: '只走 framework-qa 子代理生成项目档案' },
  { value: 'writing-expansion', label: '完整剧本扩写', description: '走 writing-expansion 子代理（前提是档案已就绪）' },
  { value: 'doctor-roundtable', label: '圆桌会诊（只诊断）', description: '走 doctor-roundtable 子代理' },
  { value: 'dialogue-doctor', label: '台词医生（逐句诊断）', description: '走 dialogue-doctor 子代理' },
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

function recommendPlatformAudience(projectType: ProjectType): PlatformAudience {
  if (projectType === 'feature-film') return 'cinema'
  if (projectType === 'educational') return 'youtube'
  if (projectType === 'commercial') return 'cross-platform'
  if (projectType === 'mv') return 'bilibili'
  if (projectType === 'short-video-30s' || projectType === 'short-video-60s') return 'douyin-kuaishou-vertical'
  return 'douyin-kuaishou-vertical'
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

function recommendTaboos(text: string): Taboo[] {
  const out: Taboo[] = []
  if (/儿童|kids?|child/i.test(text)) out.push('child-safe')
  if (/品牌|brand|TVC/i.test(text)) out.push('brand-safe')
  return out
}

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
}

function pickFirst<T extends string>(answer: Answer | undefined, fallback: T): T {
  if (!answer) return fallback
  const choice = answer.selected[0] ?? answer.text?.trim() ?? ''
  return (choice as T) || fallback
}

function pickMulti<T extends string>(answer: Answer | undefined, fallback: T[]): T[] {
  if (!answer) return fallback
  if (answer.selected.length > 0) return answer.selected as T[]
  if (answer.text?.trim()) return [answer.text.trim() as T]
  return fallback
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

// ─── Agent factory ──────────────────────────────────────────────────

export function createScriptAgent(deps: ScriptAgentDeps = {}): AgentModule<
  ScriptRequest,
  ScriptDossier,
  ScriptDossier
> {
  const expandScriptTemplate = deps.expandScriptPrompt ?? EXPAND_SCRIPT_TEMPLATE

  async function* run(
    request: ScriptRequest,
    ctx: ProjectContext,
  ): AgentGenerator<ScriptDossier> {
    if (!request.scriptText || request.scriptText.trim().length === 0) {
      throw new Error('script-agent: scriptText is required')
    }

    // Q1: 项目类型 (题材 + 时长)
    const recProjectType = recommendProjectType(request.scriptText)
    const projectTypeAns = (yield {
      type: 'question',
      question: {
        q: '项目类型？(题材 + 时长)',
        header: '项目类型',
        options: PROJECT_TYPE_OPTIONS,
        recommended: recProjectType,
      },
    }) as Answer | undefined
    const projectType = pickFirst<ProjectType>(projectTypeAns, recProjectType)

    // Q2: 平台 + 受众
    const recPlatform = recommendPlatformAudience(projectType)
    const platformAns = (yield {
      type: 'question',
      question: {
        q: '目标平台 / 受众？',
        header: '平台/受众',
        options: PLATFORM_AUDIENCE_OPTIONS.map((o) => ({
          value: o.value, label: o.label, description: o.description,
        })),
        recommended: recPlatform,
      },
    }) as Answer | undefined
    const platformAudience = pickFirst<PlatformAudience>(platformAns, recPlatform)

    // Q3: 视觉风格
    const visualStyleAns = (yield {
      type: 'question',
      question: {
        q: '视觉风格？(默认跟随画布的全局美术风格)',
        header: '视觉风格',
        options: VISUAL_STYLE_OPTIONS,
        recommended: 'follow-canvas-style',
      },
    }) as Answer | undefined
    const visualStyle = pickFirst<VisualStyle>(visualStyleAns, 'follow-canvas-style')

    // Q4: 故事目标 / 核心情绪
    const recStoryGoal = recommendStoryGoal(request.scriptText)
    const storyGoalAns = (yield {
      type: 'question',
      question: {
        q: '故事目标 / 核心情绪？(你希望观众看完后是什么状态？)',
        header: '故事目标',
        options: STORY_GOAL_OPTIONS,
        recommended: recStoryGoal,
      },
    }) as Answer | undefined
    const storyGoal = pickFirst<StoryGoal>(storyGoalAns, recStoryGoal)

    // Q5: 角色数量
    const recCharCount = recommendCharacterCount(request.scriptText)
    const charCountAns = (yield {
      type: 'question',
      question: {
        q: '角色数量？',
        header: '角色数量',
        options: CHARACTER_COUNT_OPTIONS,
        recommended: recCharCount,
      },
    }) as Answer | undefined
    const characterCount = pickFirst<CharacterCount>(charCountAns, recCharCount)

    // Q6: 禁忌内容 (multi-select)
    const recTaboos = recommendTaboos(request.scriptText)
    const taboosAns = (yield {
      type: 'question',
      question: {
        q: '内容禁忌？(可多选；选项不勾即"无")',
        header: '禁忌',
        options: TABOO_OPTIONS,
        recommended: recTaboos[0] ?? null,
        multiSelect: true,
      },
    }) as Answer | undefined
    const taboos = pickMulti<Taboo>(taboosAns, recTaboos)

    // Q7: 输入形态
    const recInputShape = recommendInputShape(request.scriptText)
    const inputShapeAns = (yield {
      type: 'question',
      question: {
        q: '你带来的是什么形态的输入？',
        header: '输入形态',
        options: INPUT_SHAPE_OPTIONS,
        recommended: recInputShape,
      },
    }) as Answer | undefined
    const inputShape = ScriptInputShapeSchema.parse(pickFirst(inputShapeAns, recInputShape))

    // Q8: 子工作流
    const subAgentAns = (yield {
      type: 'question',
      question: {
        q: '本轮跑哪一条剧本工作流？',
        header: '工作流',
        options: SUB_AGENT_OPTIONS,
        recommended: 'default',
      },
    }) as Answer | undefined
    const subAgent = ScriptSubAgentSchema.parse(pickFirst(subAgentAns, 'default'))

    const answers: ScriptInterviewAnswers = {
      projectType, platformAudience, visualStyle, storyGoal,
      characterCount, taboos, inputShape, subAgent,
    }

    // Recap (per SKILL: "生成长稿前，要求模型复述关键设定并等待确认").
    // The recap surfaces in chat as a system message via the chat bridge so
    // the user can see what's locked in before the LLM call.
    yield {
      type: 'progress',
      message: [
        '关键设定已锁定 (按 SKILL 八步清单):',
        `- 项目类型: ${labelOf(projectType, PROJECT_TYPE_OPTIONS)}`,
        `- 平台/受众: ${labelOf(platformAudience, PLATFORM_AUDIENCE_OPTIONS)}`,
        `- 视觉风格: ${labelOf(visualStyle, VISUAL_STYLE_OPTIONS)}`,
        `- 故事目标: ${labelOf(storyGoal, STORY_GOAL_OPTIONS)}`,
        `- 角色数量: ${labelOf(characterCount, CHARACTER_COUNT_OPTIONS)}`,
        `- 禁忌: ${taboos.length === 0 ? '无' : taboos.map((t) => labelOf(t, TABOO_OPTIONS)).join(' / ')}`,
        `- 输入形态: ${labelOf(inputShape, INPUT_SHAPE_OPTIONS)}`,
        `- 工作流: ${labelOf(subAgent, SUB_AGENT_OPTIONS)}`,
      ].join('\n'),
    }

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
      persistDossier(dossier, ctx)
      yield { type: 'result', payload: dossier }
      return
    }

    yield { type: 'progress', message: 'running default expand-script flow' }

    const taboosText = taboos.length === 0
      ? '无'
      : taboos.map((t) => labelOf(t, TABOO_OPTIONS)).join('；')

    const totalDurationText =
      request.totalDurationSeconds && request.totalDurationSeconds > 0
        ? `${request.totalDurationSeconds} 秒（最终分镜表每行时长之和必须等于此总时长）`
        : '未指定（由项目类型推断）'

    const filled = fillTemplate(expandScriptTemplate, {
      scriptText: request.scriptText,
      artStyle: ctx.project.style.get().promptText || ctx.project.style.get().presetId,
      canvasContext: request.canvasContext ?? '',
      existingStoryboard: request.existingStoryboard ?? '',
      projectType: labelOf(projectType, PROJECT_TYPE_OPTIONS),
      platformAudience: labelOf(platformAudience, PLATFORM_AUDIENCE_OPTIONS),
      visualStyle: labelOf(visualStyle, VISUAL_STYLE_OPTIONS),
      storyGoal: labelOf(storyGoal, STORY_GOAL_OPTIONS),
      characterCount: labelOf(characterCount, CHARACTER_COUNT_OPTIONS),
      taboos: taboosText,
      inputShape: labelOf(inputShape, INPUT_SHAPE_OPTIONS),
      totalDuration: totalDurationText,
    })

    const llmResponse = await ctx.llm.complete(
      [{ role: 'user', content: filled }],
      { system: SCRIPT_AGENT_SYSTEM, signal: ctx.abort },
    )

    const json = extractFirstJsonObject(llmResponse)
    const dossier = parseDossierStrict(json)
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

export type { ScriptDossier, ScriptRequest, ScriptInterviewAnswers } from './schema'
