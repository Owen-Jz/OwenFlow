/**
 * Meeting summary generation — map-reduce over the transcript so a 3-hour
 * meeting (30k+ words) never has to fit one LLM context window:
 *
 *   map:    chunk entries into ~2500-word blocks → one FAST-tier call per
 *           block distills it to terse bullets (mechanical extraction, same
 *           tier policy as normal-mode cleanup / the digest theme line)
 *   reduce: one FLAGSHIP-tier call synthesizes the final summary (overview +
 *           decisions + action items, plain text) from the block bullets
 *
 * A transcript that fits a single block skips the map pass — the flagship
 * reads the raw transcript directly (one call instead of two, no fidelity
 * lost to intermediate bullets).
 *
 * Provider plumbing is cleanup.ts's exported chatOnce() (shared resolution +
 * fallback + timeout), so this module stays pure orchestration. Contract:
 * NEVER throws — any failure (no key, HTTP error, timeout) returns ''.
 */

import { chatOnce } from './cleanup'
import { countWords } from './meeting-channel'
import type { MeetingEntry, OwenFlowSettings } from '../shared/types'

/** Map-phase block size budget (words). ~2500 words ≈ a comfortable 8B-model bite. */
export const BLOCK_WORDS = 2500

const MAP_PROMPT = [
  'You are summarizing ONE block of a longer meeting transcript. Lines are labeled',
  '"You:" (the user) and "Them:" (the other participants).',
  'Distill this block into 3-8 terse "- " bullets covering: topics discussed,',
  'decisions made, and action items (with owner when stated). Keep names, numbers,',
  'and dates exactly as spoken. Do not invent anything.',
  'Output ONLY the bullets — no preamble, no commentary.'
].join('\n')

const REDUCE_PROMPT = [
  'Write the final summary of a meeting. The user message contains either the raw',
  'transcript (lines labeled "You:" / "Them:") or per-block bullet notes distilled',
  'from it.',
  'Output plain text (no markdown headers) in exactly this shape:',
  'A short paragraph summarizing what the meeting was about and what happened.',
  'Decisions: one "- " bullet per decision (or "- none").',
  'Action items: one "- " bullet per action item, with owner when known (or "- none").',
  'Keep every name, number, date, and commitment exactly as stated; never invent.',
  'Output ONLY the summary — no preamble, no commentary.'
].join('\n')

/**
 * Split entries into consecutive blocks of at most `maxWords` words. A block
 * always holds ≥1 entry, so a single entry longer than the budget still forms
 * its own (oversized) block rather than looping forever. Pure — the chunking
 * math is unit-tested directly.
 */
export function chunkEntries(entries: MeetingEntry[], maxWords = BLOCK_WORDS): MeetingEntry[][] {
  const blocks: MeetingEntry[][] = []
  let block: MeetingEntry[] = []
  let words = 0
  for (const entry of entries) {
    const w = countWords(entry.text)
    if (block.length > 0 && words + w > maxWords) {
      blocks.push(block)
      block = []
      words = 0
    }
    block.push(entry)
    words += w
  }
  if (block.length > 0) blocks.push(block)
  return blocks
}

/** One block as speaker-labeled lines — the exact shape both prompts describe. */
function renderBlock(entries: MeetingEntry[]): string {
  return entries.map((e) => `${e.speaker === 'you' ? 'You' : 'Them'}: ${e.text}`).join('\n')
}

/**
 * Generate the meeting summary (see module header for the map-reduce shape).
 * Never throws; '' on empty transcript or any provider failure.
 */
export async function summarizeMeeting(
  entries: MeetingEntry[],
  settings: OwenFlowSettings
): Promise<string> {
  try {
    const blocks = chunkEntries(entries)
    if (blocks.length === 0) return ''

    let material: string
    if (blocks.length === 1) {
      // Short meeting: the flagship reads the raw transcript directly.
      material = renderBlock(blocks[0])
    } else {
      // Map: serial fast-tier calls (mirrors the transcription queue's
      // be-gentle-to-the-provider policy; a 3h meeting is ~12 blocks).
      const bullets: string[] = []
      for (let i = 0; i < blocks.length; i++) {
        const b = await chatOnce(settings, 'fast', MAP_PROMPT, renderBlock(blocks[i]))
        // A failed block is skipped, not fatal — better a summary with a hole
        // than none at all.
        if (b) bullets.push(`Block ${i + 1} of ${blocks.length}:\n${b}`)
      }
      if (bullets.length === 0) return '' // every map call failed → reduce has nothing
      material = bullets.join('\n\n')
    }

    return await chatOnce(settings, 'flagship', REDUCE_PROMPT, material)
  } catch {
    return '' // belt-and-braces: chatOnce never throws, but the contract is absolute
  }
}
