import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendZealCommand } from '../src/main/zeal'
import type { OwenFlowSettings } from '../src/shared/types'

const settings = (p: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({ zealEndpoint: 'https://x/api/voice', zealApiKey: 'k', ...({} as OwenFlowSettings), ...p })

describe('sendZealCommand', () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts the message with the x-voice-key header and returns the reply', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, reply: 'done', actions: [] }), { status: 200 }))
    const r = await sendZealCommand('launch a mission', settings())
    expect(r.ok).toBe(true)
    expect(r.reply).toBe('done')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://x/api/voice')
    expect(init.headers['x-voice-key']).toBe('k')
    expect(JSON.parse(init.body).message).toBe('launch a mission')
  })
  it('returns ok:false with an error on non-200', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }))
    const r = await sendZealCommand('x', settings())
    expect(r.ok).toBe(false)
    expect(r.error).toContain('401')
  })
  it('returns ok:false when no endpoint/key configured (no fetch)', async () => {
    const r = await sendZealCommand('x', settings({ zealApiKey: '' }))
    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('never throws on network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await sendZealCommand('x', settings())
    expect(r.ok).toBe(false)
  })
})
