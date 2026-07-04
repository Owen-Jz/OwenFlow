/**
 * Hidden recorder window.
 *
 * On "recorder:start": captures raw Float32 PCM at 16kHz mono from the mic
 * (AudioContext resamples for us).
 * On "recorder:stop": encodes a 16-bit PCM WAV and replies via
 * "recorder:data" with the WAV as an ArrayBuffer.
 *
 * Segment streaming (BOTH modes): natural pauses flush the audio captured so
 * far as "recorder:segment" WAVs so main can transcribe them while the user
 * is still talking. Continuous mode pastes per segment (continuous-channel);
 * normal hold mode only PRE-transcribes them (pipeline/pretranscribe) and the
 * final "recorder:data" reply carries just the remainder since the last
 * flush — so stop→paste no longer pays for transcribing the whole take.
 * Normal mode uses a min-segment floor so tiny dictations stay one piece.
 *
 * Warm-mic design (anti word-clipping): getUserMedia + AudioContext setup
 * takes 200-500ms, which used to eat the first word of every dictation. The
 * stream is now acquired on first use and kept WARM for WARM_IDLE_MS after a
 * dictation ends, so back-to-back dictations start capturing instantly.
 * While warm-but-idle, audio callbacks feed only a tiny PREROLL_MS ring
 * buffer (see preroll.ts) that is prepended to the next capture — covering
 * even the sub-frame gap between hotkey press and recording flag flip. On
 * stop, capture keeps running for TAIL_MS before finalizing so the last
 * syllable (still in the air when the key is released) isn't clipped either.
 */

import { LEVEL_BINS } from '../../shared/types'
import { shouldFlush, type SegmentState } from './segmenter'
import { PrerollBuffer } from './preroll'

const TARGET_SAMPLE_RATE = 16000
const LEVEL_INTERVAL_MS = 50
const SILENCE_MS = 700
const MAX_SEGMENT_MS = 15000
const SPEECH_LEVEL = 0.06
/**
 * Normal (one-shot) mode only: don't pause-flush a segment shorter than this.
 * Short dictations gain nothing from pre-transcription (the final transcribe
 * is already fast) and every extra boundary is a small accuracy risk — so
 * only rambles long enough to amortize it get segmented. Continuous mode
 * keeps its original floorless behavior.
 */
const NORMAL_MIN_SEGMENT_MS = 3000

/** Rolling pre-roll kept while the warm stream is idle (~350ms of audio). */
const PREROLL_MS = 350
/** Extra audio captured after "stop" so the trailing syllable survives. */
const TAIL_MS = 250
/** How long the mic stream stays warm after a dictation before release. */
const WARM_IDLE_MS = 60000

let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let processorNode: ScriptProcessorNode | null = null
let analyserNode: AnalyserNode | null = null
let levelTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let chunks: Float32Array[] = []
let recording = false
/** True during the TAIL_MS window between stop and finalize. */
let stopping = false
let continuous = false
let seg: SegmentState = { hasSpeech: false, silenceMs: 0, segmentMs: 0 }
const preroll = new PrerollBuffer((TARGET_SAMPLE_RATE * PREROLL_MS) / 1000)

function resetSeg(): void {
  seg = { hasSpeech: false, silenceMs: 0, segmentMs: 0 }
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/** After a dictation, keep the stream warm for a while, then release it. */
function scheduleIdleRelease(): void {
  clearIdleTimer()
  idleTimer = setTimeout(() => {
    if (!recording && !stopping) releaseResources()
  }, WARM_IDLE_MS)
}

/**
 * Is the warm stream still usable? Devices disappear (USB mic unplugged,
 * Windows default-device switch kills tracks) and Chromium can close a
 * context — any of that means fall back to a fresh acquisition.
 */
function streamIsHealthy(): boolean {
  return (
    mediaStream !== null &&
    audioContext !== null &&
    audioContext.state !== 'closed' &&
    mediaStream.getAudioTracks().length > 0 &&
    mediaStream.getAudioTracks().every((t) => t.readyState === 'live')
  )
}

/** Open the mic and build the capture graph (the expensive 200-500ms part). */
async function acquireStream(): Promise<void> {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  })

  // If the device dies while idle, release now so the next start reacquires
  // fresh instead of reusing a dead stream. Mid-recording we keep what we
  // captured — stop() will still finalize the partial WAV.
  for (const track of mediaStream.getTracks()) {
    track.onended = (): void => {
      if (!recording && !stopping) releaseResources()
    }
  }

  audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
  await audioContext.resume()

  sourceNode = audioContext.createMediaStreamSource(mediaStream)
  // ScriptProcessor is deprecated but dependency-free and fine for v1;
  // swap for an AudioWorklet later if CPU usage matters.
  processorNode = audioContext.createScriptProcessor(4096, 1, 1)

  processorNode.onaudioprocess = (event: AudioProcessingEvent): void => {
    const input = event.inputBuffer.getChannelData(0)
    if (recording) {
      chunks.push(new Float32Array(input)) // copy — buffer is reused
    } else {
      // Warm-idle: keep only the cheap rolling pre-roll (bounded memory).
      preroll.push(new Float32Array(input))
    }
  }

  sourceNode.connect(processorNode)
  // ScriptProcessor needs a destination connection to fire in Chromium.
  processorNode.connect(audioContext.destination)

  // Analyser tap for the live waveform pill (parallel branch, no audio path).
  analyserNode = audioContext.createAnalyser()
  analyserNode.fftSize = 64 // 32 frequency bins at 16kHz (250Hz each)
  analyserNode.smoothingTimeConstant = 0.55
  sourceNode.connect(analyserNode)
}

