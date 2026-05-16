import { describe, it, expect, vi } from 'vitest'

import { createScriptAgent } from '@/lib/agents/script-agent'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { drive, driveAuto } from '@/lib/agents/_shared/runtime/runner'
import type { Answer } from '@/lib/agents/_shared/runtime/types'
import type { LLM } from '@/lib/agents/_shared/llm/types'
import type {
  ScriptDossier,
  ScriptInterviewAnswers,
} from '@/lib/agents/script-agent/schema'

function makeDossierJson(): ScriptDossier {
  return {
    framework_calibration: {
      logline: '一段关于侦探的故事',
      duration_or_episode_type: '90分钟短片',
      platform_bias: '院线',
      core_emotion: '悬疑+救赎',
      main_risk: '主角动机不清晰',
    },
    expanded_script_baseline: {
      format: '标准影视',
      script_text: 'Beat 1...\nBeat 2...',
      beat_summary: ['开场遇害', '调查线索', '真相揭露'],
    },
    doctor_roundtable_summary: {
      must_fix: ['二幕节奏拖沓'],
      keep: ['开场氛围'],
      open_questions: ['主角与对手的关系'],
    },
    dialogue_diagnosis_summary: {
      voice_print_risks: ['配角语气过于相似'],
      subtext_risks: ['关键场景缺少潜台词'],
      rewrite_notes: ['第3场对白过于直白 — 改为反问'],
    },
    casting_cards: [
      {
        name: '林清',
        dramatic_function: '主角',
        age_range: '30-35',
        gender_presentation: '女',
        appearance_for_image: '短发，灰色风衣',
        personality_layers: '冷静 / 怀疑 / 自责',
        voice_print: '短句，少修饰',
        performance_anchors: '眉头微皱 / 手指轻敲',
        casting_notes: '需要演员的眼神戏',
      },
    ],
    scene_cards: [
      {
        name: '雨夜街角',
        location: '老城区',
        time_of_day: '夜',
        mood: '阴郁',
        visual_requirements: '霓虹反光 / 雨幕',
      },
    ],
    prop_cards: [
      { name: '怀表', description: '银色', dramatic_significance: '亡父遗物' },
    ],
    storyboard_directives: ['尽量保留长镜头', '主角视线轴线一致'],
  }
}

function mockLLM(response: string): { llm: LLM; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => response)
  return { llm: { complete: spy }, spy }
}

async function driveScriptAgent(
  agent: ReturnType<typeof createScriptAgent>,
  ctx: ReturnType<typeof createMemoryContext>,
  request: { scriptText: string; canvasContext?: string },
  answerSequence: Answer[],
) {
  let i = 0
  return drive(agent.run(request, ctx), {
    onQuestion: async () => {
      const a = answerSequence[i]
      i++
      if (!a) throw new Error(`script-agent asked more questions than the test fed (#${i})`)
      return a
    },
  })
}

