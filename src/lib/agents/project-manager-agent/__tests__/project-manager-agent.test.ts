import { describe, it, expect, vi } from 'vitest'

import {
  buildInterpretRequestPrompt,
  interpretRequest,
  projectManagerAgent,
} from '@/lib/agents/project-manager-agent'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { driveAuto } from '@/lib/agents/_shared/runtime/runner'
import type { LLM } from '@/lib/agents/_shared/llm/types'
import type { PMGapSummary } from '@/lib/agents/project-manager-agent'

function llmReturning(...responses: string[]): { llm: LLM; spy: ReturnType<typeof vi.fn> } {
  let i = 0
  const spy = vi.fn(async () => {
    const r = responses[i] ?? ''
    i++
    return r
  })
  return { llm: { complete: spy }, spy }
}

const emptyGap: PMGapSummary = {
  totalRows: 0,
  missingAssetsCount: 0,
  missingAssets: [],
  rowsMissingKeyframe: [],
  rowsMissingBeatVideo: [],
  rowsWithBothKeyframeAndVideo: [],
  nextSuggestion: 'run-director-assistant',
}

const gapWithMissingVideos: PMGapSummary = {
  totalRows: 3,
  missingAssetsCount: 0,
  missingAssets: [],
  rowsMissingKeyframe: [],
  rowsMissingBeatVideo: [
    { id: 'r1', shot_number: 'S1' },
    { id: 'r2', shot_number: 'S2' },
  ],
  rowsWithBothKeyframeAndVideo: [{ id: 'r3', shot_number: 'S3' }],
  nextSuggestion: 'generate-missing-videos',
}

describe('project-manager-agent: meta', () => {
  it('exposes interpretRequest on the module export', () => {
    expect(projectManagerAgent.interpretRequest).toBe(interpretRequest)
    expect(projectManagerAgent.meta.name).toBe('project-manager-agent')
  })
})

describe('buildInterpretRequestPrompt', () => {
  it('embeds the user message + gap summary + recent messages', () => {
    const prompt = buildInterpretRequestPrompt({
      userMessage: '把缺失的视频做了',
      gapSummary: gapWithMissingVideos,
      recentMessages: [
        { role: 'user', content: '生成 S1 的 keyframe' },
        { role: 'system', content: '已生成 keyframe' },
      ],
    })
    expect(prompt).toContain('把缺失的视频做了')
    expect(prompt).toContain('"nextSuggestion": "generate-missing-videos"')
    expect(prompt).toContain('生成 S1 的 keyframe')
  })
})

