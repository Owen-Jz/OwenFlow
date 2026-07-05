/**
 * Hidden meeting-capture window.
 *
 * On "meeting:capture:start": opens TWO capture streams —
 *   'you'  — the microphone (getUserMedia, same constraints as the dictation
 *            recorder so echo cancellation subtracts the speakers' meeting
 *            audio from the mic pickup)
 *   'them' — Windows loopback / system audio via getDisplayMedia: main's
 *            setDisplayMediaRequestHandler (windows.ts) answers with a screen
 *            source + audio:'loopback' (Electron 39 / Windows), and the
 *            mandatory video track is stopped here immediately — only the
 *            audio (whatever plays on the output device: Meet/Zoom/Slack)
 *            is kept.
 *
 * Both streams run through one 16kHz AudioContext (it resamples for us) into
 * per-stream ScriptProcessors. Segmentation is silence-aware like the
 * dictation recorder (segmenter.ts shouldFlush) with a harder 20s cap; each
 * flushed segment is WAV-encoded and shipped to main via "meeting:segment"
 * with its stream tag + start time, then DROPPED — the 3-hour memory
 * contract: at any moment this window holds at most ~20s of Float32 audio
 * per stream, never the meeting.
 *
 * Long-silence pruning: shouldFlush only fires after speech, so a muted mic
 * or a silent call would otherwise accumulate chunks without bound. When a
 * speechless segment outgrows the cap its audio is discarded down to a short
 * onset tail (so the first word after the silence isn't clipped).
 *
 * On "meeting:capture:stop": flush both remainders (speech only), release
 * every track, then reply "meeting:capture:stopped" — main counts on ordered
 * IPC here: all flush segments land before the stopped signal.
 *
 * This is a SEPARATE window/module from recorder.ts on purpose: normal
 * dictation must keep working untouched mid-meeting (Chromium happily hands
 * the same mic to both windows), so nothing here is shared with the
 * dictation capture path except the pure shouldFlush decision.
 */

import type { MeetingStream } from '../../shared/types'
import { shouldFlush, type SegmentState } from './segmenter'

const TARGET_SAMPLE_RATE = 16000
/** A real pause: same threshold the dictation recorder uses. */
const SILENCE_MS = 700
/** Hard cap per segment — bounds both memory and transcription latency. */
const MAX_SEGMENT_MS = 20_000
/**
 * Floor on pause-triggered flushes: meeting speech is bursty ("yeah", "mm")
 * and sub-1.5s segments are all boundary risk for no transcript gain.
 */
const MIN_SEGMENT_MS = 1500
/**
 * Speech threshold on per-block peak amplitude (0..1). The dictation
 * recorder thresholds analyser frequency magnitudes instead; here the raw
 * PCM peak is cheaper (no analyser per stream) and 0.03 clears keyboard/fan
 * noise while catching quiet far-end speakers.
 */
const SPEECH_LEVEL = 0.03
/** Audio kept as onset guard when a long speechless stretch is pruned (ms). */
const SILENCE_TAIL_MS = 350

/** Per-stream capture state — 'you' and 'them' are fully independent. */
interface StreamState {
  name: MeetingStream
  chunks: Float32Array[]
  seg: SegmentState
  /** Epoch ms when the current segment's first chunk landed. */
  segStartedAt: number
  processor: ScriptProcessorNode | null
  source: MediaStreamAudioSourceNode | null
  media: MediaStream | null
}

let audioContext: AudioContext | null = null
let capturing = false
const streams: Record<MeetingStream, StreamState> = {
  you: emptyState('you'),
  them: emptyState('them')
}

function emptyState(name: MeetingStream): StreamState {
  return {
    name,
    chunks: [],
    seg: { hasSpeech: false, silenceMs: 0, segmentMs: 0 },
    segStartedAt: 0,
    processor: null,
    source: null,
    media: null
  }
}

function resetSeg(state: StreamState): void {
  state.seg = { hasSpeech: false, silenceMs: 0, segmentMs: 0 }
}

// ─── Capture graph ───────────────────────────────────────────────────────────

/** Wire one MediaStream into the shared 16kHz context with its own processor. */
function wireStream(ctx: AudioContext, state: StreamState, media: MediaStream): void {
  state.media = media
  state.source = ctx.createMediaStreamSource(media)
  // ScriptProcessor is deprecated but dependency-free — same v1 tradeoff as
  // the dictation recorder. 4096 frames at 16kHz = 256ms per callback.
  state.processor = ctx.createScriptProcessor(4096, 1, 1)

  state.processor.onaudioprocess = (event: AudioProcessingEvent): void => {
    if (!capturing) return
    const input = event.inputBuffer.getChannelData(0)
    if (state.chunks.length === 0) state.segStartedAt = Date.now()
    state.chunks.push(new Float32Array(input)) // copy — buffer is reused

    // Segmentation bookkeeping straight off the PCM block (no analyser).
    const blockMs = (input.length / ctx.sampleRate) * 1000
    let peak = 0
    for (let i = 0; i < input.length; i++) {
      const v = Math.abs(input[i])
      if (v > peak) peak = v
    }
    state.seg.segmentMs += blockMs
    if (peak >= SPEECH_LEVEL) {
      state.seg.hasSpeech = true
      state.seg.silenceMs = 0
    } else {
      state.seg.silenceMs += blockMs
    }

    if (shouldFlush(state.seg, SILENCE_MS, MAX_SEGMENT_MS, MIN_SEGMENT_MS)) {
      flushSegment(state)
    } else if (!state.seg.hasSpeech && state.seg.segmentMs >= MAX_SEGMENT_MS) {
      // Speechless stretch outgrew the cap (muted mic / silent call): discard
      // the audio — transcribing silence is waste, and holding it would grow
      // memory without bound over a 3h meeting. Keep a short onset tail so
      // the first word after the silence isn't clipped.
      pruneSilence(state, ctx.sampleRate)
    }
  }

  state.source.connect(state.processor)
  // ScriptProcessor needs a destination connection to fire in Chromium.
  state.processor.connect(ctx.destination)
}

