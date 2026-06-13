/**
 * Text injection: clipboard swap + Ctrl+V keystroke.
 *
 * The keystroke is sent by a PERSISTENT PowerShell helper child process
 * (`powershell -NoProfile -Command -` executes stdin line-by-line). On first
 * use we feed it an Add-Type C# definition that P/Invokes user32 SendInput
 * (proper KEYBDINPUT down/up events for VK_CONTROL + VK_V). Each paste then
 * costs one stdin line instead of ~600ms of PowerShell startup.
 *
 * Failure contract: if the paste keystroke fails, the dictated text is LEFT on
 * the clipboard and a PasteFailedError("Copied — paste manually") is thrown so
 * the pipeline can surface it. On success the previous clipboard text is
 * restored after a short delay (the paste target reads the clipboard first).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { clipboard } from 'electron'

const PASTE_SETTLE_MS = 150
const HELPER_READY_TIMEOUT_MS = 15_000
const PASTE_TIMEOUT_MS = 3_000

export class PasteFailedError extends Error {
  constructor(message = 'Copied — paste manually') {
    super(message)
    this.name = 'PasteFailedError'
  }
}

// C# kept single-quote-free so it survives the PowerShell single-quoted string.
// INPUT is Explicit/Size=40 — the x64 SendInput union size (verified: 40).
const ADD_TYPE_LINE =
  "Add-Type -TypeDefinition '" +
  'using System;using System.Runtime.InteropServices;' +
  'public static class OwenFlowInput{' +
  '[StructLayout(LayoutKind.Sequential)]public struct KEYBDINPUT{public ushort wVk;public ushort wScan;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}' +
  '[StructLayout(LayoutKind.Explicit,Size=40)]public struct INPUT{[FieldOffset(0)]public uint type;[FieldOffset(8)]public KEYBDINPUT ki;}' +
  '[DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint nInputs,INPUT[] pInputs,int cbSize);' +
  'public static void PasteCtrlV(){' +
  'INPUT[] inputs=new INPUT[4];' +
  'inputs[0].type=1;inputs[0].ki.wVk=0x11;' + // Ctrl down
  'inputs[1].type=1;inputs[1].ki.wVk=0x56;' + // V down
  'inputs[2].type=1;inputs[2].ki.wVk=0x56;inputs[2].ki.dwFlags=2;' + // V up (KEYEVENTF_KEYUP)
  'inputs[3].type=1;inputs[3].ki.wVk=0x11;inputs[3].ki.dwFlags=2;' + // Ctrl up
  'uint sent=SendInput(4u,inputs,Marshal.SizeOf(typeof(INPUT)));' +
  'if(sent!=4u){throw new Exception("SendInput failed: "+Marshal.GetLastWin32Error());}' +
  '}' +
  '[DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();' +
  '[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint pid);' +
  'public static string GetForegroundExe(){uint pid;GetWindowThreadProcessId(GetForegroundWindow(),out pid);try{return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;}catch{return "";}}' +
  'public static void CopyCtrlC(){' +
  'INPUT[] inputs=new INPUT[4];' +
  'inputs[0].type=1;inputs[0].ki.wVk=0x11;' +
  'inputs[1].type=1;inputs[1].ki.wVk=0x43;' +
  'inputs[2].type=1;inputs[2].ki.wVk=0x43;inputs[2].ki.dwFlags=2;' +
  'inputs[3].type=1;inputs[3].ki.wVk=0x11;inputs[3].ki.dwFlags=2;' +
  'uint sent=SendInput(4u,inputs,Marshal.SizeOf(typeof(INPUT)));' +
  'if(sent!=4u){throw new Exception("SendInput failed: "+Marshal.GetLastWin32Error());}' +
  '}' +
  '}' +
  "';[Console]::Out.WriteLine('READY')"

const PASTE_LINE =
  "try{[OwenFlowInput]::PasteCtrlV();[Console]::Out.WriteLine('OK')}" +
  "catch{[Console]::Out.WriteLine('ERR ' + $_.Exception.Message)}"

const COPY_SETTLE_MS = 140
const COPY_LINE =
  "try{[OwenFlowInput]::CopyCtrlC();[Console]::Out.WriteLine('OK')}" +
  "catch{[Console]::Out.WriteLine('ERR ' + $_.Exception.Message)}"

const FOREGROUND_LINE =
  "try{[Console]::Out.WriteLine('EXE ' + [OwenFlowInput]::GetForegroundExe())}" +
  "catch{[Console]::Out.WriteLine('ERR ' + $_.Exception.Message)}"

// ─── Persistent helper management ────────────────────────────────────────────

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

/** Spawn (or reuse) the helper; resolves once Add-Type compiled (READY). */
function ensureHelper(): Promise<void> {
  if (helper && helper.exitCode === null && helperReady) return helperReady

  discardHelper()
  const proc = spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  helper = proc
  proc.stdout?.on('data', onHelperStdout)
  proc.stderr?.on('data', (d: Buffer) => console.warn('[injector]', d.toString().trimEnd()))
  proc.on('exit', () => {
    if (helper === proc) discardHelper() // respawned lazily on next inject
  })
  proc.on('error', (err) => {
    console.error('[injector] helper spawn failed:', err.message)
    if (helper === proc) discardHelper()
  })

  helperReady = (async () => {
    const ready = nextLine(HELPER_READY_TIMEOUT_MS)
    proc.stdin?.write(ADD_TYPE_LINE + '\n')
    const line = await ready
    if (line !== 'READY') {
      discardHelper()
      throw new Error(`Helper failed to initialize: ${line}`)
    }
  })()
  return helperReady
}

