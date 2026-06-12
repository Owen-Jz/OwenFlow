import { beforeEach, describe, expect, it, vi } from 'vitest'

// clipboardWrite is the handler body for the "clipboard:write" IPC —
// mock electron's clipboard so it runs in plain node.
const writeText = vi.fn()
vi.mock('electron', () => ({
  clipboard: { writeText: (text: string) => writeText(text) }
}))

import { clipboardWrite } from '../src/main/clipboard'

describe('clipboard:write handler', () => {
  beforeEach(() => writeText.mockClear())

  it('writes string payloads to the system clipboard and returns true', () => {
    expect(clipboardWrite('hello <world> & "friends"')).toBe(true)
    expect(writeText).toHaveBeenCalledExactlyOnceWith('hello <world> & "friends"')
  })

  it('accepts the empty string (clears clipboard)', () => {
    expect(clipboardWrite('')).toBe(true)
    expect(writeText).toHaveBeenCalledExactlyOnceWith('')
  })

  it('rejects non-string payloads without touching the clipboard', () => {
    for (const bad of [undefined, null, 42, { text: 'x' }, ['x']]) {
      expect(clipboardWrite(bad)).toBe(false)
    }
    expect(writeText).not.toHaveBeenCalled()
  })
})
