import { describe, expect, it } from 'vitest'
import { PrerollBuffer } from '../src/renderer/src/preroll'

/** Build a chunk filled with `value` so ordering is observable after drain. */
function chunk(length: number, value: number): Float32Array {
  return new Float32Array(length).fill(value)
}

describe('PrerollBuffer', () => {
  it('starts empty and drains to an empty list', () => {
    const buf = new PrerollBuffer(5600)
    expect(buf.size).toBe(0)
    expect(buf.drain()).toEqual([])
  })

  it('accumulates chunks below capacity without eviction', () => {
    const buf = new PrerollBuffer(5600)
    buf.push(chunk(4096, 1))
    expect(buf.size).toBe(4096)
    const out = buf.drain()
    expect(out).toHaveLength(1)
    expect(out[0][0]).toBe(1)
  })

  it('keeps a chunk that straddles capacity (never under-buffers)', () => {
    // 2×4096 = 8192 total; evicting the oldest would leave 4096 < 5600, so
    // both must be kept — extra leading audio beats a clipped first word.
    const buf = new PrerollBuffer(5600)
    buf.push(chunk(4096, 1))
    buf.push(chunk(4096, 2))
    expect(buf.size).toBe(8192)
  })

  it('evicts oldest chunks once the remainder still covers capacity', () => {
    const buf = new PrerollBuffer(5600)
    buf.push(chunk(4096, 1))
    buf.push(chunk(4096, 2))
    buf.push(chunk(4096, 3)) // 12288 total; dropping chunk 1 leaves 8192 >= 5600
    expect(buf.size).toBe(8192)
    const out = buf.drain()
    expect(out.map((c) => c[0])).toEqual([2, 3])
  })

  it('drains oldest-first and resets', () => {
    const buf = new PrerollBuffer(10000)
    buf.push(chunk(100, 1))
    buf.push(chunk(100, 2))
    const out = buf.drain()
    expect(out.map((c) => c[0])).toEqual([1, 2])
    expect(buf.size).toBe(0)
    expect(buf.drain()).toEqual([])
  })

  it('stays bounded under a long idle stream (ring behavior)', () => {
    const buf = new PrerollBuffer(5600)
    for (let i = 0; i < 1000; i++) buf.push(chunk(4096, i))
    // Bounded: at most capacity + one extra chunk, never the whole stream.
    expect(buf.size).toBeLessThanOrEqual(5600 + 4096)
    // And the surviving audio is the most recent.
    const out = buf.drain()
    expect(out[out.length - 1][0]).toBe(999)
  })

  it('ignores empty chunks', () => {
    const buf = new PrerollBuffer(5600)
    buf.push(new Float32Array(0))
    expect(buf.size).toBe(0)
    expect(buf.drain()).toEqual([])
  })

  it('clear() discards everything', () => {
    const buf = new PrerollBuffer(5600)
    buf.push(chunk(4096, 1))
    buf.clear()
    expect(buf.size).toBe(0)
    expect(buf.drain()).toEqual([])
  })

  it('keeps a single over-capacity chunk intact', () => {
    // A chunk larger than the whole capacity must not be evicted the moment
    // it lands — it IS the pre-roll.
    const buf = new PrerollBuffer(1000)
    buf.push(chunk(4096, 7))
    expect(buf.size).toBe(4096)
    buf.push(chunk(4096, 8))
    // Now the newer chunk alone covers capacity, so the older one goes.
    const out = buf.drain()
    expect(out.map((c) => c[0])).toEqual([8])
  })
})
