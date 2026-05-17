import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const pluginPath = path.join(repoRoot, 'vite-capabilities-plugin.ts')

describe('generation API routing', () => {
  const source = () => readFileSync(pluginPath, 'utf8')

  it('prefers TokenRouter OpenAI-compatible image generation with FAL fallback like skill_generator', () => {
    const code = source()

    expect(code).toContain('TOKENROUTER_BASE_URL')
    expect(code).toContain('/images/generations')
    expect(code).toContain('TOKENROUTER_API_KEY')
    expect(code).toContain('TOKENROUTER_IMAGE_MODEL')
    expect(code).toContain('runTokenRouterImage')
    expect(code).toContain('runFalFluxImage')
    expect(code).toContain('DISABLE_FAL_IMAGE_FALLBACK')
  })

  it('uses Ark Seedance task create/poll endpoint for video generation', () => {
    const code = source()

    expect(code).toContain('ARK_API_KEY')
    expect(code).toContain('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
    // The plugin references the Seedance 2.0 model family; the default
    // is the non-fast variant at 480p (see SHOOT_MODEL in
    // cinematographer-agent/index.ts).
    expect(code).toContain('doubao-seedance-2-0')
    expect(code).toContain('submitSeedanceTask')
  })
})
