/**
 * `{{var}}` substitution shared by all agent prompt files.
 *
 * Mirrors the behavior of the legacy fillPrompt(): missing keys are replaced
 * with empty string, no escaping. That's safe because agent prompts are sent
 * to LLMs, not rendered as HTML.
 */

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

/** List the `{{var}}` names referenced in a template, in order of appearance. */
export function listTemplateVars(template: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of template.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}
