/**
 * The one decision inside automatic Parakeet warmup that is worth pinning: whether a
 * selection has just made a preparation worth spawning.
 *
 * The rest of the module is lifecycle glue - a promise handle, a settings push, a bounded
 * wait - and tests over glue only restate the glue. This function is the seam ADR-0005 cares
 * about, because it is the thing that used to be written out three times, slightly
 * differently, at boot, at a settings write and after a download.
 */

import { describe, expect, test } from 'bun:test'
import {
  createSilentWav,
  PARAKEET_WARMUP_SECONDS,
  shouldStartParakeetWarmup,
  type ParakeetWarmupState,
} from './parakeet-warmup'

/** Parakeet selected, weights on disk, cold, nothing running: the case that should warm. */
function state(
  overrides: Partial<ParakeetWarmupState> = {}
): ParakeetWarmupState {
  return {
    selectedEngineId: 'whisperkit',
    weightsInstalled: true,
    helperSupported: true,
    alreadyPrepared: false,
    preparationInFlight: false,
    previousAttemptFailed: false,
    ...overrides,
  }
}

describe('shouldStartParakeetWarmup', () => {
  test('selecting Parakeet with its weights installed starts a preparation', () => {
    expect(shouldStartParakeetWarmup(state())).toBe(true)
  })

  test('a Whisper or hviske selection never warms Parakeet', () => {
    expect(
      shouldStartParakeetWarmup(state({ selectedEngineId: 'whisper_cpp' }))
    ).toBe(false)
    expect(
      shouldStartParakeetWarmup(state({ selectedEngineId: 'hviske' }))
    ).toBe(false)
  })

  test('a selection the catalog has never heard of never warms Parakeet', () => {
    expect(shouldStartParakeetWarmup(state({ selectedEngineId: null }))).toBe(
      false
    )
  })

  test('nothing is warmed where the Native Helper does not ship', () => {
    expect(shouldStartParakeetWarmup(state({ helperSupported: false }))).toBe(
      false
    )
  })

  test('weights that are not on disk cannot be prepared', () => {
    expect(shouldStartParakeetWarmup(state({ weightsInstalled: false }))).toBe(
      false
    )
  })

  test('an already prepared Parakeet is not prepared again', () => {
    expect(shouldStartParakeetWarmup(state({ alreadyPrepared: true }))).toBe(
      false
    )
  })

  /**
   * The concurrency rule. Boot, a settings write and a finished download can all want a
   * preparation within the same second, and two compiles of the same weights race each other.
   */
  test('a preparation already running is joined, not duplicated', () => {
    expect(
      shouldStartParakeetWarmup(state({ preparationInFlight: true }))
    ).toBe(false)
  })

  /**
   * Settings writes are frequent - every language, duration and toggle change is one - so a
   * broken helper must not be respawned by each of them.
   */
  test('a preparation that already failed is not retried in this process', () => {
    expect(
      shouldStartParakeetWarmup(state({ previousAttemptFailed: true }))
    ).toBe(false)
  })
})

/**
 * Issue #3: FluidAudio rejects audio shorter than one second at 16 kHz with
 * `invalidAudioData`, so the warmup clip has to be a complete, valid WAV of at least one
 * second of silence.
 */
describe('createSilentWav', () => {
  const HEADER_BYTES = 44
  const SAMPLE_RATE = 16000
  const BYTE_RATE = 32000

  function view(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  function ascii(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + 4))
  }

  test('returns a Uint8Array at least as long as the canonical header', () => {
    const wav = createSilentWav()
    expect(wav).toBeInstanceOf(Uint8Array)
    expect(wav.byteLength).toBeGreaterThan(HEADER_BYTES)
  })

  test('has the RIFF/WAVE/fmt /data chunk tags at canonical offsets', () => {
    const wav = createSilentWav()
    expect(ascii(wav, 0)).toBe('RIFF')
    expect(ascii(wav, 8)).toBe('WAVE')
    expect(ascii(wav, 12)).toBe('fmt ')
    expect(ascii(wav, 36)).toBe('data')
  })

  test('RIFF chunk size is total length minus 8 (little-endian)', () => {
    const wav = createSilentWav()
    expect(view(wav).getUint32(4, true)).toBe(wav.byteLength - 8)
  })

  test('fmt chunk describes 16 kHz mono 16-bit PCM', () => {
    const dv = view(createSilentWav())
    expect(dv.getUint32(16, true)).toBe(16)
    expect(dv.getUint16(20, true)).toBe(1)
    expect(dv.getUint16(22, true)).toBe(1)
    expect(dv.getUint32(24, true)).toBe(SAMPLE_RATE)
    expect(dv.getUint32(28, true)).toBe(BYTE_RATE)
    expect(dv.getUint16(32, true)).toBe(2)
    expect(dv.getUint16(34, true)).toBe(16)
  })

  test('total length is the 44-byte header plus the declared data size', () => {
    const wav = createSilentWav()
    const dataSize = view(wav).getUint32(40, true)
    expect(wav.byteLength).toBe(HEADER_BYTES + dataSize)
  })

  test('every sample byte is zero (silence)', () => {
    const wav = createSilentWav()
    const data = wav.subarray(HEADER_BYTES)
    expect(data.byteLength).toBeGreaterThan(0)
    expect(data.every((byte) => byte === 0)).toBe(true)
  })

  test('PARAKEET_WARMUP_SECONDS is at least one second', () => {
    expect(PARAKEET_WARMUP_SECONDS).toBeGreaterThanOrEqual(1)
  })

  test('duration from the header equals PARAKEET_WARMUP_SECONDS and is >= 1s', () => {
    const dv = view(createSilentWav())
    const dataSize = dv.getUint32(40, true)
    const byteRate = dv.getUint32(28, true)
    const seconds = dataSize / byteRate
    expect(seconds).toBe(PARAKEET_WARMUP_SECONDS)
    expect(seconds).toBeGreaterThanOrEqual(1)
  })

  test('duration from the buffer length equals PARAKEET_WARMUP_SECONDS (>= 16000 samples)', () => {
    const wav = createSilentWav()
    const sampleBytes = wav.byteLength - HEADER_BYTES
    const samples = sampleBytes / 2
    expect(Number.isInteger(samples)).toBe(true)
    expect(samples).toBeGreaterThanOrEqual(SAMPLE_RATE)
    expect(sampleBytes / BYTE_RATE).toBe(PARAKEET_WARMUP_SECONDS)
  })
})
