/**
 * Minimal YAML frontmatter parser tailored for agent SKILL.md files.
 *
 * Supports the subset we actually author:
 *   - `key: scalar` (string, number, boolean)
 *   - `key: [a, b, c]` (inline list of scalars)
 *   - `key:\n  - scalar` (block list of scalars)
 *   - `key:\n  - key: value\n    other: value` (block list of inline maps)
 *
 * Does NOT support: anchors, multiline strings, quoted-with-escapes,
 * deep nesting beyond list-of-maps. If we ever need any of that, swap in
 * the `yaml` npm package and delete this file.
 */

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  body: string
}

const FENCE_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const match = FENCE_RE.exec(source)
  if (!match) return { data: {}, body: source }
  const yaml = match[1]
  const body = source.slice(match[0].length)
  return { data: parseYaml(yaml), body }
}

function parseYaml(text: string): Record<string, unknown> {
  const lines = text.split('\n').filter((l) => !/^\s*#/.test(l) && l.trim().length > 0)
  const out: Record<string, unknown> = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith(' ') || line.startsWith('\t')) {
      // Stray indented line at top level — skip.
      i++
      continue
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    const after = m[2]

    if (after.length === 0) {
      // Block — collect indented children lines.
      const children: string[] = []
      let j = i + 1
      while (j < lines.length && (lines[j].startsWith(' ') || lines[j].startsWith('\t'))) {
        children.push(lines[j])
        j++
      }
      out[key] = parseBlock(children)
      i = j
    } else {
      out[key] = parseScalarOrInline(after)
      i++
    }
  }

  return out
}

function parseBlock(children: string[]): unknown {
  if (children.length === 0) return ''
  const minIndent = Math.min(...children.map(indentOf))
  const stripped = children.map((c) => c.slice(minIndent))

  if (stripped[0].startsWith('- ')) return parseList(stripped)
  return parseMap(stripped)
}

function parseList(lines: string[]): unknown[] {
  const items: unknown[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.startsWith('- ')) {
      i++
      continue
    }
    const first = line.slice(2)
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(first)
    if (!kv) {
      items.push(parseScalarOrInline(first))
      i++
      continue
    }

    // Block-map list item — collect this item's keys until next "- " or end.
    const itemMap: Record<string, unknown> = {}
    itemMap[kv[1]] = parseScalarOrInline(kv[2])
    i++
    while (i < lines.length && !lines[i].startsWith('- ')) {
      const inner = lines[i].trimStart()
      const innerKv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(inner)
      if (innerKv) itemMap[innerKv[1]] = parseScalarOrInline(innerKv[2])
      i++
    }
    items.push(itemMap)
  }
  return items
}

function parseMap(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trimStart())
    if (m) out[m[1]] = parseScalarOrInline(m[2])
  }
  return out
}

function parseScalarOrInline(raw: string): unknown {
  const value = raw.trim()
  if (value.length === 0) return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1)
    if (inner.trim().length === 0) return []
    return inner.split(',').map((s) => parseScalarOrInline(s))
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line)
  return m ? m[1].length : 0
}
