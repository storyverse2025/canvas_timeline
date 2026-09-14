import { describe, it, expect } from 'vitest'
import { parseResultLine, summarizeTranscript } from '../vite-previs-plugin'

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