/** Encode + ship the current segment, then drop it (the memory bound). */
function flushSegment(state: StreamState): void {
  if (state.chunks.length === 0 || !state.seg.hasSpeech) {
    // Nothing worth transcribing — a stop-flush on a silent remainder.
    state.chunks = []
    resetSeg(state)
    return
  }
  const sampleRate = audioContext?.sampleRate ?? TARGET_SAMPLE_RATE
  const samples = concat(state.chunks)
  const startedAt = state.segStartedAt
  state.chunks = []
  resetSeg(state)
  window.owenflow.meetingCapture.sendSegment(encodeWav(samples, sampleRate), state.name, startedAt)
}

/** Drop accumulated silence, keeping only the last SILENCE_TAIL_MS as onset guard. */
function pruneSilence(state: StreamState, sampleRate: number): void {
  const keepSamples = Math.floor((sampleRate * SILENCE_TAIL_MS) / 1000)
  const tail: Float32Array[] = []
  let kept = 0
  for (let i = state.chunks.length - 1; i >= 0 && kept < keepSamples; i--) {
    tail.unshift(state.chunks[i])
    kept += state.chunks[i].length
  }
  state.chunks = tail
  resetSeg(state)
  state.seg.segmentMs = (kept / sampleRate) * 1000
  state.segStartedAt = Date.now() - state.seg.segmentMs
}

// ─── Start / stop ────────────────────────────────────────────────────────────

async function startCapture(): Promise<void> {
  if (capturing) return
  try {
    // Mic first (fails fast on denied permission). Echo cancellation matters
    // doubly here: the meeting plays on the speakers, and AEC keeps that
    // far-end audio out of the 'you' stream (loopback already captures it).
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })

    // Loopback: main's display-media handler answers with audio:'loopback'
    // (+ a mandatory screen video source we stop right away — audio only).
    let sys: MediaStream
    try {
      sys = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    } catch (err) {
      mic.getTracks().forEach((t) => t.stop())
      throw new Error(
        `System-audio loopback failed: ${err instanceof Error ? err.message : 'denied'}`
      )
    }
    sys.getVideoTracks().forEach((t) => {
      t.stop()
      sys.removeTrack(t)
    })

    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    await audioContext.resume()

    streams.you = emptyState('you')
    streams.them = emptyState('them')
    wireStream(audioContext, streams.you, mic)
    wireStream(audioContext, streams.them, sys)

    // A device dying mid-meeting (USB mic unplugged, output device switch)
    // ends capture — main turns the error into a clean meeting stop.
    for (const track of [...mic.getAudioTracks(), ...sys.getAudioTracks()]) {
      track.onended = (): void => {
        if (!capturing) return
        stopCapture(false)
        window.owenflow.meetingCapture.sendError('Meeting audio device lost')
      }
    }

    capturing = true
  } catch (err) {
    releaseResources()
    window.owenflow.meetingCapture.sendError(
      err instanceof Error ? `Meeting capture failed: ${err.message}` : 'Meeting capture failed'
    )
  }
}

/**
 * Stop capture: flush both remainders (segments land in main BEFORE the
 * stopped signal — ordered IPC), release everything, then acknowledge.
 * `acknowledge:false` is the device-lost path, which sends an error instead.
 */
function stopCapture(acknowledge = true): void {
  if (capturing) {
    capturing = false
    flushSegment(streams.you)
    flushSegment(streams.them)
  }
  releaseResources()
  if (acknowledge) window.owenflow.meetingCapture.sendStopped()
}

function releaseResources(): void {
  for (const state of [streams.you, streams.them]) {
    try {
      state.processor?.disconnect()
      state.source?.disconnect()
      state.media?.getTracks().forEach((t) => t.stop())
    } catch {
      /* best effort */
    }
    state.processor = null
    state.source = null
    state.media = null
    state.chunks = []
    resetSeg(state)
  }
  try {
    void audioContext?.close()
  } catch {
    /* best effort */
  }
  audioContext = null
}

// ─── PCM helpers (mirrored from recorder.ts, which stays untouched) ─────────

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Encode Float32 samples as a 16-bit PCM mono WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += bytesPerSample
  }

  return buffer
}

window.owenflow.meetingCapture.onStart(() => {
  void startCapture()
})
window.owenflow.meetingCapture.onStop(() => {
  stopCapture()
})
