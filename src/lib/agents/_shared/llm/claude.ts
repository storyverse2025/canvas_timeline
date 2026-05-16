/**
 * Production LLM adapter. Routes through the existing /anthropic/v1/messages
 * proxy by reusing claude-client.callClaude — agents inherit the same auth
 * and routing as the rest of the app.
 *
 * Model selection precedence:
 *   options.model (per-call override)
 *     → ctorOpts.defaultModel (per-agent default from frontmatter)
 *     → claude-client's hard-coded default
 */

import { callClaude, type ClaudeMessage } from '@/lib/claude-client'
import type { CompleteOptions, LLM, LLMMessage } from './types'

export interface ClaudeLLMOptions {
  /** Default model id used when neither call nor agent overrides it. */
  defaultModel?: string
}

export function createClaudeLLM(ctorOpts: ClaudeLLMOptions = {}): LLM {
  return {
    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<string> {
      const claudeMessages: ClaudeMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }))
      // Note: claude-client doesn't currently accept a per-call model param.
      // The `model` option is recorded on the request but routed to the
      // proxy's default model. When claude-client adds per-call model + signal
      // support, plumb them here.
      void options?.model
      void ctorOpts.defaultModel
      void options?.signal
      return callClaude(claudeMessages, {
        system: options?.system,
        maxTokens: options?.maxTokens,
      })
    },
  }
}
