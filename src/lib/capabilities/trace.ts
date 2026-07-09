import type { CapabilityRequest, CapabilityResponse } from './types'

/**
 * Fire-and-forget trace emission for every runCapability() call
 * (HarnessX D8). Kept in its own module so client.ts stays focused on
 * the request path; a trace failure must never break a generation.
 *
 * Trace context (runId / caseId / stage / source) is process-global:
 * director-assistant and the bench runner call setTraceContext() around
 * pipeline stages. Organic UI traffic runs with the default context and
 * gets hashes instead of full prompt text.
 */

export interface TraceContext {
  source: 'ui' | 'bench' | 'evolve'
  runId?: string
  caseId?: string
  stage?: string
}

let context: TraceContext = { source: 'ui' }

export function setTraceContext(next: Partial<TraceContext>): void {
  context = { ...context, ...next }
}

export function resetTraceContext(): void {
  context = { source: 'ui' }
}

export function getTraceContext(): TraceContext {
  return { ...context }
}

/**
 * Base URL for server endpoints. Empty in the browser (same-origin relative
 * fetches — current behavior unchanged). The bench runner sets
 * EVOLUTION_BASE_URL so the same code can hit a live dev server from a
 * vitest/Node process.
 */
export function serverBaseUrl(): string {
  if (typeof process !== 'undefined' && process.env?.EVOLUTION_BASE_URL) {
    return process.env.EVOLUTION_BASE_URL.replace(/\/$/, '')
  }
  return ''
}

/** djb2 — cheap, stable, good enough to correlate identical prompts. */
function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

function newTraceId(): string {
  return `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function emitCapabilityTrace(args: {
  req: CapabilityRequest
  res?: CapabilityResponse
  error?: string
  durationMs: number
}): void {
  try {
    const { req, res, error, durationMs } = args
    const ctx = getTraceContext()
    const promptText = req.inputs
      .filter((i) => i.kind === 'text' && i.text)
      .map((i) => i.text as string)
      .join('\n\n')
    const includeFullPrompt = ctx.source !== 'ui'
    const firstOutput = res?.outputs?.[0]

    const row = {
      traceId: newTraceId(),
      ts: Date.now(),
      source: ctx.source,
      runId: ctx.runId,
      caseId: ctx.caseId,
      stage: ctx.stage,
      capability: req.capability,
      model: typeof req.params?.model === 'string' ? req.params.model : undefined,
      promptHash: promptText ? hashText(promptText) : undefined,
      promptChars: promptText.length || undefined,
      prompt: includeFullPrompt && promptText ? promptText : undefined,
      inputs: req.inputs.map((i) => ({
        kind: i.kind,
        url: i.url && !i.url.startsWith('data:') ? i.url : i.url ? '(data-url)' : undefined,
        textHash: i.text ? hashText(i.text) : undefined,
        textChars: i.text?.length,
      })),
      output: firstOutput
        ? {
            kind: firstOutput.kind,
            url: firstOutput.url,
            text: includeFullPrompt ? firstOutput.text : undefined,
            textHash: firstOutput.text ? hashText(firstOutput.text) : undefined,
          }
        : undefined,
      durationMs,
      status: error ? 'error' : 'ok',
      error,
    }

    const url = `${serverBaseUrl()}/traces/append`
    const body = JSON.stringify(row)
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
    } else {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {})
    }
  } catch {
    // never let tracing break a generation
  }
}
