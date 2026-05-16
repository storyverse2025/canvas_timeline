/**
 * Surface agent activity in ChatPanel.
 *
 * Agents already yield `progress` turns ("art-director: extracting characters",
 * "script-agent: running expand-script flow"). Without a bridge they go to
 * `ctx.log` or are silently dropped. This helper wraps `driveAuto` and pushes
 * each turn — plus a start / done / failed marker — into the chat-store as
 * system-role messages, which ChatMessage renders as the small gear-icon log
 * lines above the assistant bubble.
 *
 * Callers stay one-liners:
 *
 *   const dossier = await runAgentWithChatBridge(
 *     'script-agent',
 *     scriptAgent.run(req, ctx),
 *   )
 */

import { useChatStore } from '@/stores/chat-store'
import {
  drive,
  driveAuto,
  type DriveAutoOptions,
} from '@/lib/agents/_shared/runtime/runner'
import type { AgentGenerator } from '@/lib/agents/_shared/runtime/types'

export interface ChatBridgeOptions extends DriveAutoOptions {
  /**
   * Optional short note appended to the start marker so the user can tell
   * apart multiple invocations of the same agent (e.g. which verb ran).
   */
  verb?: string
  /**
   * When true, agent Question turns are presented to the user via the chat
   * store's pendingQuestion slot — ChatPanel renders an <InterviewCard/> and
   * the agent's generator pauses until the user clicks Submit. Defaults to
   * false (auto-pick the recommended answer, useful for non-interactive flows).
   */
  interactive?: boolean
}

function makeLabel(agentName: string, verb?: string): string {
  return verb ? `${agentName}/${verb}` : agentName
}

export async function runAgentWithChatBridge<TResult>(
  agentName: string,
  gen: AgentGenerator<TResult>,
  opts: ChatBridgeOptions = {},
): Promise<TResult> {
  const chat = useChatStore.getState()
  const label = makeLabel(agentName, opts.verb)
  const header = `[${label}]`
  chat.addMessage('system', `${header} 启动`)

  try {
    const result = opts.interactive
      ? await drive(gen, {
          onProgress: (turn) => {
            opts.onProgress?.(turn)
            chat.addMessage('system', `${header} ${turn.message}`)
          },
          onQuestion: (turn) => useChatStore.getState().presentQuestion(label, turn.question),
        })
      : await driveAuto(gen, {
          override: opts.override,
          onProgress: (turn) => {
            opts.onProgress?.(turn)
            chat.addMessage('system', `${header} ${turn.message}`)
          },
        })
    chat.addMessage('system', `${header} 完成`)
    return result
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    chat.addMessage('system', `${header} 失败: ${msg}`)
    throw err
  }
}
