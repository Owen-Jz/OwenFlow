/**
 * Pill overlay renderer. Pure state display driven by "pill:state" pushes
 * from the main process. Auto-hide timing is owned by main (pipeline.ts);
 * this renderer only animates in/out.
 *
 * recording    → live canvas waveform (peak-hold caps, amplitude glow, breathing)
 * transcribing → indeterminate scanner pulse sweeping over collapsed bars
 * done         → scanner liquidly resolves to a green baseline, then check pop
 * error        → glitch jitter + short monospace message
 *
 * Sound cues (WebAudio, synthesized — no assets) fire on state transitions:
 * start (rising two-tone), stop (falling two-tone), cancel/error (muted thud).
 * Sound must never break the pill: every audio call is guarded.
 */

import type { LevelFrame, PillState, PillStateName } from '../../shared/types'
import { LEVEL_BINS } from '../../shared/types'
import { formatElapsed, stepPeak, type PeakState } from './pill-motion'

// ─── Brand palette — single source of truth for recoloring ──────────────────
// (Mirror of the CSS variables in pill.html. Rebrand = edit here + :root.)

const PALETTE = {
  brandA: '#ff3b3b', // gradient start (red)
  brandB: '#ff8a3b', // gradient end (amber-red)
  glow: 'rgba(255, 59, 59, 0.55)', // bar glow / motion-blur halo
  glowHot: 'rgba(255, 138, 59, 0.8)', // glow at loud peaks
  cap: 'rgba(255, 200, 160, 0.9)', // peak-hold cap
  ok: '#32d74b', // done flash
  okGlow: 'rgba(50, 215, 75, 0.6)'
} as const

const pill = document.getElementById('pill') as HTMLDivElement
const label = document.getElementById('label') as HTMLDivElement
const timeEl = document.getElementById('time') as HTMLDivElement
const canvas = document.getElementById('wave') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D

// ─── Waveform config ─────────────────────────────────────────────────────────

const NUM_BARS = 20
const IDLE_LEVEL = 0.09 // resting bar height (fraction of canvas height)
const SMOOTHING = 0.28 // per-frame lerp toward target (60fps → ~80ms settle)
const DONE_MORPH_MS = 240 // scanner → green baseline resolve duration

let state: PillStateName = 'idle'
let levels: LevelFrame = new Array(LEVEL_BINS).fill(0)
let bars = new Float32Array(NUM_BARS).fill(IDLE_LEVEL)
let peaks: PeakState[] = Array.from({ length: NUM_BARS }, () => ({ value: 0, holdLeftMs: 0 }))
let raf = 0
let lastFrameAt = 0
let recordStartAt = 0
let doneMorphStart = 0
let lastTimeText = ''
let lastAmp = -1

// ─── Canvas helpers ──────────────────────────────────────────────────────────

function setupCanvas(): void {
  const dpr = window.devicePixelRatio || 1
  const { clientWidth, clientHeight } = canvas
  if (clientWidth === 0 || clientHeight === 0) return
  const w = Math.round(clientWidth * dpr)
  const h = Math.round(clientHeight * dpr)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/** Sample the LEVEL_BINS-bin frame at bar position i with linear interpolation. */
function sampleLevel(i: number): number {
  const pos = (i / (NUM_BARS - 1)) * (LEVEL_BINS - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(LEVEL_BINS - 1, lo + 1)
  const t = pos - lo
  return levels[lo] * (1 - t) + levels[hi] * t
}

function barGradient(width: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, width, 0)
  g.addColorStop(0, PALETTE.brandA)
  g.addColorStop(1, PALETTE.brandB)
  return g
}

/** Overall loudness 0..1 (drives glow width + halo via the --amp CSS var). */
function currentAmp(): number {
  let sum = 0
  for (let i = 0; i < LEVEL_BINS; i++) sum += levels[i]
  return Math.min(1, (sum / LEVEL_BINS) * 2.2)
}

/** Push amplitude to the shell's CSS halo, throttled to visible changes. */
function publishAmp(amp: number): void {
  if (Math.abs(amp - lastAmp) < 0.04) return
  lastAmp = amp
  pill.style.setProperty('--amp', amp.toFixed(2))
}

interface DrawOpts {
  alphas?: Float32Array | null
  /** 0..1 — scales glow blur + shifts glow color hotter */
  amp?: number
  /** draw peak-hold caps above the bars */
  caps?: boolean
  /** override fill (done-morph green resolve) */
  fillStyle?: string | CanvasGradient
  glowColor?: string
}

function drawBars(heights: Float32Array, opts: DrawOpts = {}): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  ctx.clearRect(0, 0, w, h)

  // slim 2px bars, tight gaps — dense techy meter look at the smaller size
  const slot = w / NUM_BARS
  const barW = 2
  const radius = 1
  const amp = opts.amp ?? 0

  ctx.fillStyle = opts.fillStyle ?? barGradient(w)
  // motion-blur halo: glow widens and runs hotter as the signal gets loud
  ctx.shadowColor = opts.glowColor ?? (amp > 0.45 ? PALETTE.glowHot : PALETTE.glow)
  ctx.shadowBlur = 3 + amp * 8

  for (let i = 0; i < NUM_BARS; i++) {
    const frac = Math.min(1, Math.max(IDLE_LEVEL, heights[i]))
    const barH = Math.max(barW, frac * h)
    const x = i * slot + (slot - barW) / 2
    const y = (h - barH) / 2
    ctx.globalAlpha = opts.alphas ? opts.alphas[i] : 1
    ctx.beginPath()
    ctx.roundRect(x, y, barW, barH, radius)
    ctx.fill()
  }

  if (opts.caps) {
    ctx.shadowBlur = 0
    ctx.fillStyle = PALETTE.cap
    for (let i = 0; i < NUM_BARS; i++) {
      const p = peaks[i].value
      if (p <= IDLE_LEVEL + 0.02) continue
      const capH = Math.min(1, p) * h
      const x = i * slot + (slot - barW) / 2
      const y = (h - capH) / 2 - 2
      ctx.globalAlpha = 0.85
      ctx.fillRect(x, Math.max(0, y), barW, 1.5)
    }
  }
  ctx.globalAlpha = 1
}

