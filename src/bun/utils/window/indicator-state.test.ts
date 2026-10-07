/**
 * Recording indicator visibility and the status sent to the native indicators,
 * checked against GitHub issue #1: a Live Transcription (status `streaming`) must
 * show the indicator in `when-active` mode, drawn as `recording`. Pure functions
 * only: no subprocess, filesystem or webview.
 */

import { describe, expect, test } from 'bun:test'
import type { AppStatus, RecordingIndicatorMode } from '../../../shared/types'
import {
  indicatorShouldBeVisible,
  indicatorWireStatus,
} from './indicator-state'

const ALL_STATUSES: AppStatus[] = [
  'ready',
  'recording',
  'transcribing',
  'streaming',
]
const ALL_MODES: RecordingIndicatorMode[] = ['off', 'always', 'when-active']
const WIRE_STATES = ['ready', 'recording', 'transcribing'] as const

describe('indicatorShouldBeVisible', () => {
  describe("mode 'when-active'", () => {
    test('is visible during a Live Transcription (streaming)', () => {
      expect(indicatorShouldBeVisible('when-active', 'streaming')).toBe(true)
    })

    test('is visible while recording (Batch Dictation unchanged)', () => {
      expect(indicatorShouldBeVisible('when-active', 'recording')).toBe(true)
    })

    test('is visible while transcribing (Batch Dictation unchanged)', () => {
      expect(indicatorShouldBeVisible('when-active', 'transcribing')).toBe(true)
    })

    test('is hidden when ready', () => {
      expect(indicatorShouldBeVisible('when-active', 'ready')).toBe(false)
    })
  })

  describe("mode 'off'", () => {
    test.each(ALL_STATUSES)('hides the indicator for status %s', (status) => {
      expect(indicatorShouldBeVisible('off', status)).toBe(false)
    })

    test('hides the indicator even during a Live Transcription', () => {
      expect(indicatorShouldBeVisible('off', 'streaming')).toBe(false)
    })
  })

  describe("mode 'always'", () => {
    test.each(ALL_STATUSES)('shows the indicator for status %s', (status) => {
      expect(indicatorShouldBeVisible('always', status)).toBe(true)
    })

    test('shows the indicator when ready and when streaming', () => {
      expect(indicatorShouldBeVisible('always', 'ready')).toBe(true)
      expect(indicatorShouldBeVisible('always', 'streaming')).toBe(true)
    })
  })

  test('full mode x status matrix', () => {
    const expected: Record<
      RecordingIndicatorMode,
      Record<AppStatus, boolean>
    > = {
      off: {
        ready: false,
        recording: false,
        transcribing: false,
        streaming: false,
      },
      always: {
        ready: true,
        recording: true,
        transcribing: true,
        streaming: true,
      },
      'when-active': {
        ready: false,
        recording: true,
        transcribing: true,
        streaming: true,
      },
    }
    for (const mode of ALL_MODES) {
      for (const status of ALL_STATUSES) {
        expect({
          mode,
          status,
          visible: indicatorShouldBeVisible(mode, status),
        }).toEqual({
          mode,
          status,
          visible: expected[mode][status],
        })
      }
    }
  })

  test('returns a boolean for every combination', () => {
    for (const mode of ALL_MODES) {
      for (const status of ALL_STATUSES) {
        expect(typeof indicatorShouldBeVisible(mode, status)).toBe('boolean')
      }
    }
  })
})

describe('indicatorWireStatus', () => {
  test("streaming is drawn as 'recording'", () => {
    expect(indicatorWireStatus('streaming')).toBe('recording')
  })

  test("ready maps to 'ready'", () => {
    expect(indicatorWireStatus('ready')).toBe('ready')
  })

  test("recording maps to 'recording'", () => {
    expect(indicatorWireStatus('recording')).toBe('recording')
  })

  test("transcribing maps to 'transcribing'", () => {
    expect(indicatorWireStatus('transcribing')).toBe('transcribing')
  })

  test.each(ALL_STATUSES)(
    'status %s maps to one of the three wire states',
    (status) => {
      expect(WIRE_STATES as readonly string[]).toContain(
        indicatorWireStatus(status)
      )
    }
  )

  test('never sends streaming over the wire', () => {
    for (const status of ALL_STATUSES) {
      expect(indicatorWireStatus(status)).not.toBe('streaming' as never)
    }
  })

  test('is a pure function: repeated calls give the same answer', () => {
    for (const status of ALL_STATUSES) {
      expect(indicatorWireStatus(status)).toBe(indicatorWireStatus(status))
    }
  })
})
