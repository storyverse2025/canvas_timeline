import { describe, it, expect, vi } from 'vitest'

import { createScriptAgent } from '@/lib/agents/script-agent'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { drive } from '@/lib/agents/_shared/runtime/runner'
import type { Answer } from '@/lib/agents/_shared/runtime/types'
import type { LLM } from '@/lib/agents/_shared/llm/types'
import type { ScriptDossier, ScriptInputShape } from '@/lib/agents/script-agent/schema'

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
  return {
    llm: { complete: spy },
    spy,
  }
}

const answers: Record<string, Answer> = {
  shapeRoughIdea: { selected: ['rough-idea'] },
  shapeDraft: { selected: ['complete-draft'] },
  flowDefault: { selected: ['default'] },
  flowFrameworkQa: { selected: ['framework-qa'] },
  flowWritingExpansion: { selected: ['writing-expansion'] },
  toneDrama: { selected: ['drama'] },
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

  it('recommends rough-idea for short text and runs the default flow', async () => {
    const dossier = makeDossierJson()
    const { llm, spy } = mockLLM('```json\n' + JSON.stringify(dossier) + '\n```')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    const result = await driveScriptAgent(
      agent,
      ctx,
      { scriptText: '一个侦探在雨夜遇到亡魂。' },
      [answers.shapeRoughIdea, answers.flowDefault, answers.toneDrama],
    )

    expect(result.casting_cards).toHaveLength(1)
    expect(result.casting_cards[0].name).toBe('林清')

    // Persists outputs into ProjectContext.
    expect(ctx.project.characters.list().map((c) => c.name)).toEqual(['林清'])
    expect(ctx.project.scenes.list().map((s) => s.name)).toEqual(['雨夜街角'])
    expect(ctx.project.props.list().map((p) => p.name)).toEqual(['怀表'])
    expect(ctx.project.beats.list()).toHaveLength(3)
    expect(ctx.project.beats.list()[0].id).toBe('B1')

    // LLM saw the prompt with the recommended input shape filled in.
    const sentPrompt = spy.mock.calls[0][0][0].content as string
    expect(sentPrompt).toContain('类型：rough-idea')
    expect(sentPrompt).toContain('情绪基调：drama')
  })

  it("recommends complete-draft for long text, but the user's override wins", async () => {
    const dossier = makeDossierJson()
    const { llm, spy } = mockLLM(JSON.stringify(dossier))
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()

    const longScript = 'Beat. '.repeat(800) // ≈ 4800 chars → complete-draft

    await driveScriptAgent(agent, ctx, { scriptText: longScript }, [
      // User overrides the recommendation with rough-idea.
      answers.shapeRoughIdea,
      answers.flowDefault,
      { selected: [], text: 'noir' }, // free-text tone
    ])

    const sent = spy.mock.calls[0][0][0].content as string
    expect(sent).toContain('类型：rough-idea')
    expect(sent).toContain('情绪基调：noir')
  })

  it('throws a helpful error if a sub-agent is chosen but not wired', async () => {
    const { llm } = mockLLM('')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent() // no deps.subAgents

    await expect(
      driveScriptAgent(agent, ctx, { scriptText: 'idea' }, [
        answers.shapeRoughIdea,
        answers.flowFrameworkQa,
        answers.toneDrama,
      ]),
    ).rejects.toThrow(/sub-agent "framework-qa" is not wired/)
  })

  it('delegates to a wired sub-agent and bubbles its result', async () => {
    const subDossier = makeDossierJson()
    const subSpy = vi.fn()

    const writingExpansion = {
      run: async function* (
        req: { scriptText: string; tone: string; inputShape: ScriptInputShape },
      ) {
        subSpy(req)
        yield { type: 'result' as const, payload: subDossier }
      },
    }

    const { llm } = mockLLM('') // LLM should not be called when delegating
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent({
      subAgents: { 'writing-expansion': writingExpansion },
    })

    const result = await driveScriptAgent(agent, ctx, { scriptText: 'draft' }, [
      answers.shapeDraft,
      answers.flowWritingExpansion,
      answers.toneDrama,
    ])

    expect(result).toEqual(subDossier)
    expect(subSpy).toHaveBeenCalledWith({
      scriptText: 'draft',
      tone: 'drama',
      inputShape: 'complete-draft',
    })
    // Persistence still happens on the bubbled-up dossier.
    expect(ctx.project.characters.list()).toHaveLength(1)
  })

  it('throws when the LLM response is not parseable JSON', async () => {
    const { llm } = mockLLM('not json at all')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await expect(
      driveScriptAgent(agent, ctx, { scriptText: 'idea' }, [
        answers.shapeRoughIdea,
        answers.flowDefault,
        answers.toneDrama,
      ]),
    ).rejects.toThrow(/parseable JSON object/)
  })

  it('throws when the JSON does not match the dossier schema', async () => {
    const { llm } = mockLLM('{"casting_cards": "not an array"}')
    const ctx = createMemoryContext({ llm })
    const agent = createScriptAgent()
    await expect(
      driveScriptAgent(agent, ctx, { scriptText: 'idea' }, [
        answers.shapeRoughIdea,
        answers.flowDefault,
        answers.toneDrama,
      ]),
    ).rejects.toThrow(/failed validation/)
  })
})
