/**
 * Command-channel intent routing. Pure (no electron). The command hotkey is a
 * dedicated ZEAL channel: anything spoken goes to ZEAL by default. Optional
 * leading keywords ("note" / "vault") still route to the vault sink, and the
 * legacy "edit" / "rewrite" prefix opts into local text-editing via the LLM.
 */
export type CommandSink = 'zeal' | 'vault' | 'local'
export interface CommandRoute {
  sink: CommandSink
  instruction: string
}

const PREFIXES: Array<{ re: RegExp; sink: CommandSink }> = [
  { re: /^(?:hey\s+)?zeal[\s,:]+/i, sink: 'zeal' },
  { re: /^(?:note|vault)[\s,:]+/i, sink: 'vault' },
  // Opt-in to the local LLM text-edit by leading the instruction with "edit"
  // or "rewrite" — otherwise everything is a ZEAL command.
  { re: /^(?:edit|rewrite)[\s,:]+/i, sink: 'local' }
]

export function classifyCommand(transcript: string): CommandRoute {
  const text = transcript.trim()
  for (const { re, sink } of PREFIXES) {
    const m = text.match(re)
    if (m) return { sink, instruction: text.slice(m[0].length).trim() }
  }
  return { sink: 'zeal', instruction: text }
}
