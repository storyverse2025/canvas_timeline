/**
 * Server-side skill injection for 导演助手 (director-assistant pipeline).
 *
 * The pipeline's text steps are single-shot apimart chat completions — no tool
 * loop, so the model can't call skill-hub's MCP tools itself. Instead the
 * capabilities server fetches the SKILL.md mapped to the current pipeline
 * stage (sent by the browser as `params.stage`, see capabilities/client.ts)
 * over skill-hub's streamable-HTTP MCP endpoint and appends it to the system
 * prompt as reference knowledge.
 *
 * Fail-open by design: skill-hub down / slow / unknown slug → the system
 * prompt is returned unchanged and a warning is logged. A skill-hub hiccup
 * must never fail a generation.
 *
 * Env:
 *   SKILL_HUB_MCP_URL  default http://127.0.0.1:8421/mcp (systemd skill-hub-mcp)
 *   DIRECTOR_SKILLS=off  disable injection (A/B against the genre benchmarks)
 */

/** Pipeline stage (setTraceContext in director-assistant.ts) → skill-hub slugs. */
// 'script-agent-dossier' is deliberately unmapped: that stage also generates
// the interview questions, which must come from the input script — a generic
// 剧本 skill ("先问清对标作品/风格/篇幅") would pull them toward a fixed form.
export const STAGE_SKILLS: Record<string, string[]> = {
  'character-design': ['character-appearance-anchoring'],
  'style-bible': ['mei-shu-zi-chan-ding-diao'],
  'allocate-shots': ['cai-dao-fen-jing'],
  'compose-shots': ['fen-jing-he-jing-tou-yu-yan'],
  'generate-storyboard-table': ['seedance-storyboard'],
  'actor-enrich-table': ['qing-xu-dao-yan'],
  'critique-timeline': ['cai-dao-fen-jing'],
  'critique-composition': ['fen-jing-he-jing-tou-yu-yan'],
}

const CACHE_TTL_MS = 10 * 60 * 1000
const FAIL_TTL_MS = 60 * 1000
const TIMEOUT_MS = 5000
const MAX_SKILL_CHARS = 8000

function mcpUrl(): string {
  return process.env.SKILL_HUB_MCP_URL || 'http://127.0.0.1:8421/mcp'
}

export function skillsDisabled(): boolean {
  return /^(off|0|false|no)$/i.test(process.env.DIRECTOR_SKILLS ?? '')
}

/** Last JSON-RPC message in a response body that is either plain JSON or SSE (`data:` lines). */
export function parseMcpBody(raw: string): { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } } | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const datas = trimmed.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
  return datas.length ? JSON.parse(datas[datas.length - 1]) : null
}

/** Drop get_skill's `# name (slug vX)` / tags / source header and the YAML frontmatter. */
export function stripSkillHeader(doc: string): string {
  const lines = doc.split('\n')
  const isSep = (l: string | undefined) => l !== undefined && /^\s*(---)?\s*$/.test(l)
  let i = 0
  if (/^# .*\(.+\)\s*$/.test(lines[0] ?? '')) {
    i = 1
    while (i < lines.length && /^(tags|source):/.test(lines[i])) i++
  }
  while (isSep(lines[i]) && i < lines.length) i++
  // YAML frontmatter: `name:` … up to the closing `---`.
  if (/^name:/.test(lines[i] ?? '')) {
    while (i < lines.length && !/^---\s*$/.test(lines[i])) i++
    while (isSep(lines[i]) && i < lines.length) i++
  }
  return lines.slice(i).join('\n').trim()
}

let sessionId: string | undefined

async function rpc(body: Record<string, unknown>): Promise<ReturnType<typeof parseMcpBody>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(mcpUrl(), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const raw = await res.text()
  if (!res.ok) throw Object.assign(new Error(`skill-hub HTTP ${res.status}`), { status: res.status })
  return raw.trim() ? parseMcpBody(raw) : null
}

async function initSession(): Promise<void> {
  sessionId = undefined
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'canvas-timeline', version: '1' } } })
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
}

async function fetchSkill(slug: string): Promise<string> {
  const call = () => rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_skill', arguments: { skill: slug } } })
  if (!sessionId) await initSession()
  let msg
  try {
    msg = await call()
  } catch (e) {
    // Session expired (skill-hub restarted) → re-initialize once.
    if ((e as { status?: number }).status && (e as { status: number }).status < 500) {
      await initSession()
      msg = await call()
    } else {
      throw e
    }
  }
  if (msg?.error) throw new Error(`get_skill ${slug}: ${msg.error.message}`)
  const text = (msg?.result?.content ?? []).map((c) => c.text ?? '').join('')
  if (msg?.result?.isError || !text) throw new Error(`get_skill ${slug}: ${text.slice(0, 120) || 'empty'}`)
  const body = stripSkillHeader(text)
  return body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS)}\n…(截断)` : body
}

const cache = new Map<string, { at: number; text: string | null; pending?: Promise<string | null> }>()

async function getSkillCached(slug: string): Promise<{ text: string | null; cached: boolean }> {
  const hit = cache.get(slug)
  const now = Date.now()
  if (hit?.pending) return { text: await hit.pending, cached: true }
  if (hit && now - hit.at < (hit.text ? CACHE_TTL_MS : FAIL_TTL_MS)) return { text: hit.text, cached: true }
  const pending = fetchSkill(slug).catch((e: Error) => {
    console.warn(`[skills] skill-hub get_skill ${slug} failed: ${e.message}`)
    return null
  })
  cache.set(slug, { at: now, text: hit?.text ?? null, pending })
  const text = await pending
  cache.set(slug, { at: Date.now(), text })
  return { text, cached: false }
}

/**
 * Append the stage's skills to `system` as reference knowledge. Returns
 * `system` untouched when the stage has no mapping, injection is disabled, or
 * skill-hub can't be reached.
 */
export async function withStageSkills(system: string, stage: unknown): Promise<string> {
  if (typeof stage !== 'string' || skillsDisabled()) return system
  const slugs = STAGE_SKILLS[stage]
  if (!slugs?.length) return system
  const blocks: string[] = []
  const log: string[] = []
  for (const slug of slugs) {
    const { text, cached } = await getSkillCached(slug)
    if (!text) continue
    blocks.push(`<skill name="${slug}">\n${text}\n</skill>`)
    log.push(`+${slug} (${(text.length / 1024).toFixed(1)}KB${cached ? ' cached' : ''})`)
  }
  if (!blocks.length) return system
  console.log(`[skills] stage=${stage} ${log.join(' ')}`)
  return [
    system,
    '',
    '以下是来自 skill-hub 的参考知识，只用来提升专业质量。任务、输出格式和字数限制一律以用户消息为准；不要向用户提问，不要改变输出格式，技能里关于「先问用户」「分步迭代」之类的交互建议在这里不适用。',
    '<skills>',
    ...blocks,
    '</skills>',
  ].join('\n')
}

/** Test hook. */
export function resetSkillHubClient(): void {
  cache.clear()
  sessionId = undefined
}
