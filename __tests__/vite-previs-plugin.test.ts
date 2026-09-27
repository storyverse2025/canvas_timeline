import { describe, it, expect } from 'vitest'
import { castInFrame, parseResultLine, summarizeTranscript } from '../vite-previs-plugin'

const line = (v: unknown) => JSON.stringify(v)
const toolUse = (name: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text: '…' }, { type: 'tool_use', name }] } })

describe('summarizeTranscript', () => {
  it('tracks tool calls and the current phase, attributing wait_job to the job before it', () => {
    const jsonl = [
      line({ type: 'system', subtype: 'init' }),
      toolUse('Skill'),
      toolUse('mcp__previs__app_status'),
      toolUse('mcp__previs__import_manifest'),
      toolUse('mcp__previs__wait_job'),
      toolUse('mcp__previs__set_staging'),
      toolUse('mcp__previs__build_scene'),
      toolUse('mcp__previs__render_episode'),
      toolUse('mcp__previs__wait_job'),
      'not json at all',
    ].join('\n')
    const s = summarizeTranscript(jsonl)
    expect(s.toolCalls).toBe(8)
    expect(s.lastTool).toBe('mcp__previs__wait_job')
    expect(s.phase).toBe('渲染')
    expect(s.resultText).toBeNull()
  })

  it('picks up the final result and error flag', () => {
    const ok = summarizeTranscript([toolUse('mcp__previs__save_project_bundle'), line({ type: 'result', subtype: 'success', is_error: false, result: 'done\nCANVAS2PREVIS_RESULT {"status":"done"}' })].join('\n'))
    expect(ok.phase).toBe('保存会话')
    expect(ok.resultText).toContain('CANVAS2PREVIS_RESULT')
    expect(ok.isError).toBe(false)

    const bad = summarizeTranscript(line({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }))
    expect(bad.isError).toBe(true)
  })
})

describe('parseResultLine', () => {
  it('parses the last result line, ignoring prose around it', () => {
    const text = [
      '示例：CANVAS2PREVIS_RESULT {"status":"error"}',
      '已完成渲染。',
      'CANVAS2PREVIS_RESULT {"status":"done","shortId":"3f2a9c1e","episode":"3f2a9c1e/out/episode.mp4","bundle":"3f2a9c1e/out/session.previs.json","beats":2,"notes":"两个 beat 同一布景"}',
    ].join('\n')
    expect(parseResultLine(text)).toEqual({
      status: 'done', shortId: '3f2a9c1e', episode: '3f2a9c1e/out/episode.mp4',
      bundle: '3f2a9c1e/out/session.previs.json', beats: 2, notes: '两个 beat 同一布景',
    })
  })
  it('returns null when missing or malformed', () => {
    expect(parseResultLine('all good')).toBeNull()
    expect(parseResultLine('CANVAS2PREVIS_RESULT {not json')).toBeNull()
  })
})

describe('castInFrame', () => {
  const CHARS = [{ key: 'blue', color: '#4f8cff' }, { key: 'red', color: '#ff6b6b' }]

  /** 造一张纯色块图：左半边给一个颜色，右半边灰底。 */
  const frameWith = async (patches: { color: string; width: number }[], file: string) => {
    const sharp = (await import('sharp')).default
    const W = 320, H = 180
    const base = sharp({ create: { width: W, height: H, channels: 3, background: '#6b6b6b' } })
    const layers = []
    let left = 0
    for (const p of patches) {
      layers.push({
        input: await sharp({ create: { width: p.width, height: H, channels: 3, background: p.color } }).png().toBuffer(),
        left, top: 0,
      })
      left += p.width
    }
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const path = join(tmpdir(), file)
    await base.composite(layers).png().toFile(path)
    return path
  }

  it('数出画面里真正出场的假人', async () => {
    const path = await frameWith([{ color: '#ff6b6b', width: 120 }], 'cast-red.png')
    await expect(castInFrame(path, CHARS)).resolves.toEqual(['red'])
  })

  it('按色相匹配，明暗变化不影响 —— 白模上的受光/背光面颜色差很远', async () => {
    // 踩过：按 RGB 距离匹配，6 帧里 5 帧检出 0%，等于没检测。
    const dark = await frameWith([{ color: '#7a3434' }].map((c) => ({ ...c, width: 120 })), 'cast-dark.png')
    await expect(castInFrame(dark, CHARS)).resolves.toEqual(['red'])
  })

  it('两个假人都在就都数出来', async () => {
    const path = await frameWith([{ color: '#4f8cff', width: 90 }, { color: '#ff6b6b', width: 90 }], 'cast-both.png')
    const got = await castInFrame(path, CHARS)
    expect(got.sort()).toEqual(['blue', 'red'])
  })

  it('画面里没有的人不要报出来', async () => {
    const path = await frameWith([{ color: '#4f8cff', width: 120 }], 'cast-blue.png')
    await expect(castInFrame(path, CHARS)).resolves.toEqual(['blue'])
  })

  it('灰模场景里一个假人都没有时返回空', async () => {
    const path = await frameWith([], 'cast-none.png')
    await expect(castInFrame(path, CHARS)).resolves.toEqual([])
  })
})
