import { describe, it, expect, vi, beforeEach } from 'vitest'

import { runCapability } from '@/lib/capabilities/client'
import {
  artDirectorAgent,
  critiqueComposition,
  extractElements,
  generateAssetImages,
  generateStyleBible,
} from '@/lib/agents/art-director-agent'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { driveAuto } from '@/lib/agents/_shared/runtime/runner'
import type { LLM } from '@/lib/agents/_shared/llm/types'

vi.mock('@/lib/capabilities/client', () => ({
  runCapability: vi.fn(),
}))
const mockedRunCapability = vi.mocked(runCapability)

function llmReturning(...responses: string[]): { llm: LLM; spy: ReturnType<typeof vi.fn> } {
  let i = 0
  const spy = vi.fn(async () => {
    const r = responses[i] ?? ''
    i++
    return r
  })
  return { llm: { complete: spy }, spy }
}

describe('art-director-agent: meta', () => {
  it('exposes the four verbs as members of the module', () => {
    expect(artDirectorAgent.extractElements).toBe(extractElements)
    expect(artDirectorAgent.generateAssetImages).toBe(generateAssetImages)
    expect(artDirectorAgent.generateStyleBible).toBe(generateStyleBible)
    expect(artDirectorAgent.critiqueComposition).toBe(critiqueComposition)
    expect(artDirectorAgent.meta.name).toBe('art-director-agent')
  })
})

describe('extractElements', () => {
  beforeEach(() => mockedRunCapability.mockReset())

  it('parses characters, scenes, props into an ExtractionResult', async () => {
    const { llm } = llmReturning(
      JSON.stringify([{ name: 'Alice', gender: 'female', appearance: 'short hair', clothing: 'coat', expression: 'calm', image_prompt: 'prompt-a' }]),
      JSON.stringify([{ name: 'Rooftop', location: 'city', lighting: 'dusk', mood: 'tense', image_prompt: 'prompt-s' }]),
      JSON.stringify([{ name: 'Pocketwatch', description: 'silver', image_prompt: 'prompt-p' }]),
    )
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      extractElements({ scriptAnalysis: '...', artStyle: 'cinematic' }, ctx),
    )
    expect(result.characters[0]!.name).toBe('Alice')
    expect(result.scenes[0]!.name).toBe('Rooftop')
    expect(result.props[0]!.name).toBe('Pocketwatch')
  })

  it('returns empty arrays for malformed JSON instead of throwing', async () => {
    const { llm } = llmReturning('not json', 'still not json', '[]')
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      extractElements({ scriptAnalysis: '...', artStyle: 'cinematic' }, ctx),
    )
    expect(result.characters).toEqual([])
    expect(result.scenes).toEqual([])
    expect(result.props).toEqual([])
  })

  it('skips invalid items inside an otherwise-valid array', async () => {
    const { llm } = llmReturning(
      JSON.stringify([
        { name: 'OK', gender: 'm', appearance: '', clothing: '', expression: '', image_prompt: '' },
        { gender: 'no name' }, // invalid (missing name)
      ]),
      '[]',
      '[]',
    )
    const ctx = createMemoryContext({ llm })
    const result = await driveAuto(
      extractElements({ scriptAnalysis: '...', artStyle: 'cinematic' }, ctx),
    )
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0]!.name).toBe('OK')
  })

  it('fills the artStyle into the character extraction prompt', async () => {
    const { llm, spy } = llmReturning('[]', '[]', '[]')
    const ctx = createMemoryContext({ llm })
    await driveAuto(
      extractElements({ scriptAnalysis: 'SCRIPT', artStyle: 'noir' }, ctx),
    )
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('SCRIPT')
    expect(sent).toContain('noir')
  })
})

