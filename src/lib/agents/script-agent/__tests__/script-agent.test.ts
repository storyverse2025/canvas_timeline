import { describe, it, expect, vi } from 'vitest'

import { createScriptAgent } from '@/lib/agents/script-agent'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { drive, driveAuto } from '@/lib/agents/_shared/runtime/runner'
import type { Answer } from '@/lib/agents/_shared/runtime/types'
import type { LLM } from '@/lib/agents/_shared/llm/types'
import type { ScriptDossier } from '@/lib/agents/script-agent/schema'

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
    post_doctor_revised_script: {
      script_text: '修订后剧本：开场遇害后节奏收紧',
      revision_notes: ['二幕节奏 — 删除 B3 重复线索的两段独白'],
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

function makeAskJson(
  questions: Array<{
    q: string
    header?: string
    options: Array<{ value: string; label: string; description?: string }>
    recommended?: string
  }>,
): string {
  return JSON.stringify({ questions })
}

const DEFAULT_ASK_RESPONSE = makeAskJson([
  {
    q: '主角的动机最贴近哪一种？',
    header: '主角动机',
    options: [
      { value: 'revenge', label: '复仇' },
      { value: 'truth-seeking', label: '寻找真相' },
      { value: 'redemption', label: '自我救赎' },
    ],
    recommended: 'truth-seeking',
  },
  {
    q: '故事结尾你希望走向？',
    header: '结尾走向',
    options: [
      { value: 'open', label: '开放结尾' },
      { value: 'closed', label: '闭合反转' },
      { value: 'tragic', label: '悲剧落幕' },
    ],
    recommended: 'closed',
  },
  {
    q: '关键道具的功能是？',
    header: '道具功能',
    options: [
      { value: 'memento', label: '回忆触发物' },
      { value: 'macguffin', label: '驱动剧情的目标物' },
      { value: 'symbol', label: '象征人物状态' },
    ],
    recommended: 'memento',
  },
])

/**
 * Mock LLM that returns a sequence of responses in order — first call gets
 * responses[0], second call gets responses[1], etc. After exhausting the list
 * the last response is repeated. Returns the spy so the test can assert on
 * the messages each call received.
 */
function mockLLMSequence(responses: string[]): {
  llm: LLM
  spy: ReturnType<typeof vi.fn>
} {
  let i = 0
  const spy = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    return r ?? ''
  })
  return { llm: { complete: spy }, spy }
}