describe('interpretRequest', () => {
  it('returns a single-action plan for "generate missing videos"', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: '用户明确要求；gap summary 已列出待补的 video 行',
      actions: [{ type: 'generate-missing-videos' }],
    }))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      interpretRequest(
        { userMessage: '把缺失的视频做了', gapSummary: gapWithMissingVideos, recentMessages: [] },
        ctx,
      ),
    )
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({ type: 'generate-missing-videos' })
  })

  it('parses chat-response plans (purely conversational replies)', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: '问候语，无下游 agent 可调度',
      actions: [{ type: 'chat-response', text: '你好。当前分镜表是空的，建议先跑导演助手。' }],
    }))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      interpretRequest(
        { userMessage: '你好', gapSummary: emptyGap, recentMessages: [] },
        ctx,
      ),
    )
    expect(result.actions[0].type).toBe('chat-response')
    if (result.actions[0].type === 'chat-response') {
      expect(result.actions[0].text).toContain('导演助手')
    }
  })

  it('parses multi-action plans for compound requests', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: '用户要求做完两步：先补 keyframe 再补视频',
      actions: [
        { type: 'generate-missing-keyframes' },
        { type: 'generate-missing-videos' },
      ],
    }))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      interpretRequest(
        { userMessage: '把缺的图和视频都做了', gapSummary: gapWithMissingVideos, recentMessages: [] },
        ctx,
      ),
    )
    expect(result.actions).toHaveLength(2)
    expect(result.actions.map((a) => a.type)).toEqual([
      'generate-missing-keyframes',
      'generate-missing-videos',
    ])
  })

  it('parses actor-enrich-row with rowId', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: '用户点名 row',
      actions: [{ type: 'actor-enrich-row', rowId: 'r1' }],
    }))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      interpretRequest(
        { userMessage: '给 S1 的表演重写', gapSummary: gapWithMissingVideos, recentMessages: [] },
        ctx,
      ),
    )
    if (result.actions[0].type === 'actor-enrich-row') {
      expect(result.actions[0].rowId).toBe('r1')
    } else {
      throw new Error('expected actor-enrich-row')
    }
  })

  it('rejects a plan mixing ask-user with other actions', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: 'invalid mix',
      actions: [
        { type: 'ask-user', question: 'which row?' },
        { type: 'generate-missing-keyframes' },
      ],
    }))
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(
        interpretRequest({ userMessage: '?', gapSummary: emptyGap, recentMessages: [] }, ctx),
      ),
    ).rejects.toThrow(/cannot be mixed/)
  })

  it('throws on unparseable JSON', async () => {
    const { llm } = llmReturning('not json at all')
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(
        interpretRequest({ userMessage: 'hi', gapSummary: emptyGap, recentMessages: [] }, ctx),
      ),
    ).rejects.toThrow(/parseable JSON object/)
  })

  it('throws on schema-violating JSON (missing required field)', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: 'oops',
      actions: [{ type: 'actor-enrich-row' }], // rowId missing
    }))
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(
        interpretRequest({ userMessage: 'hi', gapSummary: emptyGap, recentMessages: [] }, ctx),
      ),
    ).rejects.toThrow(/failed validation/)
  })

  it('parses patch-canvas-pattern with target + intent + alsoRegenerateVideo', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: '用户描述了批量改写模式',
      actions: [{
        type: 'patch-canvas-pattern',
        target: { promptContains: ['左轮手枪'] },
        intent: '机甲手持巨型手枪、人类坐在机甲驾驶舱内',
        alsoRegenerateVideo: 'ask',
      }],
    }))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      interpretRequest(
        {
          userMessage: '找出所有左轮手枪的图，改成机甲持枪、人坐机甲内',
          gapSummary: emptyGap,
          recentMessages: [],
        },
        ctx,
      ),
    )
    expect(result.actions).toHaveLength(1)
    const action = result.actions[0]
    if (action.type !== 'patch-canvas-pattern') throw new Error('expected patch-canvas-pattern')
    expect(action.target.promptContains).toEqual(['左轮手枪'])
    expect(action.intent).toContain('机甲')
    expect(action.alsoRegenerateVideo).toBe('ask')
  })

  it('defaults patch-canvas-pattern.alsoRegenerateVideo to "ask" when omitted', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: '省略 alsoRegenerateVideo，schema 应当默认 ask',
      actions: [{
        type: 'patch-canvas-pattern',
        target: { promptContains: ['night']  },
        intent: 'switch night scenes to dusk',
      }],
    }))
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      interpretRequest({ userMessage: 'all night → dusk', gapSummary: emptyGap, recentMessages: [] }, ctx),
    )
    const action = result.actions[0]
    if (action.type !== 'patch-canvas-pattern') throw new Error('expected patch-canvas-pattern')
    expect(action.alsoRegenerateVideo).toBe('ask')
  })

  it('rejects patch-canvas-pattern with empty promptContains', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: 'empty target',
      actions: [{
        type: 'patch-canvas-pattern',
        target: { promptContains: [] },
        intent: 'change something',
      }],
    }))
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(
        interpretRequest({ userMessage: '?', gapSummary: emptyGap, recentMessages: [] }, ctx),
      ),
    ).rejects.toThrow(/failed validation/)
  })

  it('rejects unknown action types', async () => {
    const { llm } = llmReturning(JSON.stringify({
      reasoning: 'unknown',
      actions: [{ type: 'do-magic' }],
    }))
    const ctx = createMemoryContext({ llm })
    await expect(
      driveAuto(
        interpretRequest({ userMessage: 'hi', gapSummary: emptyGap, recentMessages: [] }, ctx),
      ),
    ).rejects.toThrow(/failed validation/)
  })
})
