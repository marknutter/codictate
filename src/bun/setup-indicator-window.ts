import { Screen, type Display } from 'electrobun/bun'
import type {
  AppSettings,
  AppStatus,
  RecordingIndicatorMode,
} from '../shared/types'
import { indicatorShouldBeVisible } from './utils/window/indicator-state'
import {
  createNativeIndicatorHelper,
  type NativeIndicatorHelper,
} from './utils/window/native-indicator-helper'
import {
  EMPTY_STAGING_OVERLAY_TEXT,
  shapeStagingOverlayText,
  stagingOverlayTextEquals,
  stagingOverlayTextIsEmpty,
  type LiveTranscriptUpdate,
  type StagingOverlayText,
} from './utils/window/staging-overlay-text'

/** Window frame around the circular HUD (56px circle + padding). */
const INDICATOR_FRAME_PX = 72

/**
 * Minimum gap between two Staging Overlay `text` commands: at most 20 per second. Parakeet
 * can emit partials faster than that; the latest one wins and the ones in between are
 * dropped, because each one replaces the last.
 */
export const STAGING_OVERLAY_MIN_INTERVAL_MS = 50

export type IndicatorWindowHandle = {
  onAppStatus: (status: AppStatus) => void
  /**
   * The running transcript of a Live Transcription changed. Shown in the Staging Overlay
   * while the status is `streaming` and the indicator is visible; ignored otherwise, so a
   * late event after the session ended cannot reopen the overlay.
   */
  onLiveText: (update: LiveTranscriptUpdate) => void
  onConfigChanged: () => void
  dispose: () => void
}

/**
 * Resolve saved vs onboarding-preview mode and whether the indicator process
 * should keep a window alive.
 */
function readIndicatorPlan(
  getSettings: () => AppSettings,
  previewMode: RecordingIndicatorMode | null
): {
  mode: RecordingIndicatorMode
  wantLifecycle: boolean
} {
  const settings = getSettings()
  const savedMode = settings.recordingIndicatorMode ?? ('always' as const)
  const mode = previewMode ?? savedMode
  const wantLifecycle =
    mode !== 'off' && (settings.onboardingCompleted || previewMode !== null)
  return { mode, wantLifecycle }
}

function bottomCenterFrame(display?: Display): {
  x: number
  y: number
  width: number
  height: number
} {
  const targetDisplay = display ?? Screen.getPrimaryDisplay()
  const area = targetDisplay.workArea ?? targetDisplay.bounds
  const margin = 16
  const x = Math.round(area.x + (area.width - INDICATOR_FRAME_PX) / 2)
  const y = Math.round(area.y + area.height - INDICATOR_FRAME_PX - margin)
  return { x, y, width: INDICATOR_FRAME_PX, height: INDICATOR_FRAME_PX }
}

