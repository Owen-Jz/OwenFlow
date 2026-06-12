import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoTag, generateTags, parseTags } from '../src/main/tagger'
import type { OwenFlowSettings } from '../src/shared/types'

const settings = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({
  hotkey: 'RightCtrl',
  mode: 'hold',
  flowMode: 'normal',
  model: 'small',
  language: 'en',
  cleanupEnabled: true,
  minimaxApiKey: 'key',
  minimaxGroupId: '',
  dictionary: [],
  launchOnStartup: false,
  ...patch
})

function mockMiniMax(content: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] })
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('tagger', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('generateTags returns parsed lowercase tags from the model reply', async () => {
    const fetchMock = mockMiniMax('Fluxboard, Client Email')
    const tags = await generateTags('talked about fluxboard with the client', settings())
    expect(tags).toEqual(['fluxboard', 'client-email'])
    // MiniMax-M2.5 on the chatcompletion_v2 endpoint, like cleanup.ts
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
    expect(JSON.parse(init.body as string).model).toBe('MiniMax-M2.5')
  })

  it('returns [] without calling fetch when no API key is set', async () => {
    const fetchMock = mockMiniMax('whatever')
    expect(await generateTags('hello', settings({ minimaxApiKey: '' }))).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('silently returns [] on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    expect(await generateTags('hello world', settings())).toEqual([])
  })

  it('silently returns [] on non-200 / empty replies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })))
    expect(await generateTags('hello world', settings())).toEqual([])

    mockMiniMax('   ')
    expect(await generateTags('hello world', settings())).toEqual([])
  })

  it('autoTag applies tags to the entry on success (fire-and-forget)', async () => {
    mockMiniMax('vibe-prompt')
    const apply = vi.fn()
    autoTag(123, 'rebuild the kanban board', settings(), apply)
    await flush()
    expect(apply).toHaveBeenCalledWith(123, ['vibe-prompt'])
  })

  it('autoTag never applies or throws when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      })
    )
    const apply = vi.fn()
    expect(() => autoTag(123, 'hello', settings(), apply)).not.toThrow()
    await flush()
    expect(apply).not.toHaveBeenCalled()
  })

  it('parseTags caps at 2 kebab-case tags and strips junk', () => {
    expect(parseTags('  "Client Email!" , fluxboard\nthird-tag ')).toEqual([
      'client-email',
      'fluxboard'
    ])
    expect(parseTags('')).toEqual([])
  })
})