describe('script-agent', () => {
  it('throws when scriptText is empty', async () => {
    const { llm } = mockLLMSequence([])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await expect(
      drive(agent.run({ scriptText: '   ' }, ctx), {
        onQuestion: async () => ({ selected: [] }),
      }),
    ).rejects.toThrow(/scriptText is required/)
  })

  it('asks no static questions — the interview is purely LLM-generated', async () => {
    const { llm } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    const headers: string[] = []
    await drive(agent.run({ scriptText: '一个侦探在雨夜遇到亡魂。' }, ctx), {
      onQuestion: async (turn) => {
        headers.push(turn.question.header ?? '')
        const rec = turn.question.recommended ?? turn.question.options[0]?.value ?? ''
        return { selected: [rec] }
      },
    })

    // No 项目类型 / 平台/受众 / 视觉风格 / 故事目标 / 角色数量 / 输入形态 / 工作流
    // — only the LLM-generated headers come through.
    expect(headers).toEqual(['主角动机', '结尾走向', '道具功能'])
  })

  it('calls the LLM twice: once to generate questions, once to expand the script', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await drive(agent.run({ scriptText: '一个侦探故事' }, ctx), {
      onQuestion: async (turn) => ({
        selected: [turn.question.recommended ?? turn.question.options[0]!.value],
      }),
    })

    expect(spy).toHaveBeenCalledTimes(2)
    const askMessage = spy.mock.calls[0]![0]![0]!.content as string
    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    expect(askMessage).toContain('采访官')
    expect(expandMessage).toContain('导演助手')
    expect(expandMessage).toContain('Script → Casting → Storyboard')
  })

  it('threads clarifications into the expand-script prompt', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await drive(agent.run({ scriptText: '一个侦探故事' }, ctx), {
      onQuestion: async (turn) => {
        // Pick the first non-recommended option for each so we can verify
        // that the user's actual choice (not the recommendation) gets piped
        // through.
        const nonRec = turn.question.options.find(
          (o) => o.value !== turn.question.recommended,
        )
        return { selected: [nonRec!.value] }
      },
    })

    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    // Each Q/A appears in the dossier prompt verbatim.
    expect(expandMessage).toContain('主角的动机最贴近哪一种？')
    expect(expandMessage).toContain('复仇') // first non-recommended option label
    expect(expandMessage).toContain('故事结尾你希望走向？')
    expect(expandMessage).toContain('开放结尾')
    expect(expandMessage).toContain('关键道具的功能是？')
    expect(expandMessage).toContain('驱动剧情的目标物')
  })

  it('locks platform/audience to 院线 (成人) regardless of script content', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await drive(
      agent.run({ scriptText: '一个抖音爆款搞笑短视频' }, ctx),
      {
        onQuestion: async (turn) => ({
          selected: [turn.question.recommended ?? turn.question.options[0]!.value],
        }),
      },
    )

    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    expect(expandMessage).toContain('院线（成人受众）')
    expect(expandMessage).not.toContain('抖音/快手')
  })

  it('infers project type from totalDurationSeconds + script keywords', async () => {
    const cases: Array<[number, string]> = [
      [25, '短视频 (15-30秒)'],
      [55, '短视频 (30-60秒)'],
      [120, 'MV (3-5 分钟)'],
      [600, '短剧单集 (10-30 分钟)'],
      [3600, '院线长片 (90-120 分钟)'],
    ]
    for (const [dur, expectedLabel] of cases) {
      const { llm, spy } = mockLLMSequence([
        DEFAULT_ASK_RESPONSE,
        JSON.stringify(makeDossierJson()),
      ])
      const ctx = createMemoryContext({ llm })
      const agent = createScriptAgent()
      await drive(
        agent.run(
          { scriptText: '一个故事', knownContext: { totalDurationSeconds: dur } },
          ctx,
        ),
        {
          onQuestion: async (turn) => ({
            selected: [turn.question.recommended ?? turn.question.options[0]!.value],
          }),
        },
      )
      const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
      expect(expandMessage).toContain(`项目类型: ${expectedLabel}`)
    }
  })

  it('honors deprecated top-level totalDurationSeconds for project type inference', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await drive(
      agent.run({ scriptText: '一个侦探', totalDurationSeconds: 60 }, ctx),
      {
        onQuestion: async (turn) => ({
          selected: [turn.question.recommended ?? turn.question.options[0]!.value],
        }),
      },
    )
    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    expect(expandMessage).toContain('项目类型: 短视频 (30-60秒)')
  })

  it('always renders 视觉风格 as 跟随画布美术 (defers to canvas via {{artStyle}})', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await drive(
      agent.run(
        {
          scriptText: '一个故事',
          knownContext: { visualStyle: 'Cold-toned filmic noir' },
        },
        ctx,
      ),
      {
        onQuestion: async (turn) => ({
          selected: [turn.question.recommended ?? turn.question.options[0]!.value],
        }),
      },
    )

    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    expect(expandMessage).toContain('视觉风格: 跟随画布美术风格')
  })

  it('infers story-goal + character-count from script keywords', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await drive(
      agent.run(
        { scriptText: '一个搞笑的短视频，两人对话，要适合儿童观看' },
        ctx,
      ),
      {
        onQuestion: async (turn) => ({
          selected: [turn.question.recommended ?? turn.question.options[0]!.value],
        }),
      },
    )

    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    expect(expandMessage).toContain('故事目标 / 核心情绪: 搞笑解压')
    expect(expandMessage).toContain('角色数量上限: 2 人对话')
  })

  it('always passes taboos as 无 in the prompt (question dropped per user feedback)', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await drive(agent.run({ scriptText: 'idea' }, ctx), {
      onQuestion: async (turn) => ({
        selected: [turn.question.recommended ?? turn.question.options[0]!.value],
      }),
    })

    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    expect(expandMessage).toContain('内容禁忌: 无')
  })

  it('falls back gracefully when the ask LLM call returns unparseable JSON', async () => {
    const { llm, spy } = mockLLMSequence([
      'not json at all', // ask call fails
      JSON.stringify(makeDossierJson()), // expand still proceeds
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    const headers: string[] = []
    const result = await drive(
      agent.run({ scriptText: '一个侦探故事' }, ctx),
      {
        onQuestion: async (turn) => {
          headers.push(turn.question.header ?? '')
          return { selected: [turn.question.recommended ?? turn.question.options[0]!.value] }
        },
      },
    )

    // No questions surfaced — the generator skipped clarification phase.
    expect(headers).toEqual([])
    // expand-script still ran and produced a dossier.
    expect(result).toEqual(makeDossierJson())
    // The expand prompt notes that there were no clarifications.
    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    expect(expandMessage).toContain('采访官未提出额外问题')
  })

  it('falls back gracefully when the ask LLM call returns questions[] schema-invalid', async () => {
    const { llm, spy } = mockLLMSequence([
      // valid JSON but no `questions` array of the expected shape
      JSON.stringify({ questions: [{ q: '', options: [] }] }),
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    const headers: string[] = []
    await drive(agent.run({ scriptText: 'idea' }, ctx), {
      onQuestion: async (turn) => {
        headers.push(turn.question.header ?? '')
        return { selected: [turn.question.recommended ?? turn.question.options[0]!.value] }
      },
    })

    expect(headers).toEqual([])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('records free-text user replies alongside the chosen option label', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    let questionIndex = 0
    await drive(agent.run({ scriptText: '一个侦探故事' }, ctx), {
      onQuestion: async (turn) => {
        const answer: Answer = questionIndex === 0
          ? { selected: ['truth-seeking'], text: '但她内心其实想复仇' }
          : { selected: [turn.question.recommended ?? turn.question.options[0]!.value] }
        questionIndex += 1
        return answer
      },
    })

    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    expect(expandMessage).toContain('寻找真相（用户补充：但她内心其实想复仇）')
  })

  it('persists the dossier into ProjectContext after the expand call', async () => {
    const { llm } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      '```json\n' + JSON.stringify(makeDossierJson()) + '\n```',
    ])
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

  it('throws when the expand-script LLM response is not parseable JSON', async () => {
    const { llm } = mockLLMSequence([DEFAULT_ASK_RESPONSE, 'not json at all'])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await expect(driveAuto(agent.run({ scriptText: 'idea' }, ctx))).rejects.toThrow(
      /parseable JSON object/,
    )
  })

  it('throws when the dossier JSON does not match the schema', async () => {
    const { llm } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      '{"casting_cards": "not an array"}',
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await expect(driveAuto(agent.run({ scriptText: 'idea' }, ctx))).rejects.toThrow(
      /failed validation/,
    )
  })

  it('respects the rec recommendation if user just hits enter (recommended fallback)', async () => {
    const { llm, spy } = mockLLMSequence([
      DEFAULT_ASK_RESPONSE,
      JSON.stringify(makeDossierJson()),
    ])
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    await drive(agent.run({ scriptText: 'idea' }, ctx), {
      // Return an empty Answer — selected: [], no text — to simulate "I just
      // want the recommendation".
      onQuestion: async () => ({ selected: [] }),
    })

    const expandMessage = spy.mock.calls[1]![0]![0]!.content as string
    // Each recommended label flows through to the expand prompt.
    expect(expandMessage).toContain('寻找真相') // Q1 recommendation
    expect(expandMessage).toContain('闭合反转') // Q2 recommendation
    expect(expandMessage).toContain('回忆触发物') // Q3 recommendation
  })
})
