/**
 * UIA reader: a persistent PowerShell helper (twin of injector.ts) that loads
 * Windows UIAutomation assemblies once and answers two request types:
 *   - Read-Focus: focused element's text + foreground browser URL
 *   - Read-Editor: focused element's document text for symbol extraction
 *
 * Failure contract: readFocusContext / readEditorSymbols never throw; they
 * return empty values on any failure or 400 ms timeout.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { compactContext, extractIdentifiers, siteFromUrl } from './uia-parse'

const READY_TIMEOUT_MS = 15_000
const READ_TIMEOUT_MS = 400 // reads are best-effort; never make the user wait

// Loaded once into the persistent helper. Emits READY when the UIA assemblies
// and reader functions are defined. Read-Focus returns the focused element's
// text (TextPattern → ValuePattern fallback) plus, if the foreground window is
// a browser, its address-bar URL — all as base64(JSON) so newlines/quotes in
// field text can't corrupt the line protocol.
const INIT_SCRIPT = [
  "Add-Type -AssemblyName UIAutomationClient;",
  "Add-Type -AssemblyName UIAutomationTypes;",
  "function Enc($f,$u){",
  "  $o=@{field=$f;url=$u} | ConvertTo-Json -Compress;",
  "  $b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($o));",
  "  [Console]::Out.WriteLine('OK ' + $b);",
  "}",
  "function Focused-Text {",
  "  try {",
  "    $fe=[System.Windows.Automation.AutomationElement]::FocusedElement;",
  "    if(-not $fe){return ''};",
  "    $tp=$null;",
  "    if($fe.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$tp)){",
  "      return $tp.DocumentRange.GetText(4000);",
  "    }",
  "    $vp=$null;",
  "    if($fe.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$vp)){",
  "      return $vp.Current.Value;",
  "    }",
  "    return '';",
  "  } catch { return '' }",
  "}",
  "function Browser-Url {",
  "  try {",
  "    $root=[System.Windows.Automation.AutomationElement]::RootElement;",
  "    $fw=[System.Windows.Automation.AutomationElement]::FocusedElement;",
  "    if(-not $fw){return ''};",
  "    $pid=$fw.Current.ProcessId;",
  "    $pname=(Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName;",
  "    if($pname -notmatch 'chrome|msedge|brave|firefox|opera'){return ''};",
  "    $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$pid);",
  "    $win=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,$cond);",
  "    if(-not $win){return ''};",
  "    $ec=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit);",
  "    $edit=$win.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$ec);",
  "    if(-not $edit){return ''};",
  "    $vp=$null;",
  "    if($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$vp)){return $vp.Current.Value};",
  "    return '';",
  "  } catch { return '' }",
  "}",
  "[Console]::Out.WriteLine('READY');"
].join(' ')

const READ_FOCUS_LINE = "Enc (Focused-Text) (Browser-Url)"
const READ_EDITOR_LINE = "Enc (Focused-Text) ''"

// ── pure reply parser ────────────────────────────────────────────────────────

export function parseUiaReply(line: string): { field: string; url: string } {
  const empty = { field: '', url: '' }
  if (!line.startsWith('OK ')) return empty
  try {
    const json = Buffer.from(line.slice(3).trim(), 'base64').toString('utf8')
    const obj = JSON.parse(json) as { field?: unknown; url?: unknown }
    return {
      field: typeof obj.field === 'string' ? obj.field : '',
      url: typeof obj.url === 'string' ? obj.url : ''
    }
  } catch {
    return empty
  }
}

// ── persistent helper (twin of injector.ts) ──────────────────────────────────

let helper: ChildProcess | null = null
let helperReady: Promise<void> | null = null
let stdoutBuffer = ''
/** FIFO of waiters for the next helper stdout line. */
const lineWaiters: Array<(line: string) => void> = []

function onHelperStdout(chunk: Buffer): void {
  stdoutBuffer += chunk.toString()
  let nl: number
  while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, nl).trim()
    stdoutBuffer = stdoutBuffer.slice(nl + 1)
    if (!line) continue
    lineWaiters.shift()?.(line)
  }
}

function nextLine(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = lineWaiters.indexOf(waiter)
      if (i >= 0) lineWaiters.splice(i, 1)
      reject(new Error('Helper timed out'))
    }, timeoutMs)
    const waiter = (line: string): void => {
      clearTimeout(timer)
      resolve(line)
    }
    lineWaiters.push(waiter)
  })
}

function discardHelper(): void {
  const proc = helper
  helper = null
  helperReady = null
  stdoutBuffer = ''
  while (lineWaiters.length) lineWaiters.shift()?.('DEAD')
  if (proc && proc.exitCode === null) {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
}

/** Spawn (or reuse) the UIA helper; resolves once assemblies are loaded (READY). */
function ensureHelper(): Promise<void> {
  if (helper && helper.exitCode === null && helperReady) return helperReady

  discardHelper()
  const proc = spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  helper = proc
  proc.stdout?.on('data', onHelperStdout)
  proc.stderr?.on('data', (d: Buffer) => console.warn('[uia]', d.toString().trimEnd()))
  proc.on('exit', () => {
    if (helper === proc) discardHelper() // respawned lazily on next read
  })
  proc.on('error', (err) => {
    console.error('[uia] helper spawn failed:', err.message)
    if (helper === proc) discardHelper()
  })

  helperReady = (async () => {
    const ready = nextLine(READY_TIMEOUT_MS)
    proc.stdin?.write(INIT_SCRIPT + '\n')
    const line = await ready
    if (line !== 'READY') {
      discardHelper()
      throw new Error(`UIA helper failed to initialize: ${line}`)
    }
  })()
  return helperReady
}

// ── read helpers ─────────────────────────────────────────────────────────────

async function readOnce(requestLine: string): Promise<{ field: string; url: string }> {
  try {
    await ensureHelper()
    const proc = helper
    if (!proc?.stdin) return { field: '', url: '' }
    const reply = nextLine(READ_TIMEOUT_MS)
    proc.stdin.write(requestLine + '\n')
    return parseUiaReply(await reply)
  } catch {
    return { field: '', url: '' }
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Read the focused element's field text plus the foreground browser's URL.
 * Returns compacted context text + extracted site label. Never throws; empty
 * on any failure or 400 ms timeout.
 */
export async function readFocusContext(): Promise<{ text: string; site: string | null }> {
  const { field, url } = await readOnce(READ_FOCUS_LINE)
  return { text: compactContext(field), site: siteFromUrl(url) }
}

/**
 * Read the focused element's document text and extract code identifiers for
 * Whisper biasing. Never throws; returns [] on any failure or 400 ms timeout.
 */
export async function readEditorSymbols(): Promise<string[]> {
  const { field } = await readOnce(READ_EDITOR_LINE)
  return extractIdentifiers(field)
}

/** Pre-warm the UIA PowerShell helper at app boot so the first read is fast. */
export function warmupUia(): void {
  ensureHelper().catch((err) => console.warn('[uia] warmup failed:', err instanceof Error ? err.message : err))
}

/** Kill the UIA helper on app quit. */
export function killUia(): void {
  discardHelper()
}