describe('generateAssetImages', () => {
  beforeEach(() => mockedRunCapability.mockReset())

  it('fills img_url and generation_prompt for elements without an existing URL', async () => {
    let call = 0
    mockedRunCapability.mockImplementation(async () => {
      call++
      return { outputs: [{ kind: 'image', url: `https://assets/${call}.png` }] }
    })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateAssetImages({
        artStyle: 'anime',
        extraction: {
          characters: [{ name: 'A', gender: 'f', appearance: 'x', clothing: 'y', expression: 'z', image_prompt: 'CHAR-PROMPT' }],
          scenes: [{ name: 'S', location: 'l', lighting: 'sun', mood: 'calm', image_prompt: 'SCENE-PROMPT' }],
          props: [{ name: 'P', description: 'thing', image_prompt: 'PROP-PROMPT' }],
        },
      }, ctx),
    )
    expect(result.characters[0]!.img_url).toMatch(/^https:\/\/assets\//)
    expect(result.characters[0]!.generation_prompt).toBe('CHAR-PROMPT')
    expect(result.scenes[0]!.img_url).toMatch(/^https:\/\/assets\//)
    expect(result.props[0]!.img_url).toMatch(/^https:\/\/assets\//)
  })

  it('skips elements that already have an img_url by default', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://new.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateAssetImages({
        artStyle: 'cinematic',
        extraction: {
          characters: [{ name: 'A', gender: '', appearance: '', clothing: '', expression: '', image_prompt: 'p', img_url: 'https://existing.png' }],
          scenes: [],
          props: [],
        },
      }, ctx),
    )
    expect(result.characters[0]!.img_url).toBe('https://existing.png')
    expect(mockedRunCapability).not.toHaveBeenCalled()
  })

  it('regenerates already-generated elements when skipIfAlreadyGenerated is false', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://regenerated.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateAssetImages({
        artStyle: 'cinematic',
        skipIfAlreadyGenerated: false,
        extraction: {
          characters: [{ name: 'A', gender: '', appearance: '', clothing: '', expression: '', image_prompt: 'p', img_url: 'https://existing.png' }],
          scenes: [],
          props: [],
        },
      }, ctx),
    )
    expect(result.characters[0]!.img_url).toBe('https://regenerated.png')
    expect(mockedRunCapability).toHaveBeenCalledOnce()
  })

  it('renders scenes as 360° equirectangular 4K panoramas (prompt + capability params)', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://scene.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      generateAssetImages({
        artStyle: 'cinematic',
        extraction: {
          characters: [],
          scenes: [{ name: 'Rooftop', location: 'old town', lighting: 'dusk', mood: 'tense', image_prompt: '' }],
          props: [],
        },
      }, ctx),
    )
    const call = mockedRunCapability.mock.calls[0]![0]
    const sentPrompt = call.inputs[0]!.text!
    // Scene-image.md mandates the 360° panorama treatment.
    expect(sentPrompt).toContain('360° immersive equirectangular panorama')
    expect(sentPrompt).toContain('4K ultra-high definition')
    expect(sentPrompt).toContain('2:1 aspect ratio')
    expect(sentPrompt).toContain('Seamless seam-free wraparound')
    // Global art style threaded in.
    expect(sentPrompt).toContain('cinematic')
    // Capability params request HD + 4K for scene assets.
    expect(call.params?.quality).toBe('hd')
    expect(call.params?.resolution).toBe('4k')
  })

  it('falls back to the prop-turnaround template when prop.image_prompt is empty', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://prop.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      generateAssetImages({
        artStyle: 'cinematic',
        extraction: {
          characters: [],
          scenes: [],
          props: [{ name: 'Pocketwatch', description: 'silver, 19th century', image_prompt: '' }],
        },
      }, ctx),
    )
    const sentPrompt = mockedRunCapability.mock.calls[0]![0].inputs[0]!.text!
    // Multi-angle turnaround mandate from prop-image.md.
    expect(sentPrompt).toContain('turnaround sheet')
    expect(sentPrompt).toContain('front view')
    expect(sentPrompt).toContain('side view')
    expect(sentPrompt).toContain('back view')
    expect(sentPrompt).toContain('extreme close-up')
    expect(sentPrompt).toContain('100% consistent')
    // Global art style flows through.
    expect(sentPrompt).toContain('cinematic')
    // Prop description threaded in.
    expect(sentPrompt).toContain('Pocketwatch')
  })

  it('respects maxPerKind caps', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://x.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      generateAssetImages({
        artStyle: 'cinematic',
        maxPerKind: { characters: 1, scenes: 0, props: 1 },
        extraction: {
          characters: [
            { name: 'A', gender: '', appearance: '', clothing: '', expression: '', image_prompt: 'a' },
            { name: 'B', gender: '', appearance: '', clothing: '', expression: '', image_prompt: 'b' },
          ],
          scenes: [{ name: 'S', location: '', lighting: '', mood: '', image_prompt: 's' }],
          props: [
            { name: 'P1', description: '', image_prompt: 'p1' },
            { name: 'P2', description: '', image_prompt: 'p2' },
          ],
        },
      }, ctx),
    )
    expect(mockedRunCapability).toHaveBeenCalledTimes(2) // 1 char + 0 scenes + 1 prop
  })

  it('leaves img_url undefined when the capability returns no outputs', async () => {
    // Defensive path: text-to-image responded but produced no image url.
    mockedRunCapability.mockResolvedValue({ outputs: [] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    const result = await driveAuto(
      generateAssetImages({
        artStyle: 'cinematic',
        extraction: {
          characters: [{ name: 'A', gender: '', appearance: '', clothing: '', expression: '', image_prompt: 'p' }],
          scenes: [],
          props: [],
        },
      }, ctx),
    )
    expect(result.characters[0]!.img_url).toBeUndefined()
    expect(result.characters[0]!.generation_prompt).toBe('p')
  })

  it('falls back to template-built prompts when image_prompt is empty', async () => {
    mockedRunCapability.mockResolvedValue({ outputs: [{ kind: 'image', url: 'https://x.png' }] })
    const ctx = createMemoryContext({ llm: { complete: async () => '' } })
    await driveAuto(
      generateAssetImages({
        artStyle: 'noir',
        extraction: {
          characters: [{ name: 'Eve', gender: 'female', appearance: 'bob', clothing: 'trench', expression: 'sly', image_prompt: '' }],
          scenes: [],
          props: [],
        },
      }, ctx),
    )
    const sentPrompt = mockedRunCapability.mock.calls[0]![0].inputs[0]!.text!
    expect(sentPrompt).toContain('Eve')
    expect(sentPrompt).toContain('noir')
    expect(sentPrompt).toContain('Final Fantasy CG game style') // from template
  })
})

