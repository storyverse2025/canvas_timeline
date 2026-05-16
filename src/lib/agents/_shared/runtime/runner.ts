/**
 * Helpers for driving and composing agent generators.
 */

import type { Answer, AgentGenerator, Turn } from './types'

export interface RunOptions {
  /** Called with each Question yielded by the agent; must resolve to an Answer. */
  onQuestion: (question: Turn<unknown> & { type: 'question' }) => Promise<Answer>
  /** Called with each Progress turn. Default: ignored. */
  onProgress?: (turn: Turn<unknown> & { type: 'progress' }) => void
}

/**
 * Drive an agent generator to completion, supplying answers via onQuestion.
 * Returns the final result payload.
 */
export async function drive<TResult>(
  gen: AgentGenerator<TResult>,
  opts: RunOptions,
): Promise<TResult> {
  let next: IteratorResult<Turn<TResult>, void>
  let answer: Answer | undefined

  for (;;) {
    next = answer === undefined ? await gen.next() : await gen.next(answer)
    answer = undefined

    if (next.done) {
      throw new Error('Agent generator returned without yielding a result turn')
    }

    const turn = next.value

    if (turn.type === 'result') {
      return turn.payload
    }

    if (turn.type === 'progress') {
      opts.onProgress?.(turn)
      continue
    }

    if (turn.type === 'question') {
      answer = await opts.onQuestion(turn)
      continue
    }
  }
}

/**
 * Delegate to a child agent from within a parent agent. Forwards the child's
 * question turns up so the original requester can answer them — keeping the
 * interview flat from the user's perspective even when agents nest.
 *
 * Usage in a parent agent:
 *   const result = yield* delegate(childAgent.run(req, ctx))
 */
export async function* delegate<TResult>(
  child: AgentGenerator<TResult>,
): AsyncGenerator<Turn<TResult>, TResult, Answer | undefined> {
  let next = await child.next()
  let bubbled: Answer | undefined

  while (!next.done) {
    const turn = next.value

    if (turn.type === 'result') {
      return turn.payload
    }

    bubbled = (yield turn) as Answer | undefined
    next = bubbled === undefined ? await child.next() : await child.next(bubbled)
  }

  throw new Error('Delegated agent generator finished without a result turn')
}
