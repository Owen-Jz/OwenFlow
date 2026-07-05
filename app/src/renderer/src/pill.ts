/**
 * Pill overlay renderer. Pure state display driven by "pill:state" pushes
 * from the main process. Auto-hide timing is owned by main (pipeline.ts);
 * this renderer only animates in/out.
 *
 * Design follows Wispr Flow's "Flow Bar": quiet, monochrome, Apple-esque.
 * recording    → clean white-bar waveform on canvas + tiny dim elapsed timer;
 *                bars settle nearly flat during silence (calm, not dancing)
 * transcribing → three soft white dots pulsing in sequence (pure CSS — the
 *                canvas is hidden, so the bars visually collapse away)
 * done         → small soft check fades in, then main's auto-hide takes over
 * error        → small amber "!" + short message, no glitch effects
 * notice       → brief mode-switch flash: plain white mode label, nothing else
 *                (main hides it after ~900ms, same owner as every timer here)
 * meeting      → persistent calm state while the meeting recorder runs: small
 *                red breathing dot + elapsed clock, compact width, NO
 *                waveform (this sits on screen for hours). The clock counts
 *                from state.startedAt so it survives re-assertion — a
 *                dictation mid-meeting takes the pill over as usual, and when
 *                main re-pushes 'meeting' afterwards the elapsed time is
 *                still the true meeting duration, not a reset.
 *
 * Sound cues (WebAudio, synthesized — no assets) fire on state transitions:
 * soft sine pings — gentle two-note up on start, two-note down on stop,
 * single low tap on cancel, low double-tap on error, one tiny high tick on
 * the mode-switch notice. Soft attack, smooth exponential release —
 * polished, not loud/techy.
 * Sound must never break the pill: every audio call is guarded.
 */

import type { LevelFrame, PillState, PillStateName } from '../../shared/types'
import { LEVEL_BINS } from '../../shared/types'
import { formatClock, formatElapsed } from './pill-motion'

// ─── Palette — single source of truth for recoloring ────────────────────────
// (Mirror of the CSS variables in pill.html. Recolor = edit here + :root.)

const PALETTE = {
  bar: 'rgba(255, 255, 255, 0.92)' // waveform bars — plain white, no gradient/glow
} as const

const pill = document.getElementById('pill') as HTMLDivElement
const label = document.getElementById('label') as HTMLDivElement
const timeEl = document.getElementById('time') as HTMLDivElement
const canvas = document.getElementById('wave') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D

// ─── Waveform config ─────────────────────────────────────────────────────────

const NUM_BARS = 16 // fewer, slightly thicker bars — cleaner at this size
const IDLE_LEVEL = 0.07 // resting bar height (fraction of canvas height)
const SMOOTHING = 0.28 // per-frame lerp toward target (60fps → ~80ms settle)
const BAR_WIDTH = 3 // px — Wispr's bars read as soft rounded ticks
const BAR_RADIUS = 1.5

let state: PillStateName = 'idle'
let levels: LevelFrame = new Array(LEVEL_BINS).fill(0)
let bars = new Float32Array(NUM_BARS).fill(IDLE_LEVEL)
let raf = 0
let recordStartAt = 0
let lastTimeText = ''

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

function drawBars(heights: Float32Array): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  ctx.clearRect(0, 0, w, h)

  const slot = w / NUM_BARS
  ctx.fillStyle = PALETTE.bar

  for (let i = 0; i < NUM_BARS; i++) {
    const frac = Math.min(1, Math.max(IDLE_LEVEL, heights[i]))
    const barH = Math.max(BAR_WIDTH, frac * h)
    const x = i * slot + (slot - BAR_WIDTH) / 2
    const y = (h - barH) / 2
    ctx.beginPath()
    ctx.roundRect(x, y, BAR_WIDTH, barH, BAR_RADIUS)
    ctx.fill()
  }
}

// ─── Recording frame (the only canvas-animated state) ───────────────────────

function frameRecording(now: number): void {
  // the shell's width transition (120→180px) resizes the canvas mid-entrance,
  // so re-sync the backing store each frame (no-op once the size is stable)
  setupCanvas()
  for (let i = 0; i < NUM_BARS; i++) {
    // amplitude-driven height with a whisper of drift so the meter still
    // reads "live" — but small enough that silence looks calm and flat,
    // like Wispr (the old design "breathed" visibly during silence)
    const drift = 0.008 * Math.sin(now / 700 + i * 0.9)
    const target = IDLE_LEVEL + sampleLevel(i) * (1 - IDLE_LEVEL) + drift
    bars[i] += (target - bars[i]) * SMOOTHING
  }
  drawBars(bars)

  // dim elapsed counter — textContent touched only when the second ticks
  const t = formatElapsed(now - recordStartAt)
  if (t !== lastTimeText) {
    lastTimeText = t
    timeEl.textContent = t
  }
}

// ─── Animation loop (runs only while recording) ──────────────────────────────

function loop(now: number): void {
  if (state !== 'recording') {
    raf = 0
    return
  }
  frameRecording(now)
  if (raf !== 0) raf = requestAnimationFrame(loop)
}

function startLoop(): void {
  setupCanvas()
  if (raf === 0) raf = requestAnimationFrame(loop)
}

function stopLoop(): void {
  if (raf !== 0) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}

// ─── Meeting clock (interval, not rAF — a once-a-second label needs no 60fps) ─