// ─── Per-state frames ────────────────────────────────────────────────────────

function frameRecording(now: number, dt: number): void {
  const amp = currentAmp()
  for (let i = 0; i < NUM_BARS; i++) {
    // amplitude-driven height + breathing baseline so silence never looks dead
    const breath = 0.025 * Math.sin(now / 900) + 0.02 * Math.sin(now / 320 + i * 0.9)
    const target = IDLE_LEVEL + sampleLevel(i) * (1 - IDLE_LEVEL) + breath
    bars[i] += (target - bars[i]) * SMOOTHING
    stepPeak(peaks[i], bars[i], dt)
  }
  drawBars(bars, { amp, caps: true })
  publishAmp(amp)

  // mono elapsed counter — textContent touched only when the second ticks
  const t = formatElapsed(now - recordStartAt)
  if (t !== lastTimeText) {
    lastTimeText = t
    timeEl.textContent = t
  }
}

const scanAlphas = new Float32Array(NUM_BARS)
const scanHeights = new Float32Array(NUM_BARS)

function frameTranscribing(now: number): void {
  // bars liquidly collapse low; a bright pulse sweeps left→right (indeterminate scan)
  const scanPos = ((now / 1100) % 1) * (NUM_BARS + 8) - 4
  for (let i = 0; i < NUM_BARS; i++) {
    const d = i - scanPos
    const pulse = Math.exp((-d * d) / 7)
    const target = IDLE_LEVEL + pulse * 0.32
    bars[i] += (target - bars[i]) * SMOOTHING
    scanHeights[i] = bars[i]
    scanAlphas[i] = 0.3 + pulse * 0.7
  }
  drawBars(scanHeights, { alphas: scanAlphas })
  publishAmp(0)
}

/** Scanner resolves into the done flash: bars settle flat and turn green. */
function frameDoneMorph(now: number): void {
  const t = Math.min(1, (now - doneMorphStart) / DONE_MORPH_MS)
  for (let i = 0; i < NUM_BARS; i++) {
    bars[i] += (IDLE_LEVEL - bars[i]) * 0.35
    scanHeights[i] = bars[i]
    scanAlphas[i] = 0.45 + t * 0.55
  }
  drawBars(scanHeights, {
    alphas: scanAlphas,
    fillStyle: PALETTE.ok,
    glowColor: PALETTE.okGlow,
    amp: t * 0.6
  })
  if (t >= 1) {
    // hand off to the CSS check pop
    morphingToDone = false
    pill.dataset.state = 'done'
    stopLoop()
  }
}

// ─── Animation loop (runs only while pill is visible in an animated state) ──

let morphingToDone = false

function loop(now: number): void {
  const dt = lastFrameAt === 0 ? 16 : Math.min(64, now - lastFrameAt)
  lastFrameAt = now
  if (morphingToDone) frameDoneMorph(now)
  else if (state === 'recording') frameRecording(now, dt)
  else if (state === 'transcribing') frameTranscribing(now)
  else {
    raf = 0
    return
  }
  if (raf !== 0) raf = requestAnimationFrame(loop)
}

