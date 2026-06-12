/**
 * Pill overlay renderer. Pure state display driven by "pill:state" pushes
 * from the main process. Auto-hide timing is owned by main (pipeline.ts);
 * this renderer only animates in/out.
 *
 * recording    → live canvas waveform driven by "recorder:level" frames
 * transcribing → indeterminate violet shimmer/scan over collapsed bars
 * done         → green check pop (CSS)
 * error        → short monospace message
 */

import type { LevelFrame, PillState, PillStateName } from '../../shared/types'
import { LEVEL_BINS } from '../../shared/types'

const pill = document.getElementById('pill') as HTMLDivElement
const label = document.getElementById('label') as HTMLDivElement
const canvas = document.getElementById('wave') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D

// ─── Waveform config ─────────────────────────────────────────────────────────

const NUM_BARS = 24
const IDLE_LEVEL = 0.09 // resting bar height (fraction of canvas height)
const SMOOTHING = 0.28 // per-frame lerp toward target (60fps → ~80ms settle)

const VIOLET = '#8b5cf6'
const BLUE = '#3b82f6'

let state: PillStateName = 'idle'
let levels: LevelFrame = new Array(LEVEL_BINS).fill(0)
let bars = new Float32Array(NUM_BARS).fill(IDLE_LEVEL)
let raf = 0

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
  g.addColorStop(0, VIOLET)
  g.addColorStop(1, BLUE)
  return g
}

function drawBars(heights: Float32Array, alphas: Float32Array | null, now: number): void {
  void now
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  ctx.clearRect(0, 0, w, h)

  const slot = w / NUM_BARS
  const barW = Math.max(2, slot * 0.5)
  const radius = barW / 2

  ctx.fillStyle = barGradient(w)
  ctx.shadowColor = 'rgba(139, 92, 246, 0.55)'
  ctx.shadowBlur = 5

  for (let i = 0; i < NUM_BARS; i++) {
    const frac = Math.min(1, Math.max(IDLE_LEVEL, heights[i]))
    const barH = Math.max(barW, frac * h)
    const x = i * slot + (slot - barW) / 2
    const y = (h - barH) / 2
    ctx.globalAlpha = alphas ? alphas[i] : 1
    ctx.beginPath()
    ctx.roundRect(x, y, barW, barH, radius)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// ─── Per-state frames ────────────────────────────────────────────────────────

function frameRecording(now: number): void {
  for (let i = 0; i < NUM_BARS; i++) {
    // amplitude-driven height + a whisper of motion so idle never looks frozen
    const wobble = 0.02 * Math.sin(now / 320 + i * 0.9)
    const target = IDLE_LEVEL + sampleLevel(i) * (1 - IDLE_LEVEL) + wobble
    bars[i] += (target - bars[i]) * SMOOTHING
  }
  drawBars(bars, null, now)
}

const scanAlphas = new Float32Array(NUM_BARS)
const scanHeights = new Float32Array(NUM_BARS)

function frameTranscribing(now: number): void {
  // bars collapse low; a bright pulse sweeps left→right (indeterminate scan)
  const scanPos = ((now / 1100) % 1) * (NUM_BARS + 8) - 4
  for (let i = 0; i < NUM_BARS; i++) {
    const d = i - scanPos
    const pulse = Math.exp((-d * d) / 7)
    const target = IDLE_LEVEL + pulse * 0.32
    bars[i] += (target - bars[i]) * SMOOTHING
    scanHeights[i] = bars[i]
    scanAlphas[i] = 0.3 + pulse * 0.7
  }
  drawBars(scanHeights, scanAlphas, now)
}

// ─── Animation loop (runs only while pill is visible in an animated state) ──

function loop(now: number): void {
  if (state === 'recording') frameRecording(now)
  else if (state === 'transcribing') frameTranscribing(now)
  else {
    raf = 0
    return
  }
  raf = requestAnimationFrame(loop)
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

// ─── State rendering ─────────────────────────────────────────────────────────

function render(next: PillState): void {
  state = next.state

  if (next.state === 'idle') {
    stopLoop()
    pill.classList.remove('visible')
    // keep last data-state during fade-out so the layout doesn't flicker
    return
  }

  pill.dataset.state = next.state
  // errors stay readable; every other state is purely visual
  label.textContent = next.state === 'error' ? next.message || 'something went wrong' : ''

  if (next.state === 'recording' || next.state === 'transcribing') {
    if (next.state === 'recording') {
      levels = new Array(LEVEL_BINS).fill(0)
      bars = new Float32Array(NUM_BARS).fill(IDLE_LEVEL)
    }
    startLoop()
  } else {
    stopLoop()
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
