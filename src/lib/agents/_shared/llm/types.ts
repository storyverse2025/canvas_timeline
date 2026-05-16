/**
 * LLM facade used by agents. Wraps the existing claude-client in prod and
 * can be replaced with a mock in tests / a hermes shell-out in design-time.
 */

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CompleteOptions {
  system?: string
  /** Default 8000. */
  maxTokens?: number
  /** Default sonnet-4-5 in prod; overridden by agent frontmatter `model`. */
  model?: string
  /** Optional cancellation. */
  signal?: AbortSignal
}

export interface LLM {
  /** Non-streaming call. Returns the assistant text. */
  complete(messages: LLMMessage[], options?: CompleteOptions): Promise<string>
}
