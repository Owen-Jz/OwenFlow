/**
 * Python STT sidecar manager.
 *
 * Spawns `py -3.13 server.py` (bare `python` resolves to a wrong venv on this
 * machine), health-polls until the whisper model is loaded (can take tens of
 * seconds on first run), auto-restarts on crash (max 3, exponential backoff)
 * and exposes `transcribe()` as a multipart POST using Node's built-in fetch.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const PORT = Number(process.env.OWENFLOW_PORT ?? 8484)
const BASE_URL = `http://127.0.0.1:${PORT}`
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_INTERVAL_MS = 1_000
const MAX_RESTARTS = 3

export type SidecarStatus = 'stopped' | 'starting' | 'ready' | 'error'

export interface SidecarHealth {
  ok: boolean
  model: string
  loaded: boolean
}

export interface SidecarTranscribeResult {
  text: string
  durationMs: number
  model: string
}

let child: ChildProcess | null = null
let status: SidecarStatus = 'stopped'
let statusDetail = ''
let currentModel = 'small'
let restartCount = 0
let restartTimer: NodeJS.Timeout | null = null
let stopping = false

type StatusListener = (status: SidecarStatus, detail: string) => void
const listeners: StatusListener[] = []

export function getSidecarStatus(): { status: SidecarStatus; detail: string } {
  return { status, detail: statusDetail }
}

/** Subscribe to status changes (tray tooltip). Returns unsubscribe. */
export function onSidecarStatus(listener: StatusListener): () => void {
  listeners.push(listener)
  return () => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  }
}

function setStatus(next: SidecarStatus, detail = ''): void {
  status = next
  statusDetail = detail
  for (const l of [...listeners]) l(next, detail)
}

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Locate the sidecar directory. Dev layout: <repo>/app + <repo>/sidecar.
 * OWENFLOW_SIDECAR_DIR env var overrides (packaged-app escape hatch).
 */
function resolveSidecarDir(): string | null {
  const candidates = [
    process.env.OWENFLOW_SIDECAR_DIR,
    join(app.getAppPath(), '..', 'sidecar'),
    process.resourcesPath ? join(process.resourcesPath, 'sidecar') : undefined
  ]
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'server.py'))) return dir
  }
  console.error(
    '[sidecar] server.py not found. Tried:',
    candidates.filter(Boolean).join(' | '),
    '— set OWENFLOW_SIDECAR_DIR to the directory containing server.py.'
  )
  return null
}

// ─── Health ──────────────────────────────────────────────────────────────────

async function checkHealth(timeoutMs = 1500): Promise<SidecarHealth | null> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as SidecarHealth
  } catch {
    return null
  }
}

/** Kill whatever is squatting on the sidecar port (orphan from a crashed run). */
function killOrphanOnPort(): void {
  try {
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ` +
          `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
      ],
      { timeout: 10_000, windowsHide: true }
    )
  } catch (err) {
    console.warn('[sidecar] orphan cleanup failed:', err)
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Start the sidecar and resolve once /health reports the model loaded
 * (or reject after 60s / spawn failure). Safe to call once at boot.
 */
export async function startSidecar(model: string): Promise<void> {
  currentModel = model
  stopping = false

  // Anything already on our port is an orphan from a previous run — clear it.
  const existing = await checkHealth(1000)
  if (existing) {
    console.warn('[sidecar] found orphan sidecar on port', PORT, '— killing it')
    killOrphanOnPort()
    await delay(500)
  }

  await spawnAndWait()
}

async function spawnAndWait(): Promise<void> {
  const dir = resolveSidecarDir()
  if (!dir) {
    setStatus('error', 'sidecar files not found')
    throw new Error('Sidecar directory not found')
  }

  setStatus('starting', `loading whisper "${currentModel}"`)

  const proc = spawn('py', ['-3.13', 'server.py'], {
    cwd: dir,
    env: {
      ...process.env,
      OWENFLOW_MODEL: currentModel,
      OWENFLOW_PORT: String(PORT)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child = proc

  proc.stdout?.on('data', (d: Buffer) => console.log('[sidecar]', d.toString().trimEnd()))
  proc.stderr?.on('data', (d: Buffer) => console.log('[sidecar]', d.toString().trimEnd()))

  proc.on('error', (err) => {
    console.error('[sidecar] spawn failed:', err.message)
    setStatus('error', `spawn failed: ${err.message}`)
  })

  proc.on('exit', (code) => {
    if (child !== proc) return // superseded by a restart
    child = null
    if (stopping) {
      setStatus('stopped')
      return
    }
    console.error(`[sidecar] exited unexpectedly (code ${code})`)
    if (restartCount < MAX_RESTARTS) {
      restartCount += 1
      const backoff = 1000 * 2 ** (restartCount - 1) // 1s, 2s, 4s
      setStatus('error', `crashed — restart ${restartCount}/${MAX_RESTARTS} in ${backoff / 1000}s`)
      restartTimer = setTimeout(() => {
        void spawnAndWait().catch(() => {})
      }, backoff)
    } else {
      setStatus('error', 'crashed too many times — restart the app')
    }
  })

  // Health-poll patiently: model load takes a few seconds (longer on first
  // download). Up to 60s.
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (stopping) return
    if (child !== proc || proc.exitCode !== null) {
      throw new Error('Sidecar process exited during startup')
    }
    const health = await checkHealth()
    if (health?.loaded) {
      restartCount = 0
      setStatus('ready', `whisper "${health.model}"`)
      console.log('[sidecar] ready:', health)
      return
    }
    await delay(HEALTH_INTERVAL_MS)
  }
  setStatus('error', 'health check timed out (60s)')
  throw new Error('Sidecar did not become healthy within 60s')
}

/** Kill the sidecar (and its python child — `py` is a launcher, so kill the tree). */
export function stopSidecar(): void {
  stopping = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  const proc = child
  child = null
  if (proc?.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        timeout: 10_000,
        windowsHide: true
      })
    } catch {
      proc.kill()
    }
  }
  setStatus('stopped')
}

/** Settings live-reload: whisper model changed → restart with the new model. */
export async function restartSidecar(model: string): Promise<void> {
  stopSidecar()
  restartCount = 0
  await delay(500)
  await startSidecar(model)
}

// ─── Transcription client ────────────────────────────────────────────────────

/**
 * POST a 16kHz mono WAV to the sidecar. `prompt` biases whisper recognition
 * (dictionary words); `language` (e.g. "en") skips auto-detect and is faster.
 */
export async function transcribe(
  wav: Buffer | ArrayBuffer,
  prompt?: string,
  language?: string
): Promise<SidecarTranscribeResult> {
  if (status !== 'ready') {
    throw new Error(`Transcriber not ready (${status}${statusDetail ? `: ${statusDetail}` : ''})`)
  }

  const bytes = wav instanceof ArrayBuffer ? new Uint8Array(wav) : new Uint8Array(wav)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav')
  if (prompt) form.append('prompt', prompt)
  if (language) form.append('language', language)

  const res = await fetch(`${BASE_URL}/transcribe`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000)
  })
  if (!res.ok) {
    throw new Error(`Transcription failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as { text: string; duration_ms: number; model: string }
  return { text: data.text ?? '', durationMs: data.duration_ms ?? 0, model: data.model ?? '' }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