let meetingStartedAt = 0
let meetingTimer: ReturnType<typeof setInterval> | null = null

function tickMeetingClock(): void {
  timeEl.textContent = formatClock(Date.now() - meetingStartedAt)
}

function startMeetingClock(startedAt: number): void {
  meetingStartedAt = startedAt
  tickMeetingClock() // immediate — no blank/stale second on entry
  if (meetingTimer === null) meetingTimer = setInterval(tickMeetingClock, 500)
}

function stopMeetingClock(): void {
  if (meetingTimer !== null) {
    clearInterval(meetingTimer)
    meetingTimer = null
  }
}

// ─── Sound cues (synthesized, lazy AudioContext, can never throw out) ────────

type CueName = 'start' | 'stop' | 'cancel' | 'error' | 'notice'

let audio: AudioContext | null = null

const CUE_GAIN = 0.2 // clearly audible but polished — soft UI ping, not a blip

/**
 * One short soft tone: sine wave, gentle ~18ms attack, smooth exponential
 * release — the "marimba tap" character. (Linear attack ramp avoids the
 * click that an instant exponential rise from near-zero produces.)
 */
function tone(
  ac: AudioContext,
  freqFrom: number,
  freqTo: number,
  startAt: number,
  durMs: number,
  gain: number
): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freqFrom, startAt)
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), startAt + durMs / 1000)
  g.gain.setValueAtTime(0.0001, startAt)
  g.gain.linearRampToValueAtTime(gain, startAt + 0.018)
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
        // soft two-note "ping up" — "listening"
        tone(audio, 520, 520, t0, 80, CUE_GAIN)
        tone(audio, 660, 660, t0 + 0.09, 100, CUE_GAIN)
        break
      case 'stop':
        // soft two-note "ping down" — "captured"
        tone(audio, 660, 660, t0, 80, CUE_GAIN)
        tone(audio, 520, 520, t0 + 0.09, 110, CUE_GAIN)
        break
      case 'cancel':
        // single low soft tap — "discarded"
        tone(audio, 330, 290, t0, 100, CUE_GAIN * 0.85)
        break
      case 'error':
        // gentle low double-tap — noticeable but never harsh
        tone(audio, 260, 230, t0, 100, CUE_GAIN)
        tone(audio, 220, 195, t0 + 0.12, 110, CUE_GAIN * 0.85)
        break
      case 'notice':
        // single soft high tick — "mode switched"; quieter than start/stop
        tone(audio, 880, 880, t0, 45, 0.12)
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
  // dictation cancelled mid-meeting: the idle push re-asserts 'meeting', so
  // the cancel cue has to fire on that transition too
  if (prev === 'recording' && next === 'meeting') return 'cancel'
  if (next === 'error' && prev !== 'error') return 'error'
  // mode-switch flash ticks on entry only; notice→idle fades out silently
  if (next === 'notice' && prev !== 'notice') return 'notice'
  // meeting start/stop reuse the start/stop cues — but ONLY on the idle
  // edges: done→meeting / transcribing→meeting are re-assertions after a
  // mid-meeting dictation, not a new meeting, and must stay silent.
  if (next === 'meeting' && prev === 'idle') return 'start'
  if (prev === 'meeting' && next === 'idle') return 'stop'
  return null
}

// ─── State rendering ─────────────────────────────────────────────────────────

function render(next: PillState): void {
  const prev = state
  state = next.state

  const cue = cueFor(prev, next.state)
  if (cue) playCue(cue)

  if (next.state === 'idle') {
    stopLoop()
    stopMeetingClock()
    pill.classList.remove('visible')
    // keep last data-state during fade-out so the layout doesn't flicker
    return
  }

  pill.dataset.state = next.state
  // errors and mode notices carry text; every other state is purely visual
  label.textContent =
    next.state === 'error'
      ? next.message || 'something went wrong'
      : next.state === 'notice'
        ? next.message || ''
        : ''

  if (next.state === 'recording') {
    stopMeetingClock() // the shared #time belongs to the dictation counter now
    levels = new Array(LEVEL_BINS).fill(0)
    bars = new Float32Array(NUM_BARS).fill(IDLE_LEVEL)
    recordStartAt = performance.now()
    lastTimeText = ''
    timeEl.textContent = '0:00'
    startLoop()
  } else if (next.state === 'meeting') {
    stopLoop()
    // startedAt rides on the push (see PillState.startedAt) — a re-assert
    // after a mid-meeting dictation resumes the true elapsed time.
    startMeetingClock(next.startedAt ?? Date.now())
  } else {
    // transcribing/done/error are CSS-only (dots / check / bang) — the
    // canvas hides with the state flip, which is the "bars collapse away"
    stopLoop()
    stopMeetingClock()
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

// ─── TTS: speak ZEAL replies via sidecar /tts endpoint ───────────────────────

let ttsAudio: HTMLAudioElement | null = null

window.owenflow.tts.onSpeak(async (text) => {
  try {
    if (ttsAudio) {
      ttsAudio.pause()
      ttsAudio = null
    }
    const res = await fetch('http://127.0.0.1:8484/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    })
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    ttsAudio = new Audio(url)
    ttsAudio.onended = () => {
      URL.revokeObjectURL(url)
      ttsAudio = null
    }
    await ttsAudio.play()
  } catch {
    /* speech is best-effort */
  }
})