describe('script-agent', () => {
  it('throws when scriptText is empty', async () => {
    const { llm } = mockLLM('')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await expect(
      driveScriptAgent(agent, ctx, { scriptText: '   ' }, []),
    ).rejects.toThrow(/scriptText is required/)
  })

  it('yields the 8 SKILL-checklist questions in order before calling the LLM', async () => {
    const { llm } = mockLLM(JSON.stringify(makeDossierJson()))
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    const headers: string[] = []
    await drive(agent.run({ scriptText: '一个侦探' }, ctx), {
      onQuestion: async (turn) => {
        headers.push(turn.question.header ?? '')
        // Auto-accept whichever recommendation each question carries.
        if (turn.question.multiSelect) return { selected: [] }
        const rec = turn.question.recommended ?? turn.question.options[0]?.value ?? ''
        return { selected: [rec] }
      },
    })

    expect(headers).toEqual([
      '项目类型',
      '平台/受众',
      '视觉风格',
      '故事目标',
      '角色数量',
      '禁忌',
      '输入形态',
      '工作流',
    ])
  })

  it('uses heuristic recommendations from the script text', async () => {
    const { llm } = mockLLM(JSON.stringify(makeDossierJson()))
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    const recommendations: Record<string, string | null> = {}
    await drive(
      agent.run(
        { scriptText: '一个搞笑的短视频，两人对话，要适合儿童观看' },
        ctx,
      ),
      {
        onQuestion: async (turn) => {
          recommendations[turn.question.header ?? ''] = turn.question.recommended
          if (turn.question.multiSelect) return { selected: turn.question.recommended ? [turn.question.recommended] : [] }
          return { selected: [turn.question.recommended ?? turn.question.options[0]!.value] }
        },
      },
    )

    // Short text + "搞笑" + "短视频" → recommend short video + comedy
    expect(recommendations['项目类型']).toBe('short-video-30s')
    expect(recommendations['故事目标']).toBe('comedy-relief')
    // "两人对话" → duo
    expect(recommendations['角色数量']).toBe('duo')
    // "儿童" → suggests child-safe taboo
    expect(recommendations['禁忌']).toBe('child-safe')
  })

  it('persists the dossier into ProjectContext after the LLM call', async () => {
    const { llm } = mockLLM('```json\n' + JSON.stringify(makeDossierJson()) + '\n```')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    const result = await driveAuto(
      agent.run({ scriptText: '一个侦探在雨夜遇到亡魂。' }, ctx),
    )

    expect(result.casting_cards).toHaveLength(1)
    expect(ctx.project.characters.list().map((c) => c.name)).toEqual(['林清'])
    expect(ctx.project.scenes.list().map((s) => s.name)).toEqual(['雨夜街角'])
    expect(ctx.project.props.list().map((p) => p.name)).toEqual(['怀表'])
    expect(ctx.project.beats.list()).toHaveLength(3)
    expect(ctx.project.beats.list()[0]!.id).toBe('B1')
  })

  it('passes user-chosen settings into the LLM prompt', async () => {
    const { llm, spy } = mockLLM(JSON.stringify(makeDossierJson()))
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await driveScriptAgent(agent, ctx, { scriptText: '一个浪漫故事' }, [
      { selected: ['mv'] },                            // projectType
      { selected: ['bilibili'] },                      // platformAudience
      { selected: ['anime-2d'] },                      // visualStyle
      { selected: ['romance-healing'] },               // storyGoal
      { selected: ['duo'] },                           // characterCount
      { selected: ['child-safe'] },                    // taboos (multi)
      { selected: ['rough-idea'] },                    // inputShape
      { selected: ['default'] },                       // subAgent
    ])

    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('MV')
    expect(sent).toContain('B 站')
    expect(sent).toContain('二次元')
    expect(sent).toContain('浪漫治愈')
    expect(sent).toContain('2 人对话')
    expect(sent).toContain('适合儿童')
    expect(sent).toContain('一句话想法')
  })

  it('joins multiple taboos with semicolons in the prompt', async () => {
    const { llm, spy } = mockLLM(JSON.stringify(makeDossierJson()))
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await driveScriptAgent(agent, ctx, { scriptText: 'idea' }, [
      { selected: ['short-video-30s'] },
      { selected: ['douyin-kuaishou-vertical'] },
      { selected: ['follow-canvas-style'] },
      { selected: ['move-audience'] },
      { selected: ['solo'] },
      { selected: ['avoid-violence', 'child-safe'] },  // taboos: 2 selected
      { selected: ['rough-idea'] },
      { selected: ['default'] },
    ])

    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('避免暴力；适合儿童')
  })

  it('records 无 when no taboo is selected', async () => {
    const { llm, spy } = mockLLM(JSON.stringify(makeDossierJson()))
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await driveScriptAgent(agent, ctx, { scriptText: 'idea' }, [
      { selected: ['short-video-30s'] },
      { selected: ['douyin-kuaishou-vertical'] },
      { selected: ['follow-canvas-style'] },
      { selected: ['move-audience'] },
      { selected: ['solo'] },
      { selected: [] },  // no taboo selected
      { selected: ['rough-idea'] },
      { selected: ['default'] },
    ])

    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('内容禁忌: 无')
  })

  it('throws a helpful error if a sub-agent is chosen but not wired', async () => {
    const { llm } = mockLLM('')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await expect(
      driveScriptAgent(agent, ctx, { scriptText: 'idea' }, [
        { selected: ['short-video-30s'] },
        { selected: ['douyin-kuaishou-vertical'] },
        { selected: ['follow-canvas-style'] },
        { selected: ['move-audience'] },
        { selected: ['solo'] },
        { selected: [] },
        { selected: ['rough-idea'] },
        { selected: ['framework-qa'] },  // sub-agent not wired
      ]),
    ).rejects.toThrow(/sub-agent "framework-qa" is not wired/)
  })

  it('delegates to a wired sub-agent and bubbles its result with full answers', async () => {
    const subDossier = makeDossierJson()
    const subSpy = vi.fn()

    const writingExpansion = {
      run: async function* (
        req: { scriptText: string; answers: ScriptInterviewAnswers },
      ) {
        subSpy(req)
        yield { type: 'result' as const, payload: subDossier }
      },
    }

    const { llm } = mockLLM('')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent({
      subAgents: { 'writing-expansion': writingExpansion },
    })

    const result = await driveScriptAgent(agent, ctx, { scriptText: 'draft' }, [
      { selected: ['feature-film'] },
      { selected: ['cinema'] },
      { selected: ['liveaction-film'] },
      { selected: ['move-audience'] },
      { selected: ['small-ensemble'] },
      { selected: [] },
      { selected: ['complete-draft'] },
      { selected: ['writing-expansion'] },
    ])

    expect(result).toEqual(subDossier)
    expect(subSpy).toHaveBeenCalledTimes(1)
    const call = subSpy.mock.calls[0]![0]
    expect(call.scriptText).toBe('draft')
    expect(call.answers.projectType).toBe('feature-film')
    expect(call.answers.platformAudience).toBe('cinema')
    expect(call.answers.subAgent).toBe('writing-expansion')
    // Persistence still happens on the bubbled-up dossier.
    expect(ctx.project.characters.list()).toHaveLength(1)
  })

  it('throws when the LLM response is not parseable JSON', async () => {
    const { llm } = mockLLM('not json at all')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await expect(driveAuto(agent.run({ scriptText: 'idea' }, ctx))).rejects.toThrow(
      /parseable JSON object/,
    )
  })

  it('throws when the JSON does not match the dossier schema', async () => {
    const { llm } = mockLLM('{"casting_cards": "not an array"}')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await expect(driveAuto(agent.run({ scriptText: 'idea' }, ctx))).rejects.toThrow(
      /failed validation/,
    )
  })
})
