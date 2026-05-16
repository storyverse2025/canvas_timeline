/**
 * Frontmatter `tools:` list → `BoundTools`.
 *
 * Capability bindings are validated against the project's capability registry
 * at bind time, so a typo in SKILL.md fails loud instead of silently at
 * runtime. Peer bindings are validated against the supplied peer registry.
 */

import type { CapabilitySpec } from '@/lib/capabilities/types'
import {
  isCapabilityBinding,
  isPeerBinding,
  type BoundCapability,
  type BoundPeers,
  type BoundTools,
  type CapabilityBinding,
  type CapabilityResult,
  type ToolBinding,
} from './types'
import type { AgentModule } from '@/lib/agents/_shared/runtime/types'

export interface CapabilityInvoker {
  (binding: CapabilityBinding, payload: unknown, signal?: AbortSignal): Promise<CapabilityResult>
}

export interface BinderOptions {
  /** All known capability specs — usually the CAPABILITIES export from the registry. */
  capabilities: readonly CapabilitySpec[]
  /** All known peer agents, keyed by slug. */
  peers: BoundPeers
  /**
   * The runtime function that actually invokes a capability. In prod this
   * routes to runCapability(); in tests it's a fake.
   */
  invoker: CapabilityInvoker
}

export function bindTools(
  declared: readonly ToolBinding[] | undefined,
  opts: BinderOptions,
): BoundTools {
  const bound: BoundTools = { capabilities: {}, peers: {} }
  if (!declared || declared.length === 0) return bound

  const capabilityIds = new Set(opts.capabilities.map((c) => c.id))

  for (const binding of declared) {
    if (isCapabilityBinding(binding)) {
      if (!capabilityIds.has(binding.capability)) {
        throw new Error(
          `Agent tool binding references unknown capability: "${binding.capability}". ` +
            `Add it to src/lib/capabilities/registry.ts or fix the SKILL.md frontmatter.`,
        )
      }
      const captured: CapabilityBinding = binding
      const boundCap: BoundCapability = {
        binding: captured,
        invoke: (payload, signal) => opts.invoker(captured, payload, signal),
      }
      bound.capabilities[binding.capability] = boundCap
    } else if (isPeerBinding(binding)) {
      const peer = opts.peers[binding.peer]
      if (!peer) {
        throw new Error(
          `Agent peer binding references unknown agent: "${binding.peer}". ` +
            `Add an agent module for that slug or fix the SKILL.md frontmatter.`,
        )
      }
      bound.peers[binding.peer] = peer as AgentModule<unknown, unknown, unknown>
    } else {
      throw new Error(
        `Unknown tool binding shape; expected { capability } or { peer }: ${JSON.stringify(binding)}`,
      )
    }
  }

  return bound
}
