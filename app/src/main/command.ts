/**
 * Command-channel intent routing. Pure (no electron). A leading keyword routes
 * the spoken instruction to a sink; the keyword (and an optional comma/colon)
 * is stripped from the instruction. Everything else is a local text-edit.
 */
export type CommandSink = 'zeal' | 'vault' | 'local'
export interface CommandRoute {
  sink: CommandSink
  instruction: string
}

const PREFIXES: Array<{ re: RegExp; sink: CommandSink }> = [
  { re: /^(?:hey\s+)?zeal[\s,:]+/i, sink: 'zeal' },
  { re: /^(?:note|vault)[\s,:]+/i, sink: 'vault' }
]

export function classifyCommand(transcript: string): CommandRoute {
  const text = transcript.trim()
  for (const { re, sink } of PREFIXES) {
    const m = text.match(re)
    if (m) return { sink, instruction: text.slice(m[0].length).trim() }
  }
  return { sink: 'local', instruction: text }
}
