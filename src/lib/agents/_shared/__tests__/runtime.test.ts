import { describe, it, expect, vi } from 'vitest'
import { drive, delegate } from '@/lib/agents/_shared/runtime/runner'
import type {
  AgentGenerator,
  Answer,
  Question,
  Turn,
} from '@/lib/agents/_shared/runtime/types'

function makeQuestion(q: string, recommended = 'yes'): Question {
  return {
    q,
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
    recommended,
  }
}

describe('runtime.drive', () => {
  it('returns the result payload from a non-interactive agent', async () => {
    async function* agent(): AgentGenerator<string> {
      yield { type: 'progress', message: 'starting' }
      yield { type: 'result', payload: 'done' }
    }
    const onProgress = vi.fn()
    const result = await drive(agent(), {
      onQuestion: async () => ({ selected: [] }),
      onProgress,
    })
    expect(result).toBe('done')
    expect(onProgress).toHaveBeenCalledOnce()
  })

  it('feeds question answers back into the generator', async () => {
    async function* agent(): AgentGenerator<string> {
      const a1 = (yield { type: 'question', question: makeQuestion('one?') }) as Answer
      const a2 = (yield { type: 'question', question: makeQuestion('two?') }) as Answer
      yield { type: 'result', payload: `${a1.selected[0]}/${a2.selected[0]}` }
    }
    const result = await drive(agent(), {
      onQuestion: async (turn) => {
        const q = turn.question.q
        return { selected: [q === 'one?' ? 'yes' : 'no'] }
      },
    })
    expect(result).toBe('yes/no')
  })

  it('throws if the generator ends without yielding a result', async () => {
    async function* agent(): AgentGenerator<string> {
      yield { type: 'progress', message: 'oops' }
    }
    await expect(
      drive(agent(), { onQuestion: async () => ({ selected: [] }) }),
    ).rejects.toThrow(/without yielding a result/)
  })
})

describe('runtime.delegate', () => {
  it("forwards a child agent's questions through the parent", async () => {
    async function* child(): AgentGenerator<string> {
      const a = (yield {
        type: 'question',
        question: makeQuestion('child question'),
      }) as Answer
      yield { type: 'result', payload: `child-saw-${a.selected[0]}` }
    }

    async function* parent(): AgentGenerator<string> {
      const childResult = yield* delegate(child())
      yield { type: 'result', payload: `parent-got-${childResult}` }
    }

    const seenQuestions: Turn<unknown>[] = []
    const result = await drive(parent(), {
      onQuestion: async (turn) => {
        seenQuestions.push(turn)
        return { selected: ['yes'] }
      },
    })

    expect(seenQuestions).toHaveLength(1)
    expect((seenQuestions[0] as { question: Question }).question.q).toBe('child question')
    expect(result).toBe('parent-got-child-saw-yes')
  })
})
