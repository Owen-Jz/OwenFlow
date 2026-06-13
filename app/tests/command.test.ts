import { describe, expect, it } from 'vitest'
import { classifyCommand } from '../src/main/command'

describe('classifyCommand', () => {
  it('routes a zeal prefix', () => {
    expect(classifyCommand('ZEAL, launch a mission for Forge')).toEqual({ sink: 'zeal', instruction: 'launch a mission for Forge' })
    expect(classifyCommand('hey zeal what is my pipeline')).toEqual({ sink: 'zeal', instruction: 'what is my pipeline' })
  })
  it('routes note/vault prefixes', () => {
    expect(classifyCommand('note: buy milk')).toEqual({ sink: 'vault', instruction: 'buy milk' })
    expect(classifyCommand('vault remember the API idea')).toEqual({ sink: 'vault', instruction: 'remember the API idea' })
  })
  it('defaults to local with the full text', () => {
    expect(classifyCommand('make this a bullet list')).toEqual({ sink: 'local', instruction: 'make this a bullet list' })
  })
  it('is case-insensitive and tolerates empty', () => {
    expect(classifyCommand('  ').sink).toBe('local')
  })
})
