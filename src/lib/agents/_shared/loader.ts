/**
 * Node-side agent loader. Reads an agent folder from disk, parses SKILL.md
 * frontmatter, and returns AgentMeta + body. Used by hermes-runner-based
 * scripts and tests.
 *
 * Browser bundles do NOT use this. They `import skill from './SKILL.md?raw'`
 * inside each agent's index.ts and parse the frontmatter the same way.
 */

import { parseFrontmatter } from './mustache/frontmatter'
import type { AgentMeta } from './runtime/types'

export interface LoadedAgent {
  /** Folder slug, e.g. 'script-agent'. */
  slug: string
  /** Absolute path to the agent folder. */
  folder: string
  meta: AgentMeta
  /** Markdown body (frontmatter stripped). */
  systemPrompt: string
  /** Raw SKILL.md contents (frontmatter included). */
  raw: string
}

export async function loadAgentFromDisk(folder: string): Promise<LoadedAgent> {
  const { readFile } = await import('node:fs/promises')
  const { basename, join } = await import('node:path')
  const skillPath = join(folder, 'SKILL.md')
  const raw = await readFile(skillPath, 'utf8')
  const { data, body } = parseFrontmatter(raw)
  return {
    slug: basename(folder),
    folder,
    meta: normalizeMeta(data),
    systemPrompt: body.trim(),
    raw,
  }
}

export function parseAgentSource(raw: string, slug: string, folder = ''): LoadedAgent {
  const { data, body } = parseFrontmatter(raw)
  return {
    slug,
    folder,
    meta: normalizeMeta(data),
    systemPrompt: body.trim(),
    raw,
  }
}

function normalizeMeta(data: Record<string, unknown>): AgentMeta {
  const name = typeof data.name === 'string' ? data.name : 'unnamed-agent'
  const description = typeof data.description === 'string' ? data.description : ''
  const model = typeof data.model === 'string' ? data.model : undefined

  const tools = Array.isArray(data.tools)
    ? (data.tools as unknown[]).filter(
        (t): t is Record<string, unknown> => typeof t === 'object' && t !== null,
      )
    : undefined

  const subAgents = Array.isArray(data.subAgents)
    ? (data.subAgents as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined

  const { name: _n, description: _d, model: _m, tools: _t, subAgents: _s, ...extra } = data
  void _n
  void _d
  void _m
  void _t
  void _s

  return {
    name,
    description,
    model,
    tools,
    subAgents,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  }
}
