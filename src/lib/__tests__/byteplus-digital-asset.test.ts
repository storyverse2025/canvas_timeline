import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ByteplusAssetError,
  createDigitalAsset,
  registerAndWait,
  registerCharacterRefs,
} from '@/lib/byteplus-digital-asset'

/**
 * Mock the global fetch so each test fully controls the BytePlus
 * registration + status-poll responses. The client lives in the browser
 * (vite proxy injects the Bearer key server-side), so vi.stubGlobal('fetch', …)
 * is the right boundary.
 */
type MockedFetch = ReturnType<typeof vi.fn>

function mockJsonResponses(...responses: Array<{ ok?: boolean; status?: number; body: unknown }>): MockedFetch {
  const fetchSpy = vi.fn()
  for (const r of responses) {
    fetchSpy.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.status && r.status >= 400 ? 'Error' : 'OK',
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    })
  }
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

describe('byteplus-digital-asset', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('createDigitalAsset', () => {
    it('POSTs to the proxied path with image_url + asset_type and returns parsed asset id', async () => {
      const fetchSpy = mockJsonResponses({ body: { id: 'img_asset_001', status: 'reviewing' } })
      const out = await createDigitalAsset('https://example.com/char1.png')
      expect(out.assetId).toBe('img_asset_001')
      expect(out.status).toBe('reviewing')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toContain('/byteplus-asset/contents/digital_assets')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string)
      expect(body.image_url).toBe('https://example.com/char1.png')
      expect(body.asset_type).toBe('image')
    })

    it('also accepts the alternative {asset_id, status} shape from BytePlus', async () => {
      mockJsonResponses({ body: { asset_id: 'img_asset_002', status: 'Active' } })
      const out = await createDigitalAsset('https://example.com/char2.png')
      expect(out.assetId).toBe('img_asset_002')
      expect(out.status).toBe('Active')
    })

    it('throws a typed ByteplusAssetError with status + body on non-2xx', async () => {
      mockJsonResponses({ ok: false, status: 401, body: { error: { message: 'Unauthorized' } } })
      await expect(createDigitalAsset('https://example.com/x.png'))
        .rejects.toMatchObject({ name: 'ByteplusAssetError', status: 401 })
    })

    it('throws when the response has no id or asset_id field', async () => {
      mockJsonResponses({ body: { status: 'reviewing' } })
      await expect(createDigitalAsset('https://example.com/x.png'))
        .rejects.toThrow(/no id/i)
    })
  })

  describe('registerAndWait', () => {
    it('short-circuits when createDigitalAsset returns Active immediately (no poll)', async () => {
      const fetchSpy = mockJsonResponses({ body: { id: 'asset_quick', status: 'Active' } })
      const out = await registerAndWait('https://example.com/fast.png')
      expect(out).toBe('asset_quick')
      expect(fetchSpy).toHaveBeenCalledTimes(1) // CREATE only, no poll
    })

    it('polls until status flips to Active, then returns the id', async () => {
      vi.useFakeTimers()
      const fetchSpy = mockJsonResponses(
        { body: { id: 'asset_slow', status: 'reviewing' } },         // CREATE
        { body: { id: 'asset_slow', status: 'reviewing' } },         // poll 1
        { body: { id: 'asset_slow', status: 'reviewing' } },         // poll 2
        { body: { id: 'asset_slow', status: 'Active' } },            // poll 3 → done
      )
      const promise = registerAndWait('https://example.com/slow.png')
      // Drain timers — 500ms initial + 2000ms x 2 + final settle.
      await vi.runAllTimersAsync()
      const out = await promise
      expect(out).toBe('asset_slow')
      expect(fetchSpy).toHaveBeenCalledTimes(4)
    })

    it('throws when initial status is failed', async () => {
      mockJsonResponses({ body: { id: 'asset_bad', status: 'rejected' } })
      await expect(registerAndWait('https://example.com/bad.png'))
        .rejects.toThrow(/immediately rejected/i)
    })

    it('throws when a poll returns a terminal failure status', async () => {
      vi.useFakeTimers()
      mockJsonResponses(
        { body: { id: 'asset_late_fail', status: 'reviewing' } },
        { body: { id: 'asset_late_fail', status: 'Failed' } },
      )
      const promise = registerAndWait('https://example.com/late.png')
      // Attach a no-op catch synchronously so the rejection is never
      // unhandled while fake timers drain the polling loop.
      const caught = promise.catch((e) => e as Error)
      await vi.runAllTimersAsync()
      const err = await caught
      expect(err).toBeInstanceOf(Error)
      expect(String(err.message)).toMatch(/rejected on review/i)
    })
  })

  describe('registerCharacterRefs', () => {
    it('separates approved + rejected results across multiple character images', async () => {
      // 2 character refs; one approves immediately, the other 401s on CREATE.
      mockJsonResponses(
        { body: { id: 'asset_ok_1', status: 'Active' } },
        { ok: false, status: 401, body: { error: { message: 'Unauthorized' } } },
      )
      const out = await registerCharacterRefs([
        'https://example.com/char1.png',
        'https://example.com/char2.png',
      ])
      expect(out.approved).toEqual(['asset_ok_1'])
      expect(out.rejected).toHaveLength(1)
      expect(out.rejected[0].imageUrl).toBe('https://example.com/char2.png')
      expect(out.rejected[0].reason).toMatch(/401/)
    })

    it('returns empty approved when all registrations fail', async () => {
      mockJsonResponses(
        { ok: false, status: 500, body: 'server boom' },
        { ok: false, status: 500, body: 'server boom' },
      )
      const out = await registerCharacterRefs([
        'https://example.com/a.png',
        'https://example.com/b.png',
      ])
      expect(out.approved).toHaveLength(0)
      expect(out.rejected).toHaveLength(2)
    })
  })

  it('ByteplusAssetError carries status + body for debugging', () => {
    const err = new ByteplusAssetError('boom', 418, '{"x":1}')
    expect(err.status).toBe(418)
    expect(err.body).toBe('{"x":1}')
    expect(err.name).toBe('ByteplusAssetError')
  })
})
