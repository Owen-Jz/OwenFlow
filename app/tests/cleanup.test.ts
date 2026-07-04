import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { benchmarkProvider, benchmarkProviders, cleanup, runCommand, summarize } from '../src/main/cleanup'
import type { OwenFlowSettings } from '../src/shared/types'

const settings = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({
  hotkey: 'RightCtrl',
  mode: 'hold',
  flowMode: 'normal',
  model: 'small',
  language: '',
  cleanupEnabled: true,
  cleanupIntensity: 'medium',
  cleanupProvider: 'minimax',
  minimaxApiKey: 'test-key',
  minimaxGroupId: '',
  groqApiKey: 'groq-key',
  groqModel: 'llama-3.3-70b-versatile',
  groqModelFast: 'llama-3.1-8b-instant',
  dictionary: [],
  snippets: [],
  translateTarget: 'English',
  sessionTones: [],
  activeSession: '',
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

    it('normal mode is a Wispr-style auto-edit: fillers, self-corrections, dictated punctuation, formatting', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'normal' }))
      expect(systemPrompt()).toContain('Remove filler words')
      expect(systemPrompt()).toContain('self-corrections')
      expect(systemPrompt()).toContain('homophone')
      expect(systemPrompt()).toContain('"new line"')
      expect(systemPrompt()).toContain('john.smith@gmail.com')
      expect(systemPrompt()).toContain('25%')
    })

    it('normal mode preserves voice and never adds/answers/summarizes (cleanup, not rewriting)', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'normal' }))
      expect(systemPrompt()).toContain('cleanup, not rewriting')
      expect(systemPrompt()).toContain("speaker's voice")
      expect(systemPrompt()).toContain('do not formalize casual speech')
      expect(systemPrompt()).toContain('Never add, answer, or summarize')
    })

    it('vibe mode targets an AI coding agent with objective + bullets structure', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'vibe' }))
      expect(systemPrompt()).toContain('AI coding agent')
      expect(systemPrompt()).toContain('single-sentence objective')
      expect(systemPrompt()).toContain('"- " bullets')
      expect(systemPrompt()).toContain('Imperative voice')
    })

    it('vibe mode preserves technical tokens (file paths etc.) and resolves self-corrections', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'vibe' }))
      expect(systemPrompt()).toContain('technical token')
      expect(systemPrompt()).toContain('file paths')
      expect(systemPrompt()).toContain('error messages')
      expect(systemPrompt()).toContain('self-corrections')
      expect(systemPrompt()).toContain('NEVER invent')
    })

    it('vibe mode ends with expected behavior when stated, keeps uncertainty open, plain text only', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'vibe' }))
      expect(systemPrompt()).toContain('Expected behavior:')
      expect(systemPrompt()).toContain('keep the decision open')
      expect(systemPrompt()).toContain('no markdown code fences')
    })

    it('formal mode uses the client-message prompt without invented commitments', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ flowMode: 'formal' }))
      expect(systemPrompt()).toContain('client')
      expect(systemPrompt()).toContain('professional')
      expect(systemPrompt()).toContain('commitment')
      expect(systemPrompt()).toContain('not stiff corporate-speak')
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

  describe('auto cleanup intensity (normal mode)', () => {
    const systemPrompt = (): string =>
      JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content

    it('none skips the LLM entirely — raw verbatim, no fetch', async () => {
      await expect(cleanup(RAW, settings({ cleanupIntensity: 'none' }))).resolves.toBe(RAW)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('light prompt only strips fillers + basic punctuation — no self-correction resolution, no reformatting', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ cleanupIntensity: 'light' }))
      expect(systemPrompt()).toContain('ONLY remove filler words')
      expect(systemPrompt()).toContain('basic punctuation and sentence casing')
      expect(systemPrompt()).toContain('Keep every word as spoken')
      expect(systemPrompt()).toContain('do not resolve self-corrections')
      expect(systemPrompt()).toContain('do not reformat numbers, emails, or URLs')
      // None of the medium auto-edit machinery leaks into light.
      expect(systemPrompt()).not.toContain('john.smith@gmail.com')
      expect(systemPrompt()).not.toContain('"new line"')
      expect(systemPrompt()).not.toContain('keep only the final version')
    })

    it('medium uses the full Wispr-style auto-edit prompt without high-only rules', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ cleanupIntensity: 'medium' }))
      expect(systemPrompt()).toContain('Remove filler words')
      expect(systemPrompt()).toContain('self-corrections')
      expect(systemPrompt()).toContain('john.smith@gmail.com')
      expect(systemPrompt()).not.toContain('run-on')
      expect(systemPrompt()).not.toContain('bullet list')
      expect(systemPrompt()).not.toContain('grammar')
    })

    it('high prompt = medium + run-on restructuring, list formatting and grammar fixes', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ cleanupIntensity: 'high' }))
      // Everything medium does…
      expect(systemPrompt()).toContain('Remove filler words')
      expect(systemPrompt()).toContain('self-corrections')
      expect(systemPrompt()).toContain('john.smith@gmail.com')
      // …plus the high-only readability rules…
      expect(systemPrompt()).toContain('Restructure run-on sentences')
      expect(systemPrompt()).toContain('"- " bullet list')
      expect(systemPrompt()).toContain('numbered list')
      expect(systemPrompt()).toContain('Fix grammar')
      // …with the guard rails intact.
      expect(systemPrompt()).toContain("PRESERVE the speaker's voice")
      expect(systemPrompt()).toContain('Never add, answer, or summarize')
    })

    it('missing cleanupIntensity (legacy settings object) falls back to medium', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ cleanupIntensity: undefined }))
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(systemPrompt()).toContain('john.smith@gmail.com')
      expect(systemPrompt()).not.toContain('run-on')
    })

    it('legacy cleanupEnabled=false is honored as none even with a higher intensity set', async () => {
      await expect(
        cleanup(RAW, settings({ cleanupEnabled: false, cleanupIntensity: 'high' }))
      ).resolves.toBe(RAW)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('the ≤3-word skip still applies at light and high', async () => {
      await expect(cleanup('send it now', settings({ cleanupIntensity: 'light' }))).resolves.toBe(
        'send it now'
      )
      await expect(cleanup('send it now', settings({ cleanupIntensity: 'high' }))).resolves.toBe(
        'send it now'
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('vibe/formal/translate are modes, not cleanup — they ignore intensity none', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      for (const flowMode of ['vibe', 'formal', 'translate'] as const) {
        await cleanup(RAW, settings({ flowMode, cleanupIntensity: 'none' }))
      }
      expect(fetchMock).toHaveBeenCalledTimes(3)
      // And their prompts are the mode prompts, not a normal-intensity variant.
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toContain(
        'AI coding agent'
      )
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
      await expect(
        cleanup(RAW, settings({ flowMode, minimaxApiKey: '', groqApiKey: '' }))
      ).resolves.toBe(RAW)
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

  describe('provider selection', () => {
    it('groq provider hits the Groq endpoint with the groq key (normal mode → fast model)', async () => {
      fetchMock.mockResolvedValue(okResponse('Cleaned.'))
      await cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
      expect(init.headers.Authorization).toBe('Bearer gk')
      expect(JSON.parse(init.body).model).toBe('llama-3.1-8b-instant')
    })

    it('groq uses the configured groqModel when set (vibe = flagship path)', async () => {
      fetchMock.mockResolvedValue(okResponse('Cleaned.'))
      await cleanup(
        RAW,
        settings({ flowMode: 'vibe', cleanupProvider: 'groq', groqModel: 'llama-3.1-8b-instant' })
      )
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('llama-3.1-8b-instant')
    })

    it('groq falls back to the default flagship model when groqModel is empty', async () => {
      fetchMock.mockResolvedValue(okResponse('Cleaned.'))
      await cleanup(RAW, settings({ flowMode: 'vibe', cleanupProvider: 'groq', groqModel: '' }))
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('llama-3.3-70b-versatile')
    })

    // Key auto-fallback: a configured-but-idle key on the OTHER provider beats
    // silently pasting raw. (Owen hit this live: Groq became the default
    // provider but only his MiniMax key was saved → vibe mode never ran.)
    it('falls back to minimax when groq is selected but only minimax has a key', async () => {
      fetchMock.mockResolvedValue(okResponse('Cleaned.'))
      await expect(
        cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: '' }))
      ).resolves.toBe('Cleaned.')
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
      expect(init.headers.Authorization).toBe('Bearer test-key')
      expect(JSON.parse(init.body).model).toBe('MiniMax-M2.5')
    })

    it('falls back to groq when minimax is selected but only groq has a key', async () => {
      fetchMock.mockResolvedValue(okResponse('Cleaned.'))
      await expect(
        cleanup(RAW, settings({ cleanupProvider: 'minimax', minimaxApiKey: '' }))
      ).resolves.toBe('Cleaned.')
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
      expect(init.headers.Authorization).toBe('Bearer groq-key')
    })

    it('returns raw without fetching when NEITHER provider has a key', async () => {
      await expect(
        cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: '', minimaxApiKey: '' }))
      ).resolves.toBe(RAW)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('vibe mode also rides the key fallback (the mode that exposed the bug)', async () => {
      fetchMock.mockResolvedValue(okResponse('Add a retry to the sidecar restart logic.'))
      await expect(
        cleanup('so um add a retry thing', settings({ flowMode: 'vibe', cleanupProvider: 'groq', groqApiKey: '' }))
      ).resolves.toBe('Add a retry to the sidecar restart logic.')
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
    })

    it('minimax provider still hits the MiniMax endpoint with the minimax key', async () => {
      fetchMock.mockResolvedValue(okResponse('Cleaned.'))
      await cleanup(RAW, settings({ cleanupProvider: 'minimax' }))
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
      expect(init.headers.Authorization).toBe('Bearer test-key')
      expect(JSON.parse(init.body).model).toBe('MiniMax-M2.5')
    })
  })

  // Benchmark 2026-07-04: 8b-instant does normal cleanup at ~330ms with 70b
  // quality; structural rewrites + command edits keep the 70b's reasoning.
  describe('groq model routing (fast vs flagship)', () => {
    const groq = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings =>
      settings({
        cleanupProvider: 'groq',
        groqModel: 'llama-3.3-70b-versatile',
        groqModelFast: 'llama-3.1-8b-instant',
        ...patch
      })
    const sentModel = (): string => JSON.parse(fetchMock.mock.calls[0][1].body).model

    it('normal-mode cleanup uses groqModelFast', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, groq({ flowMode: 'normal' }))
      expect(sentModel()).toBe('llama-3.1-8b-instant')
    })

    it('vibe, formal and translate use the flagship groqModel', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      for (const flowMode of ['vibe', 'formal', 'translate'] as const) {
        fetchMock.mockClear()
        await cleanup(RAW, groq({ flowMode }))
        expect(sentModel()).toBe('llama-3.3-70b-versatile')
      }
    })

    it('summarize (digest theme line) uses groqModelFast', async () => {
      fetchMock.mockResolvedValue(okResponse('themes'))
      await summarize('a\nb', groq())
      expect(sentModel()).toBe('llama-3.1-8b-instant')
    })

    it('runCommand (arbitrary edit instructions) uses the flagship groqModel', async () => {
      fetchMock.mockResolvedValue(okResponse('edited'))
      await runCommand('make it a list', 'one two', groq())
      expect(sentModel()).toBe('llama-3.3-70b-versatile')
    })

    it('benchmarkProvider times the flagship groqModel', async () => {
      fetchMock.mockResolvedValue(okResponse('done'))
      await benchmarkProvider('groq', groq())
      expect(sentModel()).toBe('llama-3.3-70b-versatile')
    })

    it('empty groqModelFast falls back to the built-in fast default', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, groq({ flowMode: 'normal', groqModelFast: '' }))
      expect(sentModel()).toBe('llama-3.1-8b-instant')
    })

    it('fast tier falling back to minimax still uses the single MiniMax model', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, groq({ flowMode: 'normal', groqApiKey: '' }))
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
      expect(sentModel()).toBe('MiniMax-M2.5')
    })

    it('minimax provider ignores the tier entirely (single model)', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup(RAW, settings({ cleanupProvider: 'minimax', flowMode: 'normal' }))
      expect(sentModel()).toBe('MiniMax-M2.5')
    })
  })

  describe('benchmarkProvider', () => {
    it('returns ok timing for a provider with a key', async () => {
      fetchMock.mockResolvedValue(okResponse('done'))
      const r = await benchmarkProvider('groq', settings({ groqApiKey: 'gk' }))
      expect(r.provider).toBe('groq')
      expect(r.ok).toBe(true)
      expect(typeof r.ms).toBe('number')
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
      expect(init.headers.Authorization).toBe('Bearer gk')
    })

    it('forces the requested provider regardless of cleanupProvider setting', async () => {
      fetchMock.mockResolvedValue(okResponse('done'))
      await benchmarkProvider('minimax', settings({ cleanupProvider: 'groq' }))
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
    })

    it('returns ok:false with "no API key" when the provider key is missing (no fetch)', async () => {
      const r = await benchmarkProvider('groq', settings({ groqApiKey: '' }))
      expect(r.ok).toBe(false)
      expect(r.error).toBe('no API key')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns ok:false on non-200 (never throws)', async () => {
      fetchMock.mockResolvedValue(new Response('nope', { status: 429 }))
      const r = await benchmarkProvider('groq', settings({ groqApiKey: 'gk' }))
      expect(r.ok).toBe(false)
      expect(r.error).toContain('429')
    })
  })

  describe('benchmarkProviders', () => {
    it('times both providers', async () => {
      fetchMock.mockResolvedValue(okResponse('done'))
      const results = await benchmarkProviders(settings({ groqApiKey: 'gk', minimaxApiKey: 'mk' }))
      expect(results.map((r) => r.provider).sort()).toEqual(['groq', 'minimax'])
      expect(results.every((r) => r.ok)).toBe(true)
    })
  })

  describe('extraSystem argument', () => {
    it('appends extraSystem to the system prompt when provided', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup('um hello there world', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }), 'TERMINAL RULE')
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toContain('TERMINAL RULE')
    })

    it('omitting extraSystem leaves the system prompt unchanged', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup('um hello there world', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))
      const content = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content
      expect(content).not.toContain('TERMINAL RULE')
    })
  })

  describe('translate mode', () => {
    it('builds a translate prompt with the configured target and routes to the provider', async () => {
      fetchMock.mockResolvedValue(okResponse('Hola mundo'))
      await cleanup('hello world', settings({ flowMode: 'translate', translateTarget: 'Spanish', cleanupProvider: 'groq', groqApiKey: 'gk' }))
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.messages[0].content).toContain('Spanish')
      expect(body.messages[0].content.toLowerCase()).toContain('translate')
      expect(body.messages[0].content).toContain('native phrasing')
      expect(body.messages[0].content).toContain('technical terms')
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions')
    })
    it('defaults the target to English when translateTarget is empty', async () => {
      fetchMock.mockResolvedValue(okResponse('x'))
      await cleanup('hola', settings({ flowMode: 'translate', translateTarget: '', cleanupProvider: 'groq', groqApiKey: 'gk' }))
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toContain('English')
    })
    it('translates even a short transcript (no <=3-word skip)', async () => {
      fetchMock.mockResolvedValue(okResponse('Hola'))
      await cleanup('hello', settings({ flowMode: 'translate', cleanupProvider: 'groq', groqApiKey: 'gk' }))
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  describe('summarize', () => {
    it('posts a summary prompt and returns the model text', async () => {
      fetchMock.mockResolvedValue(okResponse('Themes: code, email.'))
      const out = await summarize('a\nb\nc', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))
      expect(out).toBe('Themes: code, email.')
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content.toLowerCase()).toContain('summ')
    })
    it('returns empty string when neither provider has a key', async () => {
      expect(
        await summarize('x', settings({ cleanupProvider: 'groq', groqApiKey: '', minimaxApiKey: '' }))
      ).toBe('')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('runCommand', () => {
    it('sends instruction + target text to the provider', async () => {
      fetchMock.mockResolvedValue(okResponse('- one\n- two'))
      const out = await runCommand('make a bullet list', 'one two', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))
      expect(out).toBe('- one\n- two')
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.messages[1].content).toContain('one two')
      expect(body.messages[1].content.toLowerCase()).toContain('make a bullet list')
    })
    it('works with no target (generation)', async () => {
      fetchMock.mockResolvedValue(okResponse('haiku here'))
      expect(await runCommand('write a haiku', '', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))).toBe('haiku here')
    })
    it('returns empty string when neither provider has a key', async () => {
      expect(
        await runCommand('x', 'y', settings({ groqApiKey: '', minimaxApiKey: '', cleanupProvider: 'groq' }))
      ).toBe('')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
