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
  theme: 'dark',
  ...patch
})

// Normal mode skips the LLM for ≤3-word transcripts, so normal-mode inputs
// here must be 4+ words to exercise the API path.
const RAW = 'um so raw text here'

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
    fetchMock.mockResolvedValue(okResponse('Hello there, world.'))
    await expect(cleanup('um hello there uh world', settings())).resolves.toBe(
      'Hello there, world.'
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
    expect(init.headers.Authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('MiniMax-M2.5')
    expect(body.messages[1].content).toBe('um hello there uh world')
    // Latency tuning (measured 2026-06-12): deterministic + capped reasoning.
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBe(1500)
  })

  describe('per-mode system prompts', () => {
    const systemPrompt = (): string =>
      JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content

    it('normal mode asks for filler removal AND sentence restructuring, staying faithful', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'normal' }))
      expect(systemPrompt()).toContain('remove filler words')
      expect(systemPrompt()).toContain('restructure into well-formed sentences')
      expect(systemPrompt()).toContain('faithful to what was said')
      expect(systemPrompt()).not.toContain('verbatim')
    })

    it('vibe mode uses the AI-coding-prompt rewrite prompt', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'vibe' }))
      expect(systemPrompt()).toContain('AI coding assistant')
      expect(systemPrompt()).toContain('Preserve EVERY technical specific')
      expect(systemPrompt()).toContain('no markdown code fences')
    })

    it('formal mode uses the client-message prompt', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'formal' }))
      expect(systemPrompt()).toContain('client')
      expect(systemPrompt()).toContain('professional')
    })
  })

  describe('short-transcript skip (normal mode only)', () => {
    it('normal mode returns raw without fetching for a 3-word transcript', async () => {
      await expect(cleanup('send it now', settings())).resolves.toBe('send it now')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('normal mode skips on a 1-word transcript (whitespace-tolerant)', async () => {
      await expect(cleanup('  yes  ', settings())).resolves.toBe('  yes  ')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('normal mode calls the API for a 4-word transcript', async () => {
      fetchMock.mockResolvedValue(okResponse('Send it right now.'))
      await expect(cleanup('send it right now', settings())).resolves.toBe('Send it right now.')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('vibe mode still calls the API for a short transcript', async () => {
      fetchMock.mockResolvedValue(okResponse('Fix the bug.'))
      await expect(cleanup('fix the bug', settings({ flowMode: 'vibe' }))).resolves.toBe(
        'Fix the bug.'
      )
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('formal mode still calls the API for a short transcript', async () => {
      fetchMock.mockResolvedValue(okResponse('On my way.'))
      await expect(cleanup('on my way', settings({ flowMode: 'formal' }))).resolves.toBe(
        'On my way.'
      )
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  describe('cleanupEnabled gating', () => {
    it('normal mode returns raw without fetching when cleanup is disabled', async () => {
      await expect(
        cleanup(RAW, settings({ flowMode: 'normal', cleanupEnabled: false }))
      ).resolves.toBe(RAW)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('vibe mode calls the API even when cleanupEnabled is false', async () => {
      fetchMock.mockResolvedValue(okResponse('Refined prompt.'))
      await expect(
        cleanup(RAW, settings({ flowMode: 'vibe', cleanupEnabled: false }))
      ).resolves.toBe('Refined prompt.')
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('formal mode calls the API even when cleanupEnabled is false', async () => {
      fetchMock.mockResolvedValue(okResponse('Dear client.'))
      await expect(
        cleanup(RAW, settings({ flowMode: 'formal', cleanupEnabled: false }))
      ).resolves.toBe('Dear client.')
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  it('returns raw without fetching when no API key (all modes)', async () => {
    for (const flowMode of ['normal', 'vibe', 'formal'] as const) {
      await expect(cleanup(RAW, settings({ flowMode, minimaxApiKey: '' }))).resolves.toBe(RAW)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns raw on network error (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(cleanup(RAW, settings())).resolves.toBe(RAW)
  })

  it('vibe mode returns raw on network error (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(cleanup(RAW, settings({ flowMode: 'vibe' }))).resolves.toBe(RAW)
  })

  it('formal mode returns raw on non-200 response', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }))
    await expect(cleanup(RAW, settings({ flowMode: 'formal' }))).resolves.toBe(RAW)
  })

  it('returns raw on non-200 response', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }))
    await expect(cleanup(RAW, settings())).resolves.toBe(RAW)
  })

  it('returns raw on empty model reply', async () => {
    fetchMock.mockResolvedValue(okResponse('   '))
    await expect(cleanup(RAW, settings())).resolves.toBe(RAW)
  })

  it('returns raw on malformed response JSON shape', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 }))
    await expect(cleanup(RAW, settings())).resolves.toBe(RAW)
  })

  const hangingFetch = (): void => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
  }

  it('normal mode aborts after the 15s timeout and returns raw (still pending at 12s)', async () => {
    vi.useFakeTimers()
    hangingFetch()
    let settled = false
    const result = cleanup(RAW, settings()).then((text) => {
      settled = true
      return text
    })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(3_100)
    await expect(result).resolves.toBe(RAW)
    expect(settled).toBe(true)
  })

  it('vibe mode aborts after the 15s timeout and returns raw (still pending at 12s)', async () => {
    vi.useFakeTimers()
    hangingFetch()
    let settled = false
    const result = cleanup(RAW, settings({ flowMode: 'vibe' })).then((text) => {
      settled = true
      return text
    })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(3_100)
    await expect(result).resolves.toBe(RAW)
    expect(settled).toBe(true)
  })
})
