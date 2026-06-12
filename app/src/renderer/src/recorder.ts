/**
 * Hidden recorder window.
 *
 * On "recorder:start": opens the mic via getUserMedia and captures raw
 * Float32 PCM at 16kHz mono (AudioContext resamples for us).
 * On "recorder:stop": encodes a 16-bit PCM WAV and replies via
 * "recorder:data" with the WAV as an ArrayBuffer.
 */

import { LEVEL_BINS } from '../../shared/types'

const TARGET_SAMPLE_RATE = 16000
const LEVEL_INTERVAL_MS = 50

let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let processorNode: ScriptProcessorNode | null = null
let analyserNode: AnalyserNode | null = null
let levelTimer: ReturnType<typeof setInterval> | null = null
let chunks: Float32Array[] = []
let recording = false

async function startCapture(): Promise<void> {
  if (recording) return
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })

    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    await audioContext.resume()

    sourceNode = audioContext.createMediaStreamSource(mediaStream)
    // ScriptProcessor is deprecated but dependency-free and fine for v1;
    // swap for an AudioWorklet later if CPU usage matters.
    processorNode = audioContext.createScriptProcessor(4096, 1, 1)
    chunks = []
    recording = true

    processorNode.onaudioprocess = (event: AudioProcessingEvent): void => {
      if (!recording) return
      const input = event.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(input)) // copy — buffer is reused
    }

    sourceNode.connect(processorNode)
    // ScriptProcessor needs a destination connection to fire in Chromium.
    processorNode.connect(audioContext.destination)

    // Analyser tap for the live waveform pill (parallel branch, no audio path).
    analyserNode = audioContext.createAnalyser()
    analyserNode.fftSize = 64 // 32 frequency bins at 16kHz (250Hz each)
    analyserNode.smoothingTimeConstant = 0.55
    sourceNode.connect(analyserNode)
    startLevelEmitter(analyserNode)
  } catch (err) {
    recording = false
    releaseResources()
    window.owenflow.recorder.sendError(
      err instanceof Error ? `Mic capture failed: ${err.message}` : 'Mic capture failed'
    )
  }
}

function stopCapture(): void {
  if (!recording && chunks.length === 0) {
    // stop without start (or failed start): reply with an empty WAV so main
    // doesn't hang waiting on recorder:data.
    window.owenflow.recorder.sendData(encodeWav(new Float32Array(0), TARGET_SAMPLE_RATE))
    return
  }
  recording = false

  const sampleRate = audioContext?.sampleRate ?? TARGET_SAMPLE_RATE
  const samples = concat(chunks)
  chunks = []
  releaseResources()

  window.owenflow.recorder.sendData(encodeWav(samples, sampleRate))
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

window.owenflow.recorder.onStart(() => {
  void startCapture()
})
window.owenflow.recorder.onStop(() => {
  stopCapture()
})
