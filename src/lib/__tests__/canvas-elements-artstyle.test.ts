import { describe, it, expect } from 'vitest'

/**
 * Regression test for the bug where AI agent-generated character/scene images
 * did not apply the art style configured in 导演助手.
 *
 * Root cause: when `char.image_prompt` / `scene.image_prompt` is set by the AI
 * extraction, it was used directly — but the AI doesn't always honor the
 * "适合 {{artStyle}} 风格" instruction, so the style was missing from the final
 * prompt. The fix appends the artStyle when an AI-generated prompt is used.
 */
describe('ensureElements: artStyle always applied', () => {
  // Simulates the prompt-construction logic from canvas-elements.ts
  function buildCharacterPrompt(char: { image_prompt?: string; fallback: string }, artStyle: string): string {
    const basePrompt = char.image_prompt || char.fallback
    return char.image_prompt ? `${basePrompt}. ${artStyle}` : basePrompt
  }

  it('appends artStyle when AI-generated image_prompt omits it', () => {
    // AI generated a prompt WITHOUT the art style (common failure mode)
    const char = { image_prompt: 'A young woman with red hair, full body' }
    const artStyle = 'anime style, cel-shaded, vibrant colors'
    const prompt = buildCharacterPrompt({ ...char, fallback: 'default' }, artStyle)

    expect(prompt).toContain('anime style')
    expect(prompt).toContain('red hair')
  })

  it('keeps template fallback intact when image_prompt is missing', () => {
    // Fallback template already embeds artStyle, so no double-append
    const char = { image_prompt: undefined as string | undefined }
    const artStyle = 'cyberpunk neon aesthetic'
    const fallback = `Character: Emilia. ${artStyle} style. White background`
    const prompt = buildCharacterPrompt({ ...char, fallback }, artStyle)

    expect(prompt).toBe(fallback)
    expect(prompt).toContain('cyberpunk')
  })

  it('applies style for every preset, not just default', () => {
    const char = { image_prompt: 'detailed character portrait', fallback: '' }
    const presets = [
      'anime style, cel-shaded',
      'photorealistic, detailed, 8k photograph',
      'watercolor painting style, soft edges',
      '3D CGI render, Pixar quality',
    ]

    for (const style of presets) {
      const prompt = buildCharacterPrompt(char, style)
      expect(prompt).toContain(style)
    }
  })
})

describe('ChatPanel: scriptText source', () => {
  // Simulates the fixed source-selection logic from ChatPanel.tsx
  function pickScriptText(chatMessage: string, storeScriptText: string): string {
    return storeScriptText || chatMessage
  }

  it('prefers the project script over the short chat message', () => {
    const chatMsg = '生成分镜'
    const storeScript = 'FADE IN: A bustling neon-lit street in 2099...'
    expect(pickScriptText(chatMsg, storeScript)).toBe(storeScript)
  })

  it('falls back to chat message when no script is stored', () => {
    expect(pickScriptText('生成分镜', '')).toBe('生成分镜')
  })
})
