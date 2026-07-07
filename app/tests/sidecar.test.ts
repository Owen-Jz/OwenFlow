import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// sidecar.ts imports electron only for app.getAppPath() (path resolution at
// spawn time) — safe to stub for the transcription-client tests.
vi.mock('electron', () => ({ app: { getAppPath: () => 'C:/nowhere' } }))

import { transcribe, getSidecarStatus } from '../src/main/sidecar'

type FetchCall = { url: string; method: string }

function mockFetch(health: { loaded: boolean; model?: string; device?: string } | null): {
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      calls.push({ url: u, method: init?.method ?? 'GET' })
      if (u.endsWith('/health')) {
        if (!health) throw new Error('ECONNREFUSED')
        return {
          ok: true,
          json: async () => ({ ok: true, model: health.model ?? 'large-v3-turbo', loaded: health.loaded, device: health.device ?? 'cuda' })
        }
      }
      if (u.endsWith('/transcribe')) {
        return {
          ok: true,
          json: async () => ({ text: 'healed text', duration_ms: 42, model: 'large-v3-turbo' })
        }
      }
      throw new Error(`unexpected fetch ${u}`)
    })
  )
  return { calls }
}

describe('sidecar transcribe self-heal', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recovers from a stale not-ready status when a live health probe reports loaded', async () => {
    // Module status starts 'stopped' (equivalent to the stale-'error' case:
    // the model outlived the startup poll window, then finished loading).
    const { calls } = mockFetch({ loaded: true })
    const result = await transcribe(new ArrayBuffer(8))
    expect(result.text).toBe('healed text')
    expect(getSidecarStatus().status).toBe('ready')
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['health', 'transcribe'])
  })

  it('skips the health probe once healed', async () => {
    const { calls } = mockFetch({ loaded: true })
    await transcribe(new ArrayBuffer(8)) // status is 'ready' from the previous heal
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['transcribe'])
  })

})

describe('sidecar transcribe refusal (isolated module)', () => {
  it('throws not-ready when the live probe reports unloaded, without POSTing audio', async () => {
    vi.resetModules()
    const { calls } = mockFetch({ loaded: false })
    const fresh = await import('../src/main/sidecar')
    await expect(fresh.transcribe(new ArrayBuffer(8))).rejects.toThrow(/not ready/i)
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['health'])
    vi.unstubAllGlobals()
  })

  it('throws not-ready when the sidecar port is unreachable', async () => {
    vi.resetModules()
    const { calls } = mockFetch(null)
    const fresh = await import('../src/main/sidecar')
    await expect(fresh.transcribe(new ArrayBuffer(8))).rejects.toThrow(/not ready/i)
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['health'])
    vi.unstubAllGlobals()
  })
})