/** Pre-warm the PowerShell helper at app boot so the first paste is fast. */
export function warmupInjector(): void {
  ensureHelper().catch((err) => console.warn('[injector] warmup failed:', err.message))
}

/** Kill the helper on app quit. */
export function killInjector(): void {
  discardHelper()
}

async function sendCtrlV(): Promise<void> {
  await ensureHelper()
  const proc = helper
  if (!proc?.stdin) throw new Error('Helper unavailable')
  const reply = nextLine(PASTE_TIMEOUT_MS)
  proc.stdin.write(PASTE_LINE + '\n')
  const line = await reply
  if (line !== 'OK') throw new Error(line.startsWith('ERR') ? line : `Helper said: ${line}`)
}

/** Process name of the foreground window (no .exe), or null on any failure. */
export async function getForegroundApp(): Promise<string | null> {
  try {
    await ensureHelper()
    const proc = helper
    if (!proc?.stdin) return null
    const reply = nextLine(PASTE_TIMEOUT_MS)
    proc.stdin.write(FOREGROUND_LINE + '\n')
    const line = await reply
    return line.startsWith('EXE ') ? (line.slice(4).trim() || null) : null
  } catch {
    return null
  }
}

/** Copy the current selection (Ctrl+C) and return the clipboard text. '' on failure. */
export async function copySelection(): Promise<string> {
  try {
    await ensureHelper()
    const proc = helper
    if (!proc?.stdin) return ''
    const reply = nextLine(PASTE_TIMEOUT_MS)
    proc.stdin.write(COPY_LINE + '\n')
    const line = await reply
    if (line !== 'OK') return ''
    await delay(COPY_SETTLE_MS)
    return clipboard.readText()
  } catch {
    return ''
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Inject text into the focused app: save clipboard → write text → Ctrl+V →
 * wait → restore clipboard. On paste failure the text STAYS on the clipboard
 * and PasteFailedError is thrown.
 */
export async function inject(text: string): Promise<void> {
  const previous = clipboard.readText()
  clipboard.writeText(text)

  try {
    await sendCtrlV()
  } catch (err) {
    console.error('[injector] paste failed:', err instanceof Error ? err.message : err)
    // Deliberately NOT restoring — the dictated text must stay available.
    throw new PasteFailedError()
  }

  try {
    await delay(PASTE_SETTLE_MS) // let the target app consume the clipboard
  } finally {
    clipboard.writeText(previous)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
