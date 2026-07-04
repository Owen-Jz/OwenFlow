/**
 * "Press enter" voice command (Wispr Flow parity): ending a dictation with
 * "press enter" (or "hit enter") auto-presses Enter after the paste, so
 * "reply sounds good press enter" sends a Slack/AI-chat message hands-free.
 *
 * Pure text detection only — the actual keystroke lives in injector.ts and
 * the sequencing (paste first, Enter after) lives in pipeline.ts. Kept
 * dependency-free so it unit-tests without electron.
 */

/** Result of scanning a final transcript for the trailing command. */
export interface PressEnterDetection {
  /** The text to paste, with the spoken command (and dangling separator) stripped. */
  text: string
  /** True when the utterance ended with "press enter" / "hit enter". */
  pressEnter: boolean
}

/**
 * The command must be TRAILING: "press enter" / "hit enter" followed by
 * nothing but punctuation/whitespace to the end of the text (the AI cleanup
 * pass often capitalizes it into its own sentence, e.g. "… Press enter.").
 * A mid-sentence mention ("press enter to submit the form") must never
 * trigger — the `$` anchor plus the punctuation-only tail guarantees that.
 * `\b` keeps letter-adjacent matches out ("suppress enter" stays untouched).
 */
const TRAILING_COMMAND = /\b(?:press|hit)\s+enter[\s.,!?;:…]*$/i

/**
 * The character right before the command must be a separator (or the string
 * start) — spoken commands arrive as their own clause, never glued to a word.
 * Guards odd transcripts like "compress enter" that survive the `\b` check.
 */
const SEPARATOR_BEFORE = /[\s.,;:!?…—–-]$/

/**
 * Whatever the command leaves behind can end in a dangling separator
 * ("send it, press enter" → "send it,") — strip trailing whitespace, commas,
 * semicolons, colons and dashes. Sentence-ending punctuation (. ! ? …) is
 * KEPT: "…done. Press enter." must come out as "…done.", not "…done".
 */
const DANGLING_SEPARATOR = /[\s,;:—–-]+$/

/**
 * Detect a trailing spoken "press enter" / "hit enter" command on the final
 * (post-cleanup, post-dictionary) text. Case-insensitive; tolerates trailing
 * punctuation/whitespace after the phrase and any separator before it.
 * Returns the text with the phrase cleanly stripped — an utterance that is
 * ONLY the command yields empty text (nothing to paste, just press Enter).
 */
export function detectPressEnter(text: string): PressEnterDetection {
  const match = TRAILING_COMMAND.exec(text)
  if (!match) return { text, pressEnter: false }

  const before = text.slice(0, match.index)
  if (before && !SEPARATOR_BEFORE.test(before)) return { text, pressEnter: false }

  return { text: before.replace(DANGLING_SEPARATOR, ''), pressEnter: true }
}
