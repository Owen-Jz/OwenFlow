import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingEntry, OwenFlowSettings } from '../src/shared/types'

// Provider plumbing is cleanup.ts's chatOnce — mock it so these tests drive
// pure map-reduce orchestration (no fetch, no keys).
vi.mock('../src/main/cleanup', () => ({
  chatOnce: vi.fn()
}))

import { chatOnce } from '../src/main/cleanup'
import { BLOCK_WORDS, chunkEntries, summarizeMeeting } from '../src/main/meeting-summary'

const chatOnceMock = vi.mocked(chatOnce)

const settings = {} as OwenFlowSettings

/** An entry with exactly `words` words. */
const entryOf = (words: number, speaker: 'you' | 'them' = 'you'): MeetingEntry => ({
  t: 1,
  speaker,
  text: Array.from({ length: words }, (_, i) => `w${i}`).join(' ')
})

beforeEach(() => {
  chatOnceMock.mockReset()
})

describe('chunkEntries (map-phase chunking math)', () => {
  it('empty transcript yields no blocks', () => {
    expect(chunkEntries([])).toEqual([])
  })

  it('everything under the budget stays one block', () => {
    const entries = [entryOf(3), entryOf(2)]
    expect(chunkEntries(entries, 5)).toEqual([entries]) // 3+2 fits exactly
  })

  it('cuts a new block when the next entry would overflow the budget', () => {
    const a = entryOf(3)
    const b = entryOf(3)
    expect(chunkEntries([a, b], 5)).toEqual([[a], [b]])
  })

  it('entries never split — consecutive grouping preserves order', () => {
    const entries = [entryOf(2), entryOf(2), entryOf(2), entryOf(2)]
    const blocks = chunkEntries(entries, 4)
    expect(blocks).toEqual([
      [entries[0], entries[1]],
      [entries[2], entries[3]]
    ])
    expect(blocks.flat()).toEqual(entries)
  })

  it('a single entry longer than the budget still forms its own block (no infinite loop)', () => {
    const big = entryOf(10)
    const small = entryOf(2)
    expect(chunkEntries([big, small], 5)).toEqual([[big], [small]])
  })

  it('the real budget is ~2500 words: a 3h transcript chunks into many blocks', () => {
    // 30k words in 100-word utterances → 12 full blocks of 25 entries.
    const entries = Array.from({ length: 300 }, () => entryOf(100))
    const blocks = chunkEntries(entries)
    expect(blocks).toHaveLength(Math.ceil(30_000 / BLOCK_WORDS))
    expect(blocks[0]).toHaveLength(BLOCK_WORDS / 100)
  })
})

describe('summarizeMeeting', () => {
  it('empty transcript returns "" without any LLM call', async () => {
    await expect(summarizeMeeting([], settings)).resolves.toBe('')
    expect(chatOnceMock).not.toHaveBeenCalled()
  })

  it('single block skips the map pass — one flagship call on the raw transcript', async () => {
    chatOnceMock.mockResolvedValue('the summary')
    const entries: MeetingEntry[] = [
      { t: 1, speaker: 'you', text: 'shall we ship it' },
      { t: 2, speaker: 'them', text: 'yes on friday' }
    ]
    await expect(summarizeMeeting(entries, settings)).resolves.toBe('the summary')
    expect(chatOnceMock).toHaveBeenCalledTimes(1)
    const [, tier, , user] = chatOnceMock.mock.calls[0]
    expect(tier).toBe('flagship')
    // raw transcript with speaker labels, not bullets
    expect(user).toBe('You: shall we ship it\nThem: yes on friday')
  })

  it('multi-block runs map (fast per block) then reduce (flagship once)', async () => {
    chatOnceMock.mockImplementation(async (_s, tier) =>
      tier === 'fast' ? '- a bullet' : 'final synthesis'
    )
    // 3 blocks of one oversized entry each
    const entries = [entryOf(3000), entryOf(3000, 'them'), entryOf(3000)]
    await expect(summarizeMeeting(entries, settings)).resolves.toBe('final synthesis')
    expect(chatOnceMock).toHaveBeenCalledTimes(4) // 3 map + 1 reduce
    const tiers = chatOnceMock.mock.calls.map((c) => c[1])
    expect(tiers).toEqual(['fast', 'fast', 'fast', 'flagship'])
    // the reduce sees labeled block bullets, in order
    const reduceUser = chatOnceMock.mock.calls[3][3]
    expect(reduceUser).toContain('Block 1 of 3:')
    expect(reduceUser).toContain('Block 3 of 3:')
  })

  it('a failed map block is skipped, not fatal', async () => {
    let mapCall = 0
    chatOnceMock.mockImplementation(async (_s, tier) => {
      if (tier === 'fast') return ++mapCall === 2 ? '' : `- bullet ${mapCall}`
      return 'synthesis'
    })
    const entries = [entryOf(3000), entryOf(3000), entryOf(3000)]
    await expect(summarizeMeeting(entries, settings)).resolves.toBe('synthesis')
    const reduceUser = chatOnceMock.mock.calls[3][3]
    expect(reduceUser).toContain('Block 1 of 3:')
    expect(reduceUser).not.toContain('Block 2 of 3:')
  })

  it('returns "" when every map call fails (nothing to reduce)', async () => {
    chatOnceMock.mockResolvedValue('')
    const entries = [entryOf(3000), entryOf(3000)]
    await expect(summarizeMeeting(entries, settings)).resolves.toBe('')
    // reduce never ran on empty material
    expect(chatOnceMock.mock.calls.every((c) => c[1] === 'fast')).toBe(true)
  })

  it('returns "" when the reduce call fails — never throws', async () => {
    chatOnceMock.mockImplementation(async (_s, tier) => (tier === 'fast' ? '- b' : ''))
    const entries = [entryOf(3000), entryOf(3000)]
    await expect(summarizeMeeting(entries, settings)).resolves.toBe('')
  })
})
