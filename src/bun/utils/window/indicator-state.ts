import type { AppStatus, RecordingIndicatorMode } from '../../../shared/types'

/** The states both native indicators (AppKit and Win32) know how to draw. */
export type IndicatorWireStatus = 'ready' | 'recording' | 'transcribing'

/**
 * Whether the indicator should be on screen (not parked off-screen) for this mode and status.
 *
 * A Live Transcription reports `streaming`. The microphone is live for all of it, so it counts
 * as active exactly like `recording` does.
 */
export function indicatorShouldBeVisible(
  mode: RecordingIndicatorMode,
  status: AppStatus
): boolean {
  if (mode === 'off') return false
  if (mode === 'always') return true
  return status !== 'ready'
}

/**
 * Map an app status onto a state the native indicators draw. Neither helper has a streaming
 * visual, and a Live Transcription is recording from the user's point of view, so it shows the
 * recording ring. Exhaustive so a new `AppStatus` cannot compile without a decision here.
 */
export function indicatorWireStatus(status: AppStatus): IndicatorWireStatus {
  switch (status) {
    case 'ready':
      return 'ready'
    case 'recording':
    case 'streaming':
      return 'recording'
    case 'transcribing':
      return 'transcribing'
  }
}
