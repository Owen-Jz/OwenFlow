import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '../src/main/cleanup'
import type { OwenFlowSettings } from '../src/shared/types'

const settings = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({
  hotkey: 'RightCtrl',
  mode: 'hold',
  model: 'small',
  language: '',
  cleanupEnabled: true,
  minimaxApiKey: 'test-key',
  minimaxGroupId: '',
  dictionary: [],
  launchOnStartup: false,
  ...patch
})

const okResponse = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

describe('cleanup', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('returns cleaned text on success', async () => {
    fetchMock.mockResolvedValue(okResponse('Hello, world.'))
    await expect(cleanup('um hello world', settings())).resolves.toBe('Hello, world.')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
    expect(init.headers.Authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('MiniMax-Text-01')
    expect(body.messages[1].content).toBe('um hello world')
  })

  it('returns raw without fetching when cleanup is disabled', async () => {
    await expect(cleanup('raw text', settings({ cleanupEnabled: false }))).resolves.toBe('raw text')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns raw without fetching when no API key', async () => {
    await expect(cleanup('raw text', settings({ minimaxApiKey: '' }))).resolves.toBe('raw text')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns raw on network error (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(cleanup('raw text', settings())).resolves.toBe('raw text')
  })

  it('returns raw on non-200 response', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }))
    await expect(cleanup('raw text', settings())).resolves.toBe('raw text')
  })

  it('returns raw on empty model reply', async () => {
    fetchMock.mockResolvedValue(okResponse('   '))
    await expect(cleanup('raw text', settings())).resolves.toBe('raw text')
  })

  it('returns raw on malformed response JSON shape', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 }))
    await expect(cleanup('raw text', settings())).resolves.toBe('raw text')
  })

  it('aborts after the 6s timeout and returns raw', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const result = cleanup('raw text', settings())
    await vi.advanceTimersByTimeAsync(6100)
    await expect(result).resolves.toBe('raw text')
  })
})