export function setupIndicatorWindow(deps: {
  getSettings: () => AppSettings
  getRecordingIndicatorPosition: () => AppSettings['recordingIndicatorPosition']
  saveRecordingIndicatorPosition: (x: number, y: number) => void | Promise<void>
  getOnboardingIndicatorPreviewMode: () => RecordingIndicatorMode | null
}): IndicatorWindowHandle {
  let lastStatus: AppStatus = 'ready'
  let positionSaveTimer: ReturnType<typeof setTimeout> | null = null
  let helper: NativeIndicatorHelper | null = null
  /** What the helper is drawing now. Empty means the orb alone. */
  let shownText: StagingOverlayText = EMPTY_STAGING_OVERLAY_TEXT
  /** The newest text not yet sent, held back by the throttle. */
  let pendingText: StagingOverlayText | null = null
  let lastTextSentAtMs = 0
  let textTimer: ReturnType<typeof setTimeout> | null = null

  function cancelPendingText() {
    if (textTimer) {
      clearTimeout(textTimer)
      textTimer = null
    }
    pendingText = null
  }

  function sendText(text: StagingOverlayText) {
    if (!helper || stagingOverlayTextEquals(shownText, text)) return
    helper.setText(text)
    shownText = text
    lastTextSentAtMs = Date.now()
  }

  function flushPendingText() {
    textTimer = null
    const text = pendingText
    pendingText = null
    if (text === null || lastStatus !== 'streaming') return
    sendText(text)
  }

  /** Collapse the overlay back to the orb and drop anything the throttle still holds. */
  function clearStagingText() {
    cancelPendingText()
    if (!stagingOverlayTextIsEmpty(shownText)) {
      sendText(EMPTY_STAGING_OVERLAY_TEXT)
    }
  }

  function clearPositionSaveTimer() {
    if (positionSaveTimer) {
      clearTimeout(positionSaveTimer)
      positionSaveTimer = null
    }
  }

  function destroyWindow() {
    clearPositionSaveTimer()
    cancelPendingText()
    helper?.dispose()
    helper = null
    // A new helper process starts with the orb alone.
    shownText = EMPTY_STAGING_OVERLAY_TEXT
  }

  function intersectsAnyDisplay(
    x: number,
    y: number,
    w: number,
    h: number
  ): boolean {
    const displays = Screen.getAllDisplays()
    if (displays.length === 0) return true
    for (const d of displays) {
      const b = d.bounds
      if (
        x + w > b.x &&
        x < b.x + b.width &&
        y + h > b.y &&
        y < b.y + b.height
      ) {
        return true
      }
    }
    return false
  }

  function getDisplayContainingFrame(
    x: number,
    y: number,
    width: number,
    height: number
  ): Display | null {
    const displays = Screen.getAllDisplays()
    for (const display of displays) {
      const b = display.bounds
      const fullyContained =
        x >= b.x &&
        y >= b.y &&
        x + width <= b.x + b.width &&
        y + height <= b.y + b.height
      if (fullyContained) return display
    }
    return null
  }

  function clampFrameToDisplay(
    display: Display,
    frame: { x: number; y: number; width: number; height: number }
  ): { x: number; y: number; width: number; height: number } {
    const b = display.bounds
    const maxX = b.x + Math.max(0, b.width - frame.width)
    const maxY = b.y + Math.max(0, b.height - frame.height)
    return {
      x: Math.min(Math.max(frame.x, b.x), maxX),
      y: Math.min(Math.max(frame.y, b.y), maxY),
      width: frame.width,
      height: frame.height,
    }
  }

  function displayContainsPoint(
    display: Display,
    x: number,
    y: number
  ): boolean {
    const b = display.bounds
    return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
  }

  function getCursorDisplay(): Display | null {
    const cursor = Screen.getCursorScreenPoint()
    const displays = Screen.getAllDisplays()
    for (const display of displays) {
      if (displayContainsPoint(display, cursor.x, cursor.y)) return display
    }
    return displays[0] ?? null
  }

  function resolvePreferredDisplay(): Display {
    return getCursorDisplay() ?? Screen.getPrimaryDisplay()
  }

  function defaultIndicatorFrameForSettings(): {
    x: number
    y: number
    width: number
    height: number
  } {
    const settings = deps.getSettings()
    if (settings.capabilities.platform === 'windows') {
      return bottomCenterFrame(Screen.getPrimaryDisplay())
    }
    return bottomCenterFrame(resolvePreferredDisplay())
  }

  function resolveInitialIndicatorFrame(): {
    x: number
    y: number
    width: number
    height: number
  } {
    const settings = deps.getSettings()
    if (settings.capabilities.platform === 'windows') {
      return defaultIndicatorFrameForSettings()
    }

    const saved = deps.getRecordingIndicatorPosition()
    if (saved === null) return defaultIndicatorFrameForSettings()
    const { x, y } = saved
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !intersectsAnyDisplay(x, y, INDICATOR_FRAME_PX, INDICATOR_FRAME_PX)
    ) {
      return defaultIndicatorFrameForSettings()
    }

    const rounded = {
      x: Math.round(x),
      y: Math.round(y),
      width: INDICATOR_FRAME_PX,
      height: INDICATOR_FRAME_PX,
    }

    const containingDisplay = getDisplayContainingFrame(
      rounded.x,
      rounded.y,
      rounded.width,
      rounded.height
    )
    if (containingDisplay) return rounded

    return clampFrameToDisplay(resolvePreferredDisplay(), rounded)
  }

  function scheduleSaveIndicatorPosition(x: number, y: number) {
    clearPositionSaveTimer()
    positionSaveTimer = setTimeout(() => {
      positionSaveTimer = null
      void deps.saveRecordingIndicatorPosition(x, y)
    }, 450)
  }

  function getOrCreateHelper(): NativeIndicatorHelper | null {
    if (!deps.getSettings().capabilities.supportsNativeIndicator) return null
    if (helper) return helper
    helper = createNativeIndicatorHelper((x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      scheduleSaveIndicatorPosition(Math.round(x), Math.round(y))
    })
    return helper
  }

  function applyVisibleOverlayBehavior(status: AppStatus) {
    const frame = resolveInitialIndicatorFrame()
    const nativeHelper = getOrCreateHelper()
    if (!nativeHelper) return
    nativeHelper.show(frame, status, deps.getSettings().themePreference)
  }

  function parkIndicatorWindow() {
    clearPositionSaveTimer()
    clearStagingText()
    helper?.hide()
  }

  /** Whether the indicator is meant to be on screen for this status right now. */
  function indicatorWantsVisible(status: AppStatus): boolean {
    const { mode, wantLifecycle } = readIndicatorPlan(
      deps.getSettings,
      deps.getOnboardingIndicatorPreviewMode()
    )
    return wantLifecycle && indicatorShouldBeVisible(mode, status)
  }

  const onAppStatus = (status: AppStatus) => {
    lastStatus = status
    // The overlay belongs to a running Live Transcription only. Any other status - the
    // stream committed (`transcribing`), was abandoned or cancelled (`ready`) - ends it.
    if (status !== 'streaming') clearStagingText()
    const previewMode = deps.getOnboardingIndicatorPreviewMode()
    const { mode, wantLifecycle } = readIndicatorPlan(
      deps.getSettings,
      previewMode
    )
    const wantVisible = wantLifecycle && indicatorShouldBeVisible(mode, status)

    if (!wantLifecycle) {
      destroyWindow()
      return
    }

    if (wantVisible) {
      applyVisibleOverlayBehavior(status)
      helper?.setStatus(status)
    } else {
      parkIndicatorWindow()
    }
  }

  const onConfigChanged = () => {
    helper?.setTheme(deps.getSettings().themePreference)
    onAppStatus(lastStatus)
  }

  const onLiveText = (update: LiveTranscriptUpdate) => {
    if (lastStatus !== 'streaming' || !helper) return
    // Indicator mode Off (or not yet onboarded): no overlay either.
    if (!indicatorWantsVisible(lastStatus)) return
    pendingText = shapeStagingOverlayText(update)
    if (textTimer) return
    const waitMs = Math.max(
      0,
      lastTextSentAtMs + STAGING_OVERLAY_MIN_INTERVAL_MS - Date.now()
    )
    if (waitMs === 0) flushPendingText()
    else textTimer = setTimeout(flushPendingText, waitMs)
  }

  const dispose = () => {
    destroyWindow()
  }

  return { onAppStatus, onLiveText, onConfigChanged, dispose }
}