describe('generateStyleBible', () => {
  it('returns anchor + strategy populated from two sequential LLM calls', async () => {
    const { llm, spy } = llmReturning('ANCHOR-OUT', 'STRATEGY-OUT')
    const ctx = createMemoryContext({ llm })
    const bible = await driveAuto(
      generateStyleBible({
        artStyle: 'cinematic',
        stylePreset: 'cinematic',
        scriptAnalysis: 'SCRIPT',
        characterDesigns: '[]',
        sceneDesigns: '[]',
        elementContext: 'none',
      }, ctx),
    )
    expect(bible.anchor).toBe('ANCHOR-OUT')
    expect(bible.strategy).toBe('STRATEGY-OUT')

    // The strategy prompt references the anchor (truncated to 500 chars).
    const strategyCall = spy.mock.calls[1]![0]![0]!.content as string
    expect(strategyCall).toContain('ANCHOR-OUT')
    expect(strategyCall).toContain('cinematic')
  })
})

describe('critiqueComposition', () => {
  it('parses CompositionIssue[] from the LLM response', async () => {
    const { llm } = llmReturning('[{"shot":"S3","issue":"too many close-ups","fix":"insert wide"}]')
    const ctx = createMemoryContext({ llm })
    const issues = await driveAuto(
      critiqueComposition({ storyboardJson: '[...]' }, ctx),
    )
    expect(issues).toEqual([{ shot: 'S3', issue: 'too many close-ups', fix: 'insert wide' }])
  })

  it('returns empty when the model reports no issues', async () => {
    const { llm } = llmReturning('[]')
    const ctx = createMemoryContext({ llm })
    const issues = await driveAuto(
      critiqueComposition({ storyboardJson: '[...]' }, ctx),
    )
    expect(issues).toEqual([])
  })

  it('truncates storyboardJson to 3000 chars in the prompt', async () => {
    const { llm, spy } = llmReturning('[]')
    const ctx = createMemoryContext({ llm })
    const big = 'X'.repeat(4000)
    await driveAuto(critiqueComposition({ storyboardJson: big }, ctx))
    const sent = spy.mock.calls[0]![0]![0]!.content as string
    expect(sent).toContain('XXXX')
    // Roughly: prompt body + ~3000 X chars, well under 4000.
    expect(sent.length).toBeLessThan(big.length + 1000)
  })
})
