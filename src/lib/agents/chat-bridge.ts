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

/**
 * validate→retry gate around an agent verb.
 *
 * Some verbs (cast-voices, generate-storyboard-table, apply-timeline-fixes)
 * must return a precise JSON shape. Even with a dedicated capability whose
 * system prompt reinforces the contract, an LLM occasionally emits a
 * malformed / wrong-shaped payload. Rather than silently swallowing it
 * (the old behavior — empty 音色 / empty 分镜表), this re-prompts the agent
 * to regenerate up to `retries` extra times, validating each attempt.
 *
 * `makeGen` MUST return a FRESH generator each call (generators are
 * single-use), and SHOULD build a fresh agent context inside itself —
 * reusing one memory context across retries makes every retry see the
 * previous (bad) turn. `validate` returns `true` on success or an error
 * string describing what was wrong (surfaced in the retry log + final
 * throw). A throwing attempt (e.g. the verb's own schema check) is
 * retried like a validation miss — EXCEPT clearly non-retryable errors
 * (user abort, auth/key problems), which propagate immediately instead
 * of burning `retries`× the cost and then masquerading as a validation
 * failure.
 */

/** Errors that identical immediate retries can never fix. */
function isNonRetryableAgentError(msg: string): boolean {
  return (
    /abort|cancell?ed|用户取消/i.test(msg) ||
    /401|403|unauthorized|forbidden|invalid.*(api.?key|token)|api.?key.*(invalid|missing|not set)/i.test(msg)
  )
}

export async function runAgentValidated<TResult>(
  agentName: string,
  makeGen: () => AgentGenerator<TResult>,
  validate: (result: TResult) => true | string,
  opts: ChatBridgeOptions & { retries?: number } = {},
): Promise<TResult> {
  const retries = opts.retries ?? 2
  const label = makeLabel(agentName, opts.verb)
  let lastErr = '未知错误'
  let lastWasThrow = false

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await runAgentWithChatBridge(agentName, makeGen(), opts)
      const verdict = validate(result)
      if (verdict === true) return result
      lastErr = verdict
      lastWasThrow = false
    } catch (err) {
      lastErr = (err as Error).message ?? String(err)
      lastWasThrow = true
      if (isNonRetryableAgentError(lastErr)) throw err
    }
    if (attempt < retries) {
      useChatStore
        .getState()
        .addMessage('system', `[${label}] ${lastWasThrow ? '运行失败' : '输出未通过校验'}（${lastErr}），重新生成 ${attempt + 1}/${retries}`)
    }
  }
  // Report the true failure class: an infra/runtime error is not a
  // "validation" failure — calling it one sends the user debugging the
  // wrong layer.
  throw new Error(
    lastWasThrow
      ? `${label} 运行失败，已重试 ${retries} 次：${lastErr}`
      : `${label} 校验失败，已重试 ${retries} 次后仍无效：${lastErr}`,
  )
}
