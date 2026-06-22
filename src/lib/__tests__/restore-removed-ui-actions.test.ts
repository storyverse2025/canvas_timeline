import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')
const exists = (rel: string) => existsSync(path.join(repoRoot, rel))

describe('restored removed UI actions', () => {
  it('restores the Director voice casting panel entry point', () => {
    expect(exists('src/components/director/CastVoicePanel.tsx')).toBe(true)
    const scriptDialog = read('src/components/director/ScriptInputDialog.tsx')
    const panel = read('src/components/director/CastVoicePanel.tsx')

    expect(scriptDialog).toContain("import { CastVoicePanel } from './CastVoicePanel'")
    expect(scriptDialog).toContain('<CastVoicePanel />')
    expect(panel).toContain('const EMPTY_CARDS')
    expect(panel).toContain('const EMPTY_BINDINGS')
    expect(panel).not.toContain('useProjectDB((s) => s.script.castingCards ?? [])')
    expect(panel).not.toContain('useProjectDB((s) => s.script.voiceBindings ?? {})')
  })

  it('keeps the chat AI quick action for adding missing storyboard rows wired', () => {
    const quickActions = read('src/components/chat/QuickActions.tsx')
    const chatPanel = read('src/components/chat/ChatPanel.tsx')
    const handlers = read('src/lib/chat-quick-actions.ts')

    expect(quickActions).toContain("id: 'add-missing-storyboard-rows'")
    expect(quickActions).toContain("label: '添加缺失的分镜行'")
    expect(chatPanel).toContain('quickAddMissingStoryboardRows')
    expect(handlers).toContain('export async function quickAddMissingStoryboardRows')
  })

  it('restores timeline merged-video export button and ffmpeg dev-server endpoint', () => {
    expect(exists('src/components/timeline/TimelineExportButton.tsx')).toBe(true)
    expect(exists('src/lib/timeline-export.ts')).toBe(true)
    expect(exists('vite-timeline-export-plugin.ts')).toBe(true)
    expect(exists('vite-asset-proxy-plugin.ts')).toBe(true)

    const controls = read('src/components/timeline/TimelineControls.tsx')
    const config = read('vite.config.ts')
    const client = read('src/lib/timeline-export.ts')
    const plugin = read('vite-timeline-export-plugin.ts')

    expect(controls).toContain("import { TimelineExportButton } from './TimelineExportButton'")
    expect(controls).toContain('<TimelineExportButton />')
    expect(config).toContain("import { timelineExportPlugin } from './vite-timeline-export-plugin'")
    expect(config).toContain('timelineExportPlugin()')
    expect(config).toContain("import { assetProxyPlugin } from './vite-asset-proxy-plugin'")
    expect(config).toContain('assetProxyPlugin()')
    expect(client).toContain('exportMergedVideoServerSide')
    expect(client).toContain('/timeline/export-server')
    expect(plugin).toContain("spawn('ffmpeg'")
    expect(plugin).toContain('/timeline/export-server')
  })
})
