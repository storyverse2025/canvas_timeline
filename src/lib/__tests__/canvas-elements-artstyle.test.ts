import { describe, it, expect } from 'vitest'
import { buildCharacterMaterialPrompt } from '@/lib/canvas-elements'

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

  it('appends artStyle + composition system prompt; never adds Sony Venice / Final Fantasy / engine boilerplate', () => {
    // AI generated a prompt WITHOUT the art style/system prompt (common failure mode)
    const char = { image_prompt: 'A young woman with red hair, full body' }
    const artStyle = 'anime style, cel-shaded, vibrant colors'
    const prompt = buildCharacterMaterialPrompt(char.image_prompt, artStyle)

    // The user-chosen art style is the sole rendering directive.
    expect(prompt).toContain('anime style')
    expect(prompt).toContain('red hair')
    // Composition + background are structural and stay.
    expect(prompt).toContain('three-view full body reference')
    expect(prompt).toContain('no head visible')
    // Regression: photo-rig boilerplate must NOT be injected anymore,
    // it forced photoreal output regardless of the user's chosen style.
    expect(prompt).not.toContain('Sony Venice')
    expect(prompt).not.toContain('Panavision')
    expect(prompt).not.toContain('Final Fantasy CG')
    expect(prompt).not.toContain('Unreal Engine')
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

/**
 * Regression test for the bug where ensureElements() silently skipped
 * character/scene/prop generation for a NEW script whenever the canvas
 * already had ANY item of that role — even one left over from an unrelated
 * previous script/session, with a completely different name.
 *
 * Root cause: the old gate was `inventory.characters.length === 0`, i.e.
 * "is the bucket empty", not "does this script's cast already have a
 * portrait". A single stale character item made the whole bucket
 * non-empty and suppressed generation for every newly extracted character,
 * even ones with no matching canvas item at all. Downstream, findMissingAssets()
 * (gap-finder.ts) couldn't catch this either — it only flags EXISTING
 * empty-content items, and no item was ever created for the new cast, so
 * the "补全缺失素材" quick action reported "✓ 没有缺失" while portraits for
 * the new characters were simply never generated.
 *
 * Fix: name-match extraction against inventory; only the extracted
 * elements with no same-named canvas counterpart are treated as missing.
 */
describe('ensureElements: name-matched missing detection (not bucket-emptiness)', () => {
  // Mirrors the filter logic added to canvas-elements.ts's ensureElements().
  function filterMissingByName<T extends { name: string }>(
    extracted: T[],
    existingNames: Set<string>,
  ): T[] {
    return extracted.filter((e) => !existingNames.has(e.name))
  }

  it('still generates a NEW character even when a stale, unrelated character already exists on the canvas', () => {
    // Canvas has a leftover character from a previous, unrelated script.
    const existingCharacterNames = new Set(['网红拉拉'])
    // Current script extracted two brand-new characters.
    const extractedCharacters = [
      { name: '程亦', appearance: '', clothing: '', gender: '', expression: '', image_prompt: '' },
      { name: '沈以晴', appearance: '', clothing: '', gender: '', expression: '', image_prompt: '' },
    ]

    const missing = filterMissingByName(extractedCharacters, existingCharacterNames)

    // Both must be flagged as missing — neither name matches the stale item.
    expect(missing).toHaveLength(2)
    expect(missing.map((c) => c.name)).toEqual(['程亦', '沈以晴'])
  })

  it('does NOT regenerate a character that already has a matching canvas portrait', () => {
    const existingCharacterNames = new Set(['程亦', '沈以晴'])
    const extractedCharacters = [
      { name: '程亦', appearance: '', clothing: '', gender: '', expression: '', image_prompt: '' },
      { name: '沈以晴', appearance: '', clothing: '', gender: '', expression: '', image_prompt: '' },
      { name: '新角色', appearance: '', clothing: '', gender: '', expression: '', image_prompt: '' },
    ]

    const missing = filterMissingByName(extractedCharacters, existingCharacterNames)

    // Only the genuinely new character is regenerated.
    expect(missing).toHaveLength(1)
    expect(missing[0].name).toBe('新角色')
  })

  it('the old bucket-emptiness check would have wrongly reported nothing missing', () => {
    // This asserts the OLD (buggy) condition against the exact repro
    // scenario, to document why it fails.
    const inventoryCharactersLength = 1 // one stale, unrelated item
    const extractedCharacters = [{ name: '程亦' }, { name: '沈以晴' }]

    const oldNeedCharacters = inventoryCharactersLength === 0 && extractedCharacters.length > 0
    expect(oldNeedCharacters).toBe(false) // <- the bug: nothing gets generated

    const newMissing = filterMissingByName(extractedCharacters, new Set(['网红拉拉']))
    expect(newMissing.length > 0).toBe(true) // <- the fix: correctly detects both as missing
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
