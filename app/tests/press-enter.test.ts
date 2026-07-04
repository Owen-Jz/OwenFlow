import { describe, expect, it } from 'vitest'
import { detectPressEnter } from '../src/main/press-enter'

describe('detectPressEnter', () => {
  it('detects a trailing "press enter" with no punctuation', () => {
    expect(detectPressEnter('reply sounds good press enter')).toEqual({
      text: 'reply sounds good',
      pressEnter: true
    })
  })

  it('detects the cleanup-capitalized own-sentence form ("…done. Press enter.")', () => {
    expect(detectPressEnter('Tell them the deploy is done. Press enter.')).toEqual({
      text: 'Tell them the deploy is done.',
      pressEnter: true
    })
  })

  it('detects "hit enter" as a synonym', () => {
    expect(detectPressEnter('sounds good hit enter')).toEqual({
      text: 'sounds good',
      pressEnter: true
    })
  })

  it('is case-insensitive (PRESS ENTER / Hit Enter)', () => {
    expect(detectPressEnter('ship it PRESS ENTER')).toEqual({ text: 'ship it', pressEnter: true })
    expect(detectPressEnter('ship it, Hit Enter.')).toEqual({ text: 'ship it', pressEnter: true })
  })

  it('tolerates trailing punctuation and whitespace after the phrase', () => {
    expect(detectPressEnter('looks great press enter!')).toEqual({
      text: 'looks great',
      pressEnter: true
    })
    expect(detectPressEnter('looks great press enter.  ')).toEqual({
      text: 'looks great',
      pressEnter: true
    })
    expect(detectPressEnter('looks great, press enter...')).toEqual({
      text: 'looks great',
      pressEnter: true
    })
  })

  it('strips a dangling comma left before the phrase', () => {
    expect(detectPressEnter('send the reply, press enter')).toEqual({
      text: 'send the reply',
      pressEnter: true
    })
  })

  it('keeps sentence-ending punctuation on the remaining text', () => {
    expect(detectPressEnter('Is that okay? Press enter.')).toEqual({
      text: 'Is that okay?',
      pressEnter: true
    })
    expect(detectPressEnter('Ship it! press enter')).toEqual({
      text: 'Ship it!',
      pressEnter: true
    })
  })

  it('handles a dash separator before the phrase', () => {
    expect(detectPressEnter('done — press enter')).toEqual({ text: 'done', pressEnter: true })
  })

  it('text that is ONLY the command yields empty text + true', () => {
    expect(detectPressEnter('press enter')).toEqual({ text: '', pressEnter: true })
    expect(detectPressEnter('Press enter.')).toEqual({ text: '', pressEnter: true })
    expect(detectPressEnter('  hit enter  ')).toEqual({ text: '', pressEnter: true })
  })

  it('does NOT trigger mid-sentence ("press enter to submit the form")', () => {
    const text = 'press enter to submit the form'
    expect(detectPressEnter(text)).toEqual({ text, pressEnter: false })
  })

  it('does NOT trigger when the phrase is followed by more words anywhere', () => {
    const text = 'you should press enter when the dialog appears'
    expect(detectPressEnter(text)).toEqual({ text, pressEnter: false })
  })

  it('only the TRAILING occurrence is stripped (mid-sentence mention survives)', () => {
    expect(detectPressEnter('tell users to press enter to save. Press enter.')).toEqual({
      text: 'tell users to press enter to save.',
      pressEnter: true
    })
  })

  it('does NOT trigger on letter-adjacent look-alikes ("suppress enter")', () => {
    const text = 'we should suppress enter'
    expect(detectPressEnter(text)).toEqual({ text, pressEnter: false })
  })

  it('does NOT trigger on "enter" alone or unrelated text', () => {
    expect(detectPressEnter('enter')).toEqual({ text: 'enter', pressEnter: false })
    expect(detectPressEnter('hello world')).toEqual({ text: 'hello world', pressEnter: false })
    expect(detectPressEnter('')).toEqual({ text: '', pressEnter: false })
  })

  it('does NOT trigger on "press the enter key" (word between)', () => {
    const text = 'press the enter key'
    expect(detectPressEnter(text)).toEqual({ text, pressEnter: false })
  })
})
