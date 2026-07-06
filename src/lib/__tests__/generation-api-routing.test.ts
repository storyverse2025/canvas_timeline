import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')
const pluginPath = path.join(repoRoot, 'vite-capabilities-plugin.ts')

describe('generation API routing', () => {
  const source = () => readFileSync(pluginPath, 'utf8')

  it('prefers Apimart OpenAI-compatible image generation with FAL fallback like skill_generator', () => {
    const code = source()

    expect(code).toContain('APIMART_BASE_URL')
    expect(code).toContain('/images/generations')
    expect(code).toContain('APIMART_API_KEY')
    expect(code).toContain('APIMART_IMAGE_MODEL')
    expect(code).toContain('runApimartImage')
    expect(code).toContain('runFalFluxImage')
    // Fallback is unconditional now (the DISABLE_FAL_IMAGE_FALLBACK
    // kill-switch went away with the task-based Apimart refactor) — what
    // matters is that a failed Apimart run degrades to FAL. FAL results
    // now go through persistExternalImageUrl (same as Apimart results)
    // so they get a stable local /uploads/ path.
    expect(code).toContain('runFalFluxImage(')
    expect(code).toContain('persistExternalImageUrl')
  })

  it('uses BytePlus海外 Ark Seedance task create/poll endpoint for video generation', () => {
    const code = source()

    // BYTEPLUS_ARK_API_KEY (海外 ark-*) is the live key; ARK_API_KEY is
    // still honored as a legacy fallback for unmigrated envs.
    expect(code).toContain('BYTEPLUS_ARK_API_KEY')
    expect(code).toContain('ARK_API_KEY')
    // Host comes from ARK_BASE_URL (envable) with the BytePlus海外 default
    // baked in. The legacy cn-beijing.volces.com (火山方舟国内) endpoint
    // was removed after that account ran out of balance.
    expect(code).toContain('ark.ap-southeast.bytepluses.com')
    expect(code).toContain('/contents/generations/tasks')
    expect(code).not.toContain('ark.cn-beijing.volces.com')
    // Default model is the BytePlus Dreamina Seedance 2.0 id (non-Fast,
    // matching projectDB); an operator can override via SEEDANCE_MODEL
    // (e.g. an account-specific endpoint id like `ep-...`).
    expect(code).toContain('dreamina-seedance-2-0-260128')
    expect(code).toContain('SEEDANCE_MODEL')
    expect(code).toContain('submitSeedanceTask')
  })
})
