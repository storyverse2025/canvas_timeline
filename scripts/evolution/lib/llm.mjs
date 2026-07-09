// Direct HTTP client to the evolution dev server's /capabilities/run,
// used by the Digester/Planner/Evolver/Critic stages. Deliberately does not
// import anything from src/ — this runs as a plain Node script outside the
// Vite/TS toolchain, hitting the SAME running server the bench e2e test
// targets (EVOLUTION_BASE_URL).

export async function freeformText(baseUrl, systemAndPrompt, { temperature = 0.4 } = {}) {
  const res = await fetch(`${baseUrl}/capabilities/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capability: 'freeform-text',
      params: { temperature },
      inputs: [{ kind: 'text', text: systemAndPrompt }],
    }),
  })
  const raw = await res.text()
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`freeformText: non-JSON response (HTTP ${res.status}): ${raw.slice(0, 200)}`)
  }
  if (!res.ok || data.error) throw new Error(data.error ?? `freeformText: HTTP ${res.status}`)
  return data.outputs?.[0]?.text ?? ''
}

/** Parse a stage's JSON output, stripping optional markdown fences. */
export function parseJsonOutput(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  return JSON.parse(cleaned)
}

export async function healthCheck(baseUrl, timeoutMs = 5000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/capabilities/list`, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
