/**
 * Agent runtime protocol.
 *
 * Every agent is an async generator that yields `Turn`s — either an interview
 * Question (paused, awaiting an answer), a Result (final payload, generator
 * returns), or a Progress note (informational, no pause). The caller drives
 * the generator and supplies answers via `.next(answer)`.
 *
 * The same protocol works for human callers (UI renders questions in
 * InterviewCard) and agent callers (parent agent yields the child's question
 * to bubble it up — see `delegate()` in runner.ts).
 */

import type { ProjectContext } from '@/lib/agents/_shared/context/types'

export interface QuestionOption {
  /** Stable identifier for the option. */
  value: string
  /** Display label shown to the user. */
  label: string
  /** Optional explanation rendered as a hint. */
  description?: string
}

export interface Question {
  /** Free-form question text. Markdown allowed. */
  q: string
  /** Short chip-style label (≤ 12 chars), e.g. "Aspect" / "Tone". */
  header?: string
  /** Options the agent suggests. Empty array means free-text only. */
  options: QuestionOption[]
  /** `value` of the recommended option, or null if no recommendation. */
  recommended: string | null
  /** Whether the user may pick multiple options. */
  multiSelect?: boolean
}

export interface Answer {
  /** Selected option `value`s. Empty array if the user only provided free text. */
  selected: string[]
  /** Free-text reply, if any. */
  text?: string
}

export interface Feedback {
  /** Critique severity. */
  severity: 'info' | 'minor' | 'major' | 'blocking'
  /** Short summary of what's wrong. */
  summary: string
  /** Specific suggestions for the revise pass. */
  suggestions: string[]
  /** Optional pointers to the asset (timestamps, panel indexes, line numbers). */
  refs?: string[]
}

/** One step yielded by an agent generator. */
export type Turn<TResult = unknown> =
  | { type: 'question'; question: Question }
  | { type: 'progress'; message: string; data?: unknown }
  | { type: 'result'; payload: TResult }

/**
 * The shape of every agent's main entry point.
 *
 * Yields Turns; receives Answers via `.next(answer)`. Returning a value
 * is allowed but the canonical "I'm done" signal is `yield { type: 'result' }`
 * — that way critique and revise generators (which never return) and run
 * generators look identical to callers.
 */
export type AgentGenerator<TResult = unknown> = AsyncGenerator<
  Turn<TResult>,
  void,
  Answer | undefined
>

/** Optional revise verb on creative agents. */
export type ReviseGenerator<TAsset> = AsyncGenerator<
  Turn<TAsset>,
  void,
  Answer | undefined
>

/** Optional critique verb. Yields a Feedback as its result. */
export type CritiqueGenerator = AsyncGenerator<
  Turn<Feedback>,
  void,
  Answer | undefined
>

/** Metadata declared in an agent's SKILL.md frontmatter. */
export interface AgentMeta {
  name: string
  description: string
  model?: string
  /** Capability/peer bindings — see tools/binder.ts for shape. */
  tools?: Array<Record<string, unknown>>
  /** Sub-agent slugs (folder names) that this agent may delegate to. */
  subAgents?: string[]
  /** Free-form additional frontmatter passed through unchanged. */
  extra?: Record<string, unknown>
}

/** What every agent module exports. */
export interface AgentModule<TRequest = unknown, TResult = unknown, TAsset = unknown> {
  meta: AgentMeta
  /** Raw markdown body of SKILL.md (everything after the frontmatter). */
  systemPrompt: string
  run: (request: TRequest, ctx: ProjectContext) => AgentGenerator<TResult>
  critique?: (asset: TAsset, ctx: ProjectContext) => CritiqueGenerator
  revise?: (
    asset: TAsset,
    feedback: Feedback,
    ctx: ProjectContext,
  ) => ReviseGenerator<TAsset>
}
