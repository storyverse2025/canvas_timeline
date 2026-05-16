/**
 * Capability-routed LLM adapter.
 *
 * Wraps `runCapability({ capability: 'element-extraction', inputs })` so an
 * agent's LLM calls go through the same /capabilities/run endpoint that the
 * legacy `aiCall()` in director-assistant.ts uses. Keeps behavior identical
 * during the agent migration — the routing/provider/model selection is still
 * decided by the capabilities plugin server-side, not by the agent.
 */

import { runCapability } from '@/lib/capabilities/client'
import type { CompleteOptions, LLM, LLMMessage } from './types'

export interface CapabilityLLMOptions {
  /** Capability id used as the routing token. Defaults to 'element-extraction'. */
  capabilityId?: string
}

function flatten(messages: LLMMessage[], system?: string): string {
  const parts: string[] = []
  if (system && system.trim().length > 0) parts.push(system.trim())
  for (const m of messages) {
    if (m.role === 'user') {
      parts.push(m.content)
    } else {
      // Assistant turns are rare in non-interactive script flows; preserve
      // them as quoted context so the model can read its prior reasoning.
      parts.push(`【prior assistant reply】\n${m.content}`)
    }
  }
  return parts.join('\n\n')
}

export function createCapabilityLLM(opts: CapabilityLLMOptions = {}): LLM {
  const capabilityId = opts.capabilityId ?? 'element-extraction'
  return {
    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<string> {
      void options?.model
      void options?.signal
      void options?.maxTokens
      const text = flatten(messages, options?.system)
      const r = await runCapability({
        capability: capabilityId,
        inputs: [{ kind: 'text', text }],
      })
      return r.outputs[0]?.text ?? ''
    },
  }
}
