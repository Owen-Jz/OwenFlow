import { describe, expect, it } from 'vitest'
import { parseUiaReply } from '../src/main/uia'

describe('parseUiaReply', () => {
  it('decodes an OK base64 JSON payload', () => {
    const payload = Buffer.from(JSON.stringify({ field: 'Hello there', url: 'https://github.com/x' })).toString('base64')
    expect(parseUiaReply(`OK ${payload}`)).toEqual({ field: 'Hello there', url: 'https://github.com/x' })
  })
  it('returns empties for ERR / garbage / missing fields', () => {
    expect(parseUiaReply('ERR nope')).toEqual({ field: '', url: '' })
    expect(parseUiaReply('')).toEqual({ field: '', url: '' })
    expect(parseUiaReply('OK not-base64!!')).toEqual({ field: '', url: '' })
    const partial = Buffer.from(JSON.stringify({ field: 'hi' })).toString('base64')
    expect(parseUiaReply(`OK ${partial}`)).toEqual({ field: 'hi', url: '' })
  })
})
