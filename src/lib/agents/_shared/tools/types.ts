/**
 * Tool declarations live in an agent's SKILL.md frontmatter and are bound at
 * agent-load time into `ctx.tools`. Two flavors:
 *
 *  - capability: a generic capability invocation (any entry from
 *    src/lib/capabilities/registry.ts), optionally pinned to a provider/model.
 *  - peer: another agent this agent is allowed to delegate to.
 *
 * Frontmatter shape (example):
 *   tools:
 *     - capability: text-to-image
 *       provider: openai
 *       model: gpt-image-2
 *     - capability: storyboard-qc
 *     - peer: actor-agent
 */

import type { AgentModule } from '@/lib/agents/_shared/runtime/types'

export interface CapabilityBinding {
  /** Capability id from src/lib/capabilities/registry.ts. */
  capability: string
  /** Optional provider id pin. */
  provider?: string
  /** Optional model id pin. */
  model?: string
}

export interface PeerBinding {
  /** Peer agent slug (folder name). */
  peer: string
}

export type ToolBinding = CapabilityBinding | PeerBinding

export function isCapabilityBinding(b: ToolBinding): b is CapabilityBinding {
  return 'capability' in b && typeof b.capability === 'string'
}

export function isPeerBinding(b: ToolBinding): b is PeerBinding {
  return 'peer' in b && typeof b.peer === 'string'
}

/** Outcome of running a capability — opaque payload, agents handle their own. */
export interface CapabilityInvocation {
  capability: string
  provider?: string
  model?: string
  payload: unknown
}

export interface CapabilityResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface BoundCapability {
  /** Pin echoed back so the agent can see what it's actually calling. */
  binding: CapabilityBinding
  invoke(payload: unknown, signal?: AbortSignal): Promise<CapabilityResult>
}

/** Resolved peers — opaque AgentModule references for `delegate()`. */
export type BoundPeers = Record<string, AgentModule<unknown, unknown, unknown>>

export interface BoundTools {
  /** Keyed by capability id. */
  capabilities: Record<string, BoundCapability>
  /** Keyed by peer slug. */
  peers: BoundPeers
}
