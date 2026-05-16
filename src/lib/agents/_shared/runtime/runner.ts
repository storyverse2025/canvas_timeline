/**
 * Helpers for driving and composing agent generators.
 */

import type { Answer, AgentGenerator, Question, Turn } from './types'

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
 * Pick the recommended option for a Question, or the first option if no
 * recommendation was supplied. Used by `driveAuto` and as a default when
 * non-interactive callers don't override question handling.
 */
export function pickRecommendedAnswer(question: Question): Answer {
  if (question.recommended) return { selected: [question.recommended] }
  const first = question.options[0]?.value
  if (first) return { selected: [first] }
  return { selected: [] }
}

export interface DriveAutoOptions {
  /** Optional progress sink. */
  onProgress?: (turn: Turn<unknown> & { type: 'progress' }) => void
  /**
   * Optional answer override. Return undefined to fall back to the recommended
   * option. Useful for tests that want to assert a specific path through the
   * interview tree, and for legacy call sites that want to pre-supply known
   * answers without rebuilding the full RunOptions surface.
   */
  override?: (question: Question) => Answer | undefined
}

/**
 * Drive an agent generator to completion without a human in the loop. Every
 * Question turn is auto-answered with its recommended option (or the first
 * option). This is the entry point for legacy non-interactive call sites
 * during the agent migration — the UI-less equivalent of `drive()`.
 *
 * Once the InterviewCard UI ships, prefer `drive()` with a real
 * onQuestion handler.
 */
export async function driveAuto<TResult>(
  gen: AgentGenerator<TResult>,
  opts: DriveAutoOptions = {},
): Promise<TResult> {
  return drive(gen, {
    onProgress: opts.onProgress,
    onQuestion: async (turn) => {
      const overridden = opts.override?.(turn.question)
      return overridden ?? pickRecommendedAnswer(turn.question)
    },
  })
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