async function startCapture(cont: boolean): Promise<void> {
  // `stopping` also gates: a start landing inside another dictation's tail
  // window would corrupt that capture (mirrors the old `recording` guard).
  if (recording || stopping) return
  continuous = cont
  resetSeg()
  clearIdleTimer()
  try {
    if (!streamIsHealthy()) {
      releaseResources() // drop any half-dead remnants before reacquiring
      await acquireStream()
    } else {
      // Chromium may suspend an idle context to save power — cheap no-op if
      // it's already running.
      await audioContext!.resume()
    }

    // Seed the capture with the warm pre-roll so audio from just BEFORE the
    // hotkey press (and the start-handling gap) is included. Fresh
    // acquisitions drain an empty buffer — harmless.
    chunks = preroll.drain()
    recording = true
    startLevelEmitter(analyserNode!)
  } catch (err) {
    recording = false
    releaseResources()
    window.owenflow.recorder.sendError(
      err instanceof Error ? `Mic capture failed: ${err.message}` : 'Mic capture failed'
    )
  }
}

function flushSegment(): void {
  if (chunks.length === 0) return
  const sampleRate = audioContext?.sampleRate ?? TARGET_SAMPLE_RATE
  const samples = concat(chunks)
  chunks = []
  resetSeg()
  window.owenflow.recorder.sendSegment(encodeWav(samples, sampleRate))
}

function stopCapture(): void {
  if (stopping) return // finalize already pending; it will reply
  if (!recording) {
    // stop without start (or failed start): reply with an empty WAV so main
    // doesn't hang waiting on recorder:data (normal mode only).
    if (!continuous) {
      window.owenflow.recorder.sendData(encodeWav(new Float32Array(0), TARGET_SAMPLE_RATE))
    } else {
      window.owenflow.recorder.sendDone()
    }
    return
  }

  // Keep capturing for a short tail before finalizing — the user releases
  // the key while the last syllable is still in the air. Main's stop timeout
  // is 5s, so this small delay is safely inside it.
  stopping = true
  setTimeout(finalizeCapture, TAIL_MS)
}

/** Tail elapsed: cut the recording, ship the WAV, and enter the warm-idle state. */
function finalizeCapture(): void {
  recording = false
  stopping = false
  stopLevelEmitter()

  if (continuous) {
    flushSegment()
    window.owenflow.recorder.sendDone()
  } else {
    // Normal mode: recorder:data carries the FINAL remainder — everything
    // captured since the last pause-flush (or the whole take when no segment
    // was flushed, i.e. short dictations behave exactly as before). Renderer
    // IPC is ordered, so main always sees every recorder:segment before this.
    const sampleRate = audioContext?.sampleRate ?? TARGET_SAMPLE_RATE
    const samples = concat(chunks)
    chunks = []
    resetSeg()
    window.owenflow.recorder.sendData(encodeWav(samples, sampleRate))
  }

  // Stay warm: the stream keeps feeding the pre-roll ring (started fresh so
  // stale tail audio never leaks into the next dictation's pre-roll).
  preroll.clear()
  scheduleIdleRelease()
}

/**
 * Every LEVEL_INTERVAL_MS while recording: compress the analyser's frequency
 * data into LEVEL_BINS values 0..1 and send them via "recorder:level".
 */
function startLevelEmitter(analyser: AnalyserNode): void {
  stopLevelEmitter()
  const freq = new Uint8Array(analyser.frequencyBinCount)
  // Top quarter of the spectrum (6-8kHz) carries almost no voice energy — drop it.
  const usable = Math.floor(freq.length * 0.75)
  const step = usable / LEVEL_BINS
  levelTimer = setInterval(() => {
    if (!recording) return
    analyser.getByteFrequencyData(freq)
    const frame: number[] = new Array(LEVEL_BINS)
    for (let i = 0; i < LEVEL_BINS; i++) {
      const from = Math.floor(i * step)
      const to = Math.max(from + 1, Math.floor((i + 1) * step))
      let sum = 0
      for (let j = from; j < to; j++) sum += freq[j]
      frame[i] = Math.round((sum / (to - from) / 255) * 1000) / 1000
    }
    window.owenflow.recorder.sendLevel(frame)
    // Pause segmentation runs in BOTH modes now: continuous streams segments
    // for per-segment paste, normal streams them for background
    // pre-transcription (normal adds the min-segment floor — see the const).
    const peak = Math.max(...frame)
    const speaking = peak >= SPEECH_LEVEL
    seg.segmentMs += LEVEL_INTERVAL_MS
    if (speaking) {
      seg.hasSpeech = true
      seg.silenceMs = 0
    } else {
      seg.silenceMs += LEVEL_INTERVAL_MS
    }
    if (shouldFlush(seg, SILENCE_MS, MAX_SEGMENT_MS, continuous ? 0 : NORMAL_MIN_SEGMENT_MS)) {
      flushSegment()
    }
  }, LEVEL_INTERVAL_MS)
}

function stopLevelEmitter(): void {
  if (levelTimer !== null) {
    clearInterval(levelTimer)
    levelTimer = null
  }
}

function releaseResources(): void {
  stopLevelEmitter()
  clearIdleTimer()
  preroll.clear()
  try {
    analyserNode?.disconnect()
    processorNode?.disconnect()
    sourceNode?.disconnect()
    mediaStream?.getTracks().forEach((t) => t.stop())
    void audioContext?.close()
  } catch {
    /* best effort */
  }
  analyserNode = null
  processorNode = null
  sourceNode = null
  mediaStream = null
  audioContext = null
}

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

window.owenflow.recorder.onStart((cont) => {
  void startCapture(cont)
})
window.owenflow.recorder.onStop(() => {
  stopCapture()
})