function startLoop(): void {
  setupCanvas()
  lastFrameAt = 0
  if (raf === 0) raf = requestAnimationFrame(loop)
}

function stopLoop(): void {
  if (raf !== 0) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}

// ─── Sound cues (synthesized, lazy AudioContext, can never throw out) ────────

type CueName = 'start' | 'stop' | 'cancel' | 'error'

let audio: AudioContext | null = null

const CUE_GAIN = 0.12 // ≈ -18 dBFS — present but polite

/** One short enveloped tone. */
function tone(
  ac: AudioContext,
  type: OscillatorType,
  freqFrom: number,
  freqTo: number,
  startAt: number,
  durMs: number,
  gain: number
): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freqFrom, startAt)
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), startAt + durMs / 1000)
  g.gain.setValueAtTime(0.0001, startAt)
  g.gain.exponentialRampToValueAtTime(gain, startAt + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + durMs / 1000)
  osc.connect(g)
  g.connect(ac.destination)
  osc.start(startAt)
  osc.stop(startAt + durMs / 1000 + 0.02)
}

function playCue(name: CueName): void {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
    const t0 = audio.currentTime + 0.005
    switch (name) {
      case 'start':
        // rising two-tone blip — "armed"
        tone(audio, 'triangle', 660, 660, t0, 55, CUE_GAIN)
        tone(audio, 'triangle', 880, 920, t0 + 0.065, 70, CUE_GAIN)
        break
      case 'stop':
        // falling two-tone — "captured"
        tone(audio, 'triangle', 880, 880, t0, 55, CUE_GAIN)
        tone(audio, 'triangle', 620, 560, t0 + 0.065, 75, CUE_GAIN)
        break
      case 'cancel':
        // tiny muted thud — "discarded"
        tone(audio, 'sine', 220, 110, t0, 90, CUE_GAIN * 0.9)
        break
      case 'error':
        // duller, slightly dissonant double-thud
        tone(audio, 'sine', 180, 90, t0, 100, CUE_GAIN)
        tone(audio, 'square', 130, 95, t0 + 0.07, 80, CUE_GAIN * 0.35)
        break
    }
  } catch {
    // sound must never break the pill
  }
}

function cueFor(prev: PillStateName, next: PillStateName): CueName | null {
  if (next === 'recording' && prev !== 'recording') return 'start'
  if (prev === 'recording' && next === 'transcribing') return 'stop'
  if (prev === 'recording' && next === 'idle') return 'cancel'
  if (next === 'error' && prev !== 'error') return 'error'
  return null
}

// ─── State rendering ─────────────────────────────────────────────────────────

function render(next: PillState): void {
  const prev = state
  state = next.state

  const cue = cueFor(prev, next.state)
  if (cue) playCue(cue)

  if (next.state === 'idle') {
    morphingToDone = false
    stopLoop()
    publishAmp(0)
    pill.classList.remove('visible')
    // keep last data-state during fade-out so the layout doesn't flicker
    return
  }

  // done: let the scanner resolve into a green baseline before the check pops
  if (next.state === 'done' && prev === 'transcribing' && raf !== 0) {
    morphingToDone = true
    doneMorphStart = performance.now()
    publishAmp(0)
    return // dataset flips to 'done' when the morph completes
  }
  morphingToDone = false

  pill.dataset.state = next.state
  // errors stay readable; every other state is purely visual
  label.textContent = next.state === 'error' ? next.message || 'something went wrong' : ''

  if (next.state === 'recording' || next.state === 'transcribing') {
    if (next.state === 'recording') {
      levels = new Array(LEVEL_BINS).fill(0)
      bars = new Float32Array(NUM_BARS).fill(IDLE_LEVEL)
      peaks = Array.from({ length: NUM_BARS }, () => ({ value: 0, holdLeftMs: 0 }))
      recordStartAt = performance.now()
      lastTimeText = ''
      timeEl.textContent = '0:00'
    }
    startLoop()
  } else {
    stopLoop()
    publishAmp(0)
  }

  // restart entry animation when becoming visible
  if (!pill.classList.contains('visible')) {
    void pill.offsetWidth // reflow
  }
  pill.classList.add('visible')
}

window.owenflow.pill.onState(render)
window.owenflow.pill.onLevel((frame: LevelFrame) => {
  if (state === 'recording') levels = frame
})
