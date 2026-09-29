/**
 * StoryVerse 网关客户端。测的是 pitfalls.md 里那几条「违反了就白烧钱」的硬约束，
 * 不是 HTTP 细节：信封归一化、契约 model id、genMode 推断、2.5-only 模式的闸门。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildVideoBody,
  gatewayModelFor,
  svgwModeFor,
  svgwSubmitVideo,
  svgwFetchVideo,
  isGateway25,
} from '../svgw-client'

const OK = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
  headers: new Headers(),
})

describe('gatewayModelFor', () => {
  it('maps Ark universal ids to sv- contract models', () => {
    expect(gatewayModelFor('dreamina-seedance-2-5-260628')).toBe('sv-seedance-2.5')
    expect(gatewayModelFor('dreamina-seedance-2-0-260128')).toBe('sv-seedance-2.0')
  })

  it('folds the fast tier into 2.0 — the gateway has no fast', () => {
    expect(gatewayModelFor('dreamina-seedance-2-0-fast-260128')).toBe('sv-seedance-2.0')
  })

  it('passes sv- ids through untouched', () => {
    expect(gatewayModelFor('sv-veo-3.1')).toBe('sv-veo-3.1')
  })

  it('falls back for endpoint ids, which the gateway does not know', () => {
    expect(gatewayModelFor('ep-20260423151341-p2zm9')).toBe('sv-seedance-2.0')
    expect(gatewayModelFor(undefined)).toBe('sv-seedance-2.0')
  })

  it('only 2.5 counts as 2.5', () => {
    expect(isGateway25('sv-seedance-2.5')).toBe(true)
    expect(isGateway25('sv-seedance-2.0')).toBe(false)
  })
})

describe('svgwModeFor', () => {
  it('a reference video means video-ref — the 白模重拍 case', () => {
    expect(svgwModeFor({ images: 3, videos: 1, audios: 2 })).toBe('video-ref')
  })

  it('images without a frame role are image-ref', () => {
    expect(svgwModeFor({ images: 4, videos: 0, audios: 0 })).toBe('image-ref')
  })

  it('honors explicit first / first-last frame roles', () => {
    expect(svgwModeFor({ images: 1, videos: 0, audios: 0, imageRole: 'first' })).toBe('first-frame')
    expect(svgwModeFor({ images: 2, videos: 0, audios: 0, imageRole: 'first-last' })).toBe('first-last-frame')
  })

  it('no material at all is text-to-video', () => {
    expect(svgwModeFor({ images: 0, videos: 0, audios: 0 })).toBe('text-to-video')
  })
})

describe('buildVideoBody', () => {
  it('puts duration / ratio / resolution in metadata, material at top level', () => {
    const body = buildVideoBody({
      model: 'sv-seedance-2.5',
      prompt: '一个镜头',
      mode: 'video-ref',
      images: ['https://x/a.jpg'],
      videos: ['https://x/b.mp4'],
      ratio: '16:9',
      duration: 10,
      resolution: '720p',
    })
    expect(body.model).toBe('sv-seedance-2.5')
    expect(body.mode).toBe('video-ref')
    expect(body.images).toEqual(['https://x/a.jpg'])
    expect(body.videos).toEqual(['https://x/b.mp4'])
    expect(body.metadata).toMatchObject({ genMode: 'video-ref', ratio: '16:9', duration: 10, resolution: '720p' })
  })

  it('omits empty material arrays instead of sending []', () => {
    const body = buildVideoBody({ model: 'sv-seedance-2.0', prompt: 'x', images: [], videos: [] })
    expect(body).not.toHaveProperty('images')
    expect(body).not.toHaveProperty('videos')
  })
})

describe('svgwSubmitVideo / svgwFetchVideo', () => {
  beforeEach(() => {
    process.env.SVGW_API_KEY = 'sk-test'
    process.env.SVGW_BASE_URL = 'https://gw.test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SVGW_API_KEY
    delete process.env.SVGW_BASE_URL
  })

  it('reads the task id from the TOP level when there is no data block', async () => {
    // pitfalls #7：id 在顶层不在 data 下。只认 data 的解析会静默漏掉任务 id ——
    // 任务照跑照计费，结果却拿不回来。
    vi.stubGlobal('fetch', vi.fn(async () => OK({ id: 'task-top', created_at: 1 })))
    await expect(svgwSubmitVideo({ model: 'sv-seedance-2.5', prompt: 'x', mode: 'video-ref' })).resolves.toBe('task-top')
  })

  it('also accepts the data-wrapped envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => OK({ data: { task_id: 'task-nested' } })))
    await expect(svgwSubmitVideo({ model: 'sv-seedance-2.5', prompt: 'x' })).resolves.toBe('task-nested')
  })

  it('sends a browser User-Agent — the gateway 403s bare clients', async () => {
    const spy = vi.fn(async () => OK({ id: 't' }))
    vi.stubGlobal('fetch', spy)
    await svgwSubmitVideo({ model: 'sv-seedance-2.5', prompt: 'x' })
    const headers = (spy.mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(headers['User-Agent']).toMatch(/Mozilla/)
    expect(headers.Authorization).toBe('Bearer sk-test')
  })

  it('lets 2.0 + video-ref through —实测 Ark 收下了（r2v），不许凭注释拦人', async () => {
    const spy = vi.fn(async () => OK({ id: 't' }))
    vi.stubGlobal('fetch', spy)
    await expect(svgwSubmitVideo({ model: 'sv-seedance-2.0', prompt: 'x', mode: 'video-ref' })).resolves.toBe('t')
  })

  it('surfaces a submit failure with the gateway body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400, headers: new Headers(),
      text: async () => JSON.stringify({ error: 'duration must be 4 to 30' }),
    })))
    await expect(svgwSubmitVideo({ model: 'sv-seedance-2.5', prompt: 'x' })).rejects.toThrow(/duration must be 4 to 30/)
  })

  it('normalizes the result: metadata.url + uppercase status + quota', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => OK({
      data: { status: 'SUCCESS', quota: 250_000, metadata: { url: 'https://cdn/out.mp4' } },
    })))
    const r = await svgwFetchVideo('t1')
    expect(r).toMatchObject({ done: true, failed: false, url: 'https://cdn/out.mp4', quota: 250_000 })
  })

  it('reports terminal failure with the reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => OK({ status: 'failed', fail_reason: 'InputImageSensitiveContentDetected' })))
    const r = await svgwFetchVideo('t2')
    expect(r.failed).toBe(true)
    expect(r.done).toBe(false)
    expect(r.failure).toMatch(/Sensitive/)
  })

  it('a still-running task is neither done nor failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => OK({ id: 't3', status: 'processing' })))
    const r = await svgwFetchVideo('t3')
    expect(r).toMatchObject({ done: false, failed: false, url: '' })
  })
})
