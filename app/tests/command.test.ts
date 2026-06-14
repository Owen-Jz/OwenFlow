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
  it('defaults to zeal with the full text (dedicated ZEAL channel)', () => {
    expect(classifyCommand('make this a bullet list')).toEqual({ sink: 'zeal', instruction: 'make this a bullet list' })
    expect(classifyCommand('add a kanban task to review the homepage')).toEqual({ sink: 'zeal', instruction: 'add a kanban task to review the homepage' })
  })
  it('routes edit/rewrite prefixes to local LLM text-edit', () => {
    expect(classifyCommand('edit: make this formal')).toEqual({ sink: 'local', instruction: 'make this formal' })
    expect(classifyCommand('rewrite this paragraph')).toEqual({ sink: 'local', instruction: 'this paragraph' })
  })
  it('is case-insensitive and tolerates empty', () => {
    expect(classifyCommand('  ').sink).toBe('zeal')
  })
})
