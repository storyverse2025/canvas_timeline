import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseMcpBody, stripSkillHeader, withStageSkills, resetSkillHubClient, STAGE_SKILLS } from '../skill-hub-client'

const DOC = [
  '# 蔡导分镜  (cai-dao-fen-jing v0.1.0)',
  'tags: cinematography, seedance, video, zh',
  'source: local  license: unspecified',
  '',
  '---',
  '',
  '---',
  'name: 蔡导分镜',
  'description: 教 AI 助手用电影语言帮用户设计分镜',
  'tags:',
  '- zh',
  '---',
  '',
  '# AI 视频分镜与运镜提示词技能',
  '',
  '## Purpose',
  '单一焦点。',
].join('\n')

function sse(msg: unknown): string {
  return `event: message\ndata: ${JSON.stringify(msg)}\n\n`
}

function mockSkillHub(opts: { fail?: boolean } = {}) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    calls.push(body.method === 'tools/call' ? `get_skill:${body.params.arguments.skill}` : body.method)
    if (opts.fail) throw new Error('ECONNREFUSED')
    const headers = new Headers({ 'mcp-session-id': 's1' })
    if (body.method === 'initialize') return new Response(sse({ jsonrpc: '2.0', id: 1, result: {} }), { headers })
    if (body.method === 'notifications/initialized') return new Response('', { status: 202, headers })
    return new Response(sse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: DOC }], isError: false } }), { headers })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

describe('skill-hub-client', () => {
  beforeEach(() => {
    resetSkillHubClient()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('parses SSE and plain JSON bodies', () => {
    expect(parseMcpBody(sse({ id: 2, result: { isError: false } }))?.result?.isError).toBe(false)
    expect(parseMcpBody('{"id":1,"error":{"message":"x"}}')?.error?.message).toBe('x')
  })

  it('strips the get_skill header and YAML frontmatter, keeping the body', () => {
    const body = stripSkillHeader(DOC)
    expect(body.startsWith('# AI 视频分镜与运镜提示词技能')).toBe(true)
    expect(body).not.toContain('name: 蔡导分镜')
    expect(body).not.toContain('source: local')
  })

  it('appends the mapped skill after the original system prompt and caches it', async () => {
    const calls = mockSkillHub()
    const sys = await withStageSkills('只输出 JSON 数组。', 'allocate-shots')
    expect(STAGE_SKILLS['allocate-shots']).toContain('cai-dao-fen-jing')
    expect(sys.startsWith('只输出 JSON 数组。')).toBe(true)
    expect(sys).toContain('不要向用户提问')
    expect(sys).toContain('<skill name="cai-dao-fen-jing">')
    expect(sys).toContain('单一焦点。')
    await withStageSkills('x', 'critique-timeline') // same slug → cache hit
    expect(calls.filter((c) => c.startsWith('get_skill'))).toEqual(['get_skill:cai-dao-fen-jing'])
  })

  it('leaves the system prompt untouched without a mapped stage, when disabled, or when skill-hub is down', async () => {
    const calls = mockSkillHub()
    expect(await withStageSkills('sys', undefined)).toBe('sys')
    expect(await withStageSkills('sys', 'voice-casting')).toBe('sys')
    vi.stubEnv('DIRECTOR_SKILLS', 'off')
    expect(await withStageSkills('sys', 'allocate-shots')).toBe('sys')
    expect(calls).toEqual([])
    vi.unstubAllEnvs()
    mockSkillHub({ fail: true })
    expect(await withStageSkills('sys', 'allocate-shots')).toBe('sys')
  })
})
