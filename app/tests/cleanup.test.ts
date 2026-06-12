import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '../src/main/cleanup'
import type { OwenFlowSettings } from '../src/shared/types'

const settings = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({
  hotkey: 'RightCtrl',
  mode: 'hold',
  flowMode: 'normal',
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

  it('returns cleaned text on success (normal mode)', async () => {
    fetchMock.mockResolvedValue(okResponse('Hello, world.'))
    await expect(cleanup('um hello world', settings())).resolves.toBe('Hello, world.')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
    expect(init.headers.Authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('MiniMax-M2.5')
    expect(body.messages[1].content).toBe('um hello world')
  })

  describe('per-mode system prompts', () => {
    const systemPrompt = (): string =>
      JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content

    it('normal mode uses the verbatim-cleanup prompt', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup('raw', settings({ flowMode: 'normal' }))
      expect(systemPrompt()).toContain('clean up raw speech-to-text dictation')
      expect(systemPrompt()).toContain('verbatim')
    })

    it('vibe mode uses the AI-coding-prompt rewrite prompt', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup('raw', settings({ flowMode: 'vibe' }))
      expect(systemPrompt()).toContain('AI coding assistant')
      expect(systemPrompt()).toContain('Preserve ALL technical specifics')
      expect(systemPrompt()).toContain('no markdown code fences')
    })

    it('formal mode uses the client-message prompt', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup('raw', settings({ flowMode: 'formal' }))
      expect(systemPrompt()).toContain('client')
      expect(systemPrompt()).toContain('professional')
    })
  })

  describe('cleanupEnabled gating', () => {
    it('normal mode returns raw without fetching when cleanup is disabled', async () => {
      await expect(
        cleanup('raw text', settings({ flowMode: 'normal', cleanupEnabled: false }))
      ).resolves.toBe('raw text')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('vibe mode calls the API even when cleanupEnabled is false', async () => {
      fetchMock.mockResolvedValue(okResponse('Refined prompt.'))
      await expect(
        cleanup('raw text', settings({ flowMode: 'vibe', cleanupEnabled: false }))
      ).resolves.toBe('Refined prompt.')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('formal mode calls the API even when cleanupEnabled is false', async () => {
      fetchMock.mockResolvedValue(okResponse('Dear client.'))
      await expect(
        cleanup('raw text', settings({ flowMode: 'formal', cleanupEnabled: false }))
      ).resolves.toBe('Dear client.')
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  it('returns raw without fetching when no API key (all modes)', async () => {
    for (const flowMode of ['normal', 'vibe', 'formal'] as const) {
      await expect(
        cleanup('raw text', settings({ flowMode, minimaxApiKey: '' }))
      ).resolves.toBe('raw text')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns raw on network error (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(cleanup('raw text', settings())).resolves.toBe('raw text')
  })

  it('vibe mode returns raw on network error (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(cleanup('raw text', settings({ flowMode: 'vibe' }))).resolves.toBe('raw text')
  })

  it('formal mode returns raw on non-200 response', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }))
    await expect(cleanup('raw text', settings({ flowMode: 'formal' }))).resolves.toBe('raw text')
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

  const hangingFetch = (): void => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
  }

  it('normal mode aborts after the 6s timeout and returns raw', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const result = cleanup('raw text', settings())
    await vi.advanceTimersByTimeAsync(6100)
    await expect(result).resolves.toBe('raw text')
  })

  it('vibe mode gets the longer 12s timeout (still pending at 6s, raw at 12s)', async () => {
    vi.useFakeTimers()
    hangingFetch()
    let settled = false
    const result = cleanup('raw text', settings({ flowMode: 'vibe' })).then((text) => {
      settled = true
      return text
    })
    await vi.advanceTimersByTimeAsync(6100)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(6100)
    await expect(result).resolves.toBe('raw text')
    expect(settled).toBe(true)
  })
})
