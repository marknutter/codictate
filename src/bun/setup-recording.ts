import {
  getShortcutDefinition as buildShortcutDefinition,
  Key,
  KeyCode,
  MODIFIER_KEYCODES,
  FN_PHYSICAL_KEYCODES,
  isWindowsModifierReleaseEvent as matchesModifierRelease,
  isWindowsComboTriggerReleaseEvent as matchesTriggerRelease,
  type KeyEvent,
} from '../shared/shortcut-matching'
import { isModifierChord } from '../shared/shortcut-options'

import {
  startRecording,
  stopRecording,
  type CaptureResult,
  type RecordingSession,
} from './utils/audio/start-rec'
import {
  startParakeetStream,
  stopParakeetStream,
  type StreamSession,
  type StreamSessionEnd,
} from './utils/whisper/parakeet-stream-runner'
import {
  blockedDictationPlan,
  type BlockedDictationPlan,
  type DictationMode,
  type DictationPlan,
  type RunnableDictationPlan,
} from '../shared/dictation-plan'
import {
  finishObservedCorrection,
  pasteTranscript,
  startKeyboardListener,
  type PermissionStatus,
} from './utils/keyboard/keyboard-events'
import {
  playCancelSound,
  playEndSound,
  playErrorSound,
  playStartSound,
} from './utils/sound/play-sound'
import { AppConfig } from './AppConfig/AppConfig'
import type { TrayHandlers } from './setup-tray'
import { findDevices, type AudioDeviceSnapshot } from './utils/audio/devices'
import {
  resolveInputDevice,
  type ResolvedInputDevice,
} from './utils/audio/resolve-input-device'
import { DICTATION_HOLD_QUALIFY_MS } from '../shared/dictation-shortcut'
import type { AppStatus, ShortcutId } from '../shared/types'
import {
  outcomeFromTranscript,
  runDictation,
  type DictationOutcome,
} from './dictation/run-dictation'
import {
  failedTranscription,
  type FailedTranscription,
} from './utils/whisper/engines/transcription'
import { windowsUsesModifierReleaseHold } from '../shared/shortcut-options'
import { checkMicrophoneAuthorization } from './utils/audio/check-mic-authorization'
import { log } from './utils/logger'
import { startObserverHelper } from './utils/keyboard/observer-helper'
import { getPlatformRuntime } from './platform/runtime'

const getShortcutDefinition = (
  id: ShortcutId,
  options?: { requireLeftOption?: boolean }
) => buildShortcutDefinition(id, { ...options, platform: getPlatformRuntime() })

/** Keycodes that should not cancel "wait for Fn chord" when main is fn-globe + hold is fn-* (non-globe). */
const FN_GLOBE_DEFER_CANCEL_SUPPRESS = new Set<number>(
  Object.values(MODIFIER_KEYCODES).flat()
)

function holdFnChordConflictsWithFnGlobeMain(
  hybridId: ShortcutId,
  holdId: ShortcutId | null
): holdId is ShortcutId {
  return (
    hybridId === 'fn-globe' && holdId !== null && isModifierChord(holdId, 'fn')
  )
}

/**
 * Why a Live Transcription is ending, which decides what happens to its staged text.
 *
 * - `commit` - the user ended the Dictation. The text goes through the Dictation pipeline and
 *   is pasted once, exactly like a Batch Dictation's transcript. ADR-0008.
 * - `cancel` - Escape. Nothing is pasted or recorded, like an Escaped Batch Dictation.
 * - `abandon` - the app ended it: a settings change, quit, Live Transcription switched off, a
 *   blocked press. Nothing is pasted into whatever has focus, but the staged text is kept in
 *   History so the words are not lost.
 */
type LiveStopIntent = 'commit' | 'cancel' | 'abandon'

function mergeSwallowRules(a: KeyEvent[], b: KeyEvent[]): KeyEvent[] {
  const seen = new Set<string>()
  const out: KeyEvent[] = []
  for (const r of [...a, ...b]) {
    const k = `${r.keycode}|${r.option}|${r.leftOption}|${r.rightOption}|${r.command}|${r.control}|${r.shift}|${r.fn}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

export const setupRecording = (
  appConfig: AppConfig,
  {
    setTrayIdle,
    setTrayRecording,
    setTrayTranscribing,
    setTrayStreaming,
    setTrayError,
  }: TrayHandlers,
  onStatusChange?: (status: AppStatus) => void,
  onPermissions?: (status: PermissionStatus) => void,
  getAudioDevices?: () => AudioDeviceSnapshot,
  onAutoLearnedEntry?: () => void,
  onHistorySave?: (transcript: string) => Promise<void>,
  /**
   * One argument, because the Dictation Outcome already carries what a stats row needs -
   * including `engineId` and `languageId`, which come from the Dictation Plan rather than
   * from a config read after the run. See ADR-0006.
   */
  onStatsSave?: (outcome: DictationOutcome) => Promise<void>,
  /**
   * Every Dictation Plan a shortcut press produces, runnable or blocked. The main process
   * owns the surfaces a blocked plan has to reach that this module cannot: the notification,
   * the in-window banner, and the heal pass that makes the next press work.
   */
  onDictationPlan?: (plan: DictationPlan) => Promise<void>,
  /**
   * A Dictation that started and then produced nothing. The same two main-process surfaces a
   * blocked plan gets - notification or banner - and deliberately not the third: no heal
   * pass. See `reportFailedDictation` below.
   */
  onDictationFailed?: (failure: FailedTranscription) => Promise<void>,
  /**
   * The running transcript of a Live Transcription changed: committed segments plus the
   * current partial. For the Staging Overlay to draw; nothing is pasted until the end.
   */
  onLiveTranscriptText?: (text: string) => void
) => {
  let recorderProc: ReturnType<typeof Bun.spawn> | null = null
  let recordingSession: RecordingSession | null = null
  let sessionStarting = false
  let sessionStopping = false
  let transcriptionPipelineActive = false
  let pendingHoldReleaseWhileStarting = false
  let pendingHoldReleaseStartedAtMs = 0
  let pendingStreamHoldReleaseWhileStarting = false
  let pendingStreamHoldReleaseStartedAtMs = 0

  // Stream mode state
  let streamSession: StreamSession | null = null
  /** The plan the running stream was started from. Its Outcome records this plan's facts. */
  let activeStreamPlan: RunnableDictationPlan | null = null
  let streamStarting = false
  /** When stream was started via push-to-talk, release must stop (unlike hybrid tap-to-toggle). */
  let activeStreamShortcutMode: 'hybrid' | 'holdOnly' | null = null
  /** Monotonic id for log correlation with Parakeet helper stderr (`[sN]`). */
  let streamDebugSeq = 0

  /**
   * The microphone this Dictation records from, for both paths. A cached snapshot that says
   * the chosen microphone is missing is re-read once before blocking, because the snapshot only
   * refreshes on an interval and a microphone plugged in seconds ago must not be refused.
   */
  const resolveDictationDevice = async (): Promise<ResolvedInputDevice> => {
    const selection = appConfig.getInputDeviceSelection()
    let snapshot = getAudioDevices?.() ?? { devices: {}, details: {} }
    let resolved = resolveInputDevice(selection, snapshot)
    if (resolved.status === 'missing') {
      snapshot = await findDevices()
      resolved = resolveInputDevice(selection, snapshot)
    }
    log('mic', 'resolved dictation device', {
      selection,
      ...resolved,
    })
    return resolved
  }

  /** The chosen microphone is gone: block with a reason rather than record from another one. */
  const reportMissingMicrophone = async (plan: RunnableDictationPlan) => {
    resetHoldGate()
    setTrayIdle()
    onStatusChange?.('ready')
    await reportBlockedDictation(
      blockedDictationPlan(plan.mode, 'microphone_missing', plan.speechModelId)
    )
  }

  let holdArmTimer: ReturnType<typeof setTimeout> | null = null
  /** True after HOLD_QUALIFY_MS with no qualifying release cancelling the arm timer. */
  let holdQualified = false
  /** Which shortcut started the current session (when recorder is active). */
  let activeRecordingMode: 'hybrid' | 'holdOnly' | null = null
  /**
   * Fn-down was swallowed so Fn+key push-to-talk can win over main `fn-globe` (which would
   * otherwise start hybrid on Fn press and drop the chord while `sessionStarting` is true).
   */
  let pendingFnGlobeHybridDefer = false

  const mainShortcutUsesLeftOptionOnly = () =>
    appConfig.getShortcutHoldOnlyId() === 'right-option' &&
    isModifierChord(appConfig.getShortcutId(), 'option')

  const getHybridShortcut = () =>
    getShortcutDefinition(appConfig.getShortcutId(), {
      requireLeftOption: mainShortcutUsesLeftOptionOnly(),
    })

  const getHoldOnlyShortcut = () => {
    const id = appConfig.getShortcutHoldOnlyId()
    return id !== null ? getShortcutDefinition(id) : null
  }

  const getMergedSwallowRules = (): KeyEvent[] => {
    const hybrid = getHybridShortcut()
    const hold = getHoldOnlyShortcut()
    if (hold === null) return hybrid.swallowRules
    return mergeSwallowRules(hybrid.swallowRules, hold.swallowRules)
  }

  const clearHoldArmTimer = () => {
    if (holdArmTimer !== null) {
      clearTimeout(holdArmTimer)
      holdArmTimer = null
    }
  }

  const resetHoldGate = () => {
    clearHoldArmTimer()
    holdQualified = false
  }

  const armHoldGateAfterStart = () => {
    resetHoldGate()
    holdArmTimer = setTimeout(() => {
      holdArmTimer = null
      if (recorderProc !== null || streamSession !== null || streamStarting) {
        holdQualified = true
      }
    }, DICTATION_HOLD_QUALIFY_MS)
  }

  const keyLabel = (keycode: number) => KeyCode[keycode] ?? String(keycode)

  const usesWindowsModifierReleaseHold = (shortcutId: ShortcutId): boolean =>
    getPlatformRuntime() === 'windows' &&
    windowsUsesModifierReleaseHold(shortcutId)

  const isWindowsModifierReleaseEvent = (
    shortcutId: ShortcutId,
    keyEvent: KeyEvent
  ): boolean => {
    if (!usesWindowsModifierReleaseHold(shortcutId)) return true
    return matchesModifierRelease(
      shortcutId,
      keyEvent,
      mainShortcutUsesLeftOptionOnly() &&
        shortcutId === appConfig.getShortcutId()
    )
  }

  const isWindowsComboTriggerReleaseEvent = (
    shortcutId: ShortcutId,
    keyEvent: KeyEvent
  ): boolean => {
    if (!usesWindowsModifierReleaseHold(shortcutId)) return false
    return matchesTriggerRelease(shortcutId, keyEvent)
  }

  const keyEventDebug = (e: KeyEvent) => ({
    keycode: e.keycode,
    key: keyLabel(e.keycode),
    keyDown: e.keyDown,
    isRepeat: e.isRepeat,
    option: e.option,
    leftOption: e.leftOption,
    rightOption: e.rightOption,
    command: e.command,
    control: e.control,
    shift: e.shift,
    fn: e.fn,
  })

  const logShortcutDecision = (
    reason: string,
    mode: 'hybrid' | 'holdOnly',
    action: 'start' | 'stop' | 'blocked',
    keyEvent?: KeyEvent,
    /** The Dictation Plan's own mode, when a plan was built for this press. */
    planMode?: DictationMode
  ) => {
    log('shortcut', 'routing shortcut', {
      reason,
      mode,
      action,
      planMode,
      streamSessionActive: streamSession !== null,
      streamDebugId: streamSession?.streamDebugId,
      activeStreamShortcutMode,
      hybridShortcutId: appConfig.getShortcutId(),
      holdShortcutId: appConfig.getShortcutHoldOnlyId(),
      recorderActive: recorderProc !== null,
      transcriptionPipelineActive,
      keyEvent: keyEvent ? keyEventDebug(keyEvent) : undefined,
    })
  }

  /**
   * A Dictation that will not run, made impossible to miss.
   *
   * Four surfaces, because the app is usable with no window open: the error chime and the
   * tray error state are owned here, and `onDictationPlan` carries the same sentence out to
   * the notification (window closed) or the in-window banner (window open) and runs the heal
   * pass so the next press works. ADR-0005: a blocked Dictation is never silent.
   */
  const reportBlockedDictation = async (plan: BlockedDictationPlan) => {
    log('shortcut', 'dictation blocked', {
      planMode: plan.mode,
      reason: plan.reason,
    })
    if (appConfig.getSoundEffectsEnabled()) playErrorSound()
    setTrayError(plan.message)
    await onDictationPlan?.(plan)
  }

  /**
   * A Dictation that ran and produced nothing, made impossible to miss.
   *
   * The same four surfaces as a blocked plan, and for the same reason: the app is usable with
   * no window open, so an error chime and the tray error state are owned here while
   * `onDictationFailed` carries the sentence out to the notification or the in-window banner.
   *
   * What it deliberately does not do is heal. A blocked plan means the configuration is
   * unrunnable and healing is the correction; a crashed helper means the configuration was
   * fine, and running the heal pass on every crash would let a flaky helper quietly rewrite
   * settings the user chose. ADR-0006.
   */
  const reportFailedDictation = async (failure: FailedTranscription) => {
    log('whisper', 'dictation failed', {
      reason: failure.reason,
      message: failure.message,
    })
    if (appConfig.getSoundEffectsEnabled()) playErrorSound()
    setTrayError(failure.message)
    await onDictationFailed?.(failure)
  }

  /**
   * The Dictation pipeline is free again.
   *
   * Runs on every path out of a finished capture, the failure ones included: this is the only
   * signal the shortcut router has, so an escaping throw used to leave
   * `transcriptionPipelineActive` true for the rest of the process and every later press was
   * refused until restart. A failed Dictation must cost one Dictation, not all of them.
   */
  const releaseDictationPipeline = () => {
    transcriptionPipelineActive = false
    recordingSession = null
    setTrayIdle()
    onStatusChange?.('ready')
  }

  /**
   * Paste a Dictation Outcome and record it in History and stats. Batch Dictation and Live
   * Transcription both end here, so they write the same History entry and stats row.
   *
   * An empty output is a Dictation the Speech Engine heard nothing in, and it writes
   * nothing: no paste, no history entry, no stats row, no error chime. It used to paste an
   * empty string over the cursor and count a zero-word stats row.
   */
  const deliverDictationOutcome = async (outcome: DictationOutcome) => {
    if (outcome.output === '') return
    await pasteTranscript(outcome.output)

    if (onHistorySave) {
      try {
        await onHistorySave(outcome.output)
      } catch (err) {
        log('history', 'failed to save entry', { err: String(err) })
      }
    }
    if (onStatsSave) {
      try {
        await onStatsSave(outcome)
      } catch (err) {
        log('stats', 'failed to save session', { err: String(err) })
      }
    }
  }

  /**
   * Keep a Live Transcription's staged text that will not be pasted, so the words are not
   * lost. History only: no paste, and no stats row, because no Dictation Outcome was made.
   */
  const saveStagedTextToHistory = async (text: string) => {
    if (text === '' || !onHistorySave) return
    try {
      await onHistorySave(text)
    } catch (err) {
      log('history', 'failed to save staged live text', { err: String(err) })
    }
  }

  /**
   * The capture is over; everything after it happens here.
   *
   * The order is load-bearing and unchanged from when it lived inside the mic process's
   * `onExit`: tray and indicator to transcribing, the end chime, the pipeline, and the paste
   * on the statement after the pipeline returns. Nothing is awaited between the transcript
   * and the paste. What changed is who does it - `setup-recording.ts` already owns every
   * other post-Dictation surface, and the audio module should not be orchestrating the
   * Formatting Backend. ADR-0006.
   */
  const handleCaptureFinished = async (
    plan: RunnableDictationPlan,
    capture: CaptureResult
  ) => {
    // Cancelled, or too short to be speech. Silence, not a failure: no chime, no notice, and
    // the session ends where it stands.
    if (capture.discarded || capture.skipReason !== null) {
      releaseDictationPipeline()
      return
    }

    recorderProc = null
    transcriptionPipelineActive = true
    activeRecordingMode = null
    setTrayTranscribing()
    onStatusChange?.('transcribing')

    // Held rather than reported inline, because the tray error state has to outlive the
    // release below - which puts the tray back to idle. Same order the blocked-stream path
    // uses: idle first, then the error.
    let failure: FailedTranscription | null = null

    try {
      if (appConfig.getSoundEffectsEnabled())
        playEndSound(appConfig.getFunModeEnabled())

      // The previous Dictation's Dictionary hits are promoted now, before this one records
      // its own. Hoisted out of the pipeline because it is bookkeeping about the last run,
      // not part of producing this transcript.
      await appConfig.acceptPreviouslyAppliedEntries()

      const outcome = await runDictation({
        plan,
        audioPath: capture.audioPath,
        durationMs: capture.durationMs,
        formattingSettings: appConfig.getFormattingRuntimeSettings(),
        dictionaryEntries: appConfig.getDictionaryEntries(),
        onAppliedEntries: (entries) => appConfig.notifyAppliedEntries(entries),
      })

      if (outcome.status === 'failed') {
        failure = outcome
      } else {
        await deliverDictationOutcome(outcome)
      }
    } catch (err) {
      log('whisper', 'transcription pipeline failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      releaseDictationPipeline()
    }

    if (failure !== null) await reportFailedDictation(failure)
  }

  /**
   * A Live Transcription has ended and its helper has exited; everything after it happens here.
   *
   * The mirror of `handleCaptureFinished`. The helper already transcribed what the user said,
   * so the staged text enters the Dictation pipeline after the Speech Engine - Dictionary,
   * Formatting Mode - and is pasted once, on the statement after the pipeline returns. A
   * helper that did not finish the session is a failed Dictation: nothing is pasted, and the
   * staged text goes to History. ADR-0008.
   */
  const finishLiveTranscription = async (
    plan: RunnableDictationPlan,
    end: StreamSessionEnd,
    intent: LiveStopIntent,
    durationMs: number
  ) => {
    // Held rather than reported inline, for the same reason as in `handleCaptureFinished`:
    // the tray error state has to outlive the release below.
    let failure: FailedTranscription | null = null

    try {
      log('stream', 'live transcription ended', {
        intent,
        status: end.status,
        chars: end.text.length,
        durationMs,
      })
      if (intent === 'cancel') {
        // Escape: the user threw it away. Nothing pasted, nothing recorded.
      } else if (end.status === 'failed') {
        log('stream', 'live transcription helper did not finish the session', {
          exitCode: end.exitCode,
          diagnostic: end.diagnostic,
        })
        await saveStagedTextToHistory(end.text)
        // An app-initiated stop has its own surface already (quit, a settings change, a
        // blocked press). Only a Dictation the user was running reports the failure.
        if (intent === 'commit') {
          failure = failedTranscription(
            'live_transcription_interrupted',
            plan.speechModelId,
            end.diagnostic
          )
        }
      } else if (intent === 'abandon') {
        await saveStagedTextToHistory(end.text)
      } else {
        // The previous Dictation's Dictionary hits are promoted now, before this one records
        // its own - the same bookkeeping a Batch Dictation does.
        await appConfig.acceptPreviouslyAppliedEntries()

        const outcome = await outcomeFromTranscript({
          plan,
          rawTranscript: end.text,
          durationMs,
          formattingSettings: appConfig.getFormattingRuntimeSettings(),
          dictionaryEntries: appConfig.getDictionaryEntries(),
          onAppliedEntries: (entries) =>
            appConfig.notifyAppliedEntries(entries),
        })
        await deliverDictationOutcome(outcome)
      }
    } catch (err) {
      log('stream', 'live transcription pipeline failed', {
        err: err instanceof Error ? err.message : String(err),
      })
    } finally {
      releaseDictationPipeline()
    }

    if (failure !== null) await reportFailedDictation(failure)
  }

  const routeShortcutAction = async (
    mode: 'hybrid' | 'holdOnly',
    keyEvent: KeyEvent,
    reason: string
  ) => {
    const plan = appConfig.getDictationPlan()

    if (plan.status === 'blocked') {
      // A running stream still has to be stoppable: its weights can vanish mid-session, and
      // the press that notices must not leave the helper running.
      if (streamSession !== null) {
        logShortcutDecision(reason, mode, 'stop', keyEvent, plan.mode)
        await tryStopStream('abandon')
      }
      logShortcutDecision(reason, mode, 'blocked', keyEvent, plan.mode)
      await reportBlockedDictation(plan)
      return
    }

    await onDictationPlan?.(plan)

    if (plan.mode !== 'live' && streamSession !== null) {
      log('shortcut', 'stopping orphan Parakeet stream (stream mode off)')
      await tryStopStream('abandon')
    }
    if (plan.mode === 'live') {
      logShortcutDecision(
        reason,
        mode,
        streamSession !== null ? 'stop' : 'start',
        keyEvent,
        plan.mode
      )
      if (streamSession !== null) await tryStopStream('commit')
      else await tryStartStream(plan, mode)
      return
    }

    logShortcutDecision(reason, mode, 'start', keyEvent, plan.mode)
    await tryStart(plan, mode)
  }

  const tryStartStream = async (
    plan: RunnableDictationPlan,
    shortcutMode: 'hybrid' | 'holdOnly'
  ) => {
    if (
      streamSession !== null ||
      streamStarting ||
      recorderProc !== null ||
      transcriptionPipelineActive
    )
      return
    streamStarting = true
    pendingStreamHoldReleaseWhileStarting = false
    pendingStreamHoldReleaseStartedAtMs = Date.now()
    const streamDebugId = ++streamDebugSeq
    activeStreamShortcutMode = shortcutMode
    try {
      const device = await resolveDictationDevice()
      if (device.status === 'missing') {
        await reportMissingMicrophone(plan)
        return
      }
      const streamDeviceRef = device.deviceRef
      log('stream', 'starting Parakeet stream session', {
        streamTranscriptionMode: appConfig.getStreamTranscriptionMode(),
        speechModelId: plan.speechModelId,
        shortcutMode,
        streamDebugId,
        deviceRef: streamDeviceRef,
      })
      if (appConfig.getSoundEffectsEnabled())
        playStartSound(appConfig.getFunModeEnabled())
      setTrayStreaming()
      onStatusChange?.('streaming')
      const started = await startParakeetStream(
        plan,
        appConfig.getStreamTranscriptionMode(),
        {
          onText: (text) => onLiveTranscriptText?.(text),
        },
        {
          streamDebugId,
          outputDuckBuiltIn: appConfig.getAudioDuckingIncludeBuiltInSpeakers(),
          outputDuckHeadphones: appConfig.getAudioDuckingIncludeHeadphones(),
          outputDuckLevel: appConfig.getAudioDuckingLevel(),
          deviceRef: streamDeviceRef,
        }
      )
      // The pre-spawn race check lost: the helper or the weights went away between building
      // the plan and spawning. Same four surfaces as any other blocked Dictation.
      if (started.status === 'blocked') {
        streamSession = null
        activeStreamShortcutMode = null
        resetHoldGate()
        setTrayIdle()
        onStatusChange?.('ready')
        await reportBlockedDictation(started.plan)
        return
      }
      const session = started.session
      streamSession = session
      activeStreamPlan = plan
      // The helper ended the session without being asked: a crash, a lost microphone. A stop
      // this module requested clears `streamSession` first and handles the end itself.
      void session.ended.then(async (end) => {
        if (streamSession !== session) return
        log('stream', 'Parakeet helper ended the session on its own', {
          streamDebugId,
          status: end.status,
        })
        streamSession = null
        activeStreamPlan = null
        activeStreamShortcutMode = null
        resetHoldGate()
        transcriptionPipelineActive = true
        setTrayTranscribing()
        onStatusChange?.('transcribing')
        await finishLiveTranscription(
          plan,
          end,
          'commit',
          Date.now() - session.startedAtMs
        )
      })
      if (pendingStreamHoldReleaseWhileStarting) {
        resetHoldGate()
        await tryStopStream('commit')
      } else if (streamSession !== null) {
        if (shortcutMode === 'hybrid') armHoldGateAfterStart()
        else resetHoldGate()
      }
    } catch (err) {
      log('stream', 'failed to start stream session', {
        err: String(err),
        streamDebugId,
      })
      streamSession = null
      activeStreamShortcutMode = null
      resetHoldGate()
      setTrayIdle()
      onStatusChange?.('ready')
    } finally {
      streamStarting = false
      if (streamSession === null) {
        activeStreamShortcutMode = null
        pendingStreamHoldReleaseWhileStarting = false
        pendingStreamHoldReleaseStartedAtMs = 0
      }
    }
  }

  /**
   * End the running Live Transcription.
   *
   * The helper is always stopped gracefully, even on Escape: it commits its last segment,
   * restores the output volume it ducked, and exits. The Dictation pipeline stays held until
   * it has, so a press in that window cannot start a second helper.
   */
  const tryStopStream = async (intent: LiveStopIntent) => {
    if (streamSession === null || activeStreamPlan === null) return
    const session = streamSession
    const plan = activeStreamPlan
    const durationMs = Date.now() - session.startedAtMs
    log('stream', 'stopping stream session', {
      streamDebugId: session.streamDebugId,
      intent,
    })
    streamSession = null
    activeStreamPlan = null
    activeStreamShortcutMode = null
    pendingStreamHoldReleaseWhileStarting = false
    pendingStreamHoldReleaseStartedAtMs = 0
    resetHoldGate()
    transcriptionPipelineActive = true

    if (intent === 'commit') {
      // Same order as a Batch Dictation: tray and indicator to transcribing, then the end
      // chime. The helper's last segment and the pipeline both run under `transcribing`.
      setTrayTranscribing()
      onStatusChange?.('transcribing')
      if (appConfig.getSoundEffectsEnabled())
        playEndSound(appConfig.getFunModeEnabled())
    } else {
      setTrayIdle()
      onStatusChange?.('ready')
    }

    // `finishLiveTranscription` is what releases the Dictation pipeline, so it must be reached
    // even if the stop itself throws.
    let end: StreamSessionEnd
    try {
      end = await stopParakeetStream(session)
    } catch (err) {
      end = {
        status: 'failed',
        text: session.text(),
        exitCode: null,
        diagnostic: err instanceof Error ? err.message : String(err),
      }
    }
    await finishLiveTranscription(plan, end, intent, durationMs)
  }

  const tryStop = async () => {
    if (!recorderProc || sessionStopping) return
    sessionStopping = true
    resetHoldGate()
    try {
      log('shortcut', 'stopping recorder session', {
        activeRecordingMode: activeRecordingMode ?? undefined,
      })
      const proc = recorderProc
      await stopRecording(proc)
      recorderProc = null
    } finally {
      sessionStopping = false
      activeRecordingMode = null
    }
  }

  const tryStart = async (
    plan: RunnableDictationPlan,
    mode: 'hybrid' | 'holdOnly'
  ) => {
    if (
      recorderProc !== null ||
      sessionStarting ||
      transcriptionPipelineActive
    ) {
      return
    }
    sessionStarting = true
    pendingHoldReleaseWhileStarting = false
    pendingHoldReleaseStartedAtMs = Date.now()
    activeRecordingMode = mode
    try {
      log('shortcut', 'starting recorder session', {
        mode,
        planMode: plan.mode,
        speechModelId: plan.speechModelId,
      })
      const device = await resolveDictationDevice()
      if (device.status === 'missing') {
        await reportMissingMicrophone(plan)
        return
      }
      if (appConfig.getSoundEffectsEnabled())
        playStartSound(appConfig.getFunModeEnabled())
      setTrayRecording()
      onStatusChange?.('recording')
      recordingSession = { discard: false, startedAtMs: Date.now() }
      recorderProc = await startRecording(
        appConfig,
        plan,
        recordingSession,
        (capture) => handleCaptureFinished(plan, capture),
        device.deviceRef
      )

      if (pendingHoldReleaseWhileStarting && recordingSession && recorderProc) {
        resetHoldGate()
        activeRecordingMode = null
        recordingSession.discard = true
        const p = recorderProc
        recorderProc = null
        setTrayIdle()
        onStatusChange?.('ready')
        p.kill('SIGINT')
        await p.exited
      } else if (recorderProc) {
        if (mode === 'hybrid') armHoldGateAfterStart()
        else resetHoldGate()
      }
    } finally {
      sessionStarting = false
      if (recorderProc === null) activeRecordingMode = null
    }
  }

  const handleKeyEvent = async (keyEvent: KeyEvent) => {
    if (
      isWindowsComboTriggerReleaseEvent(appConfig.getShortcutId(), keyEvent)
    ) {
      return
    }
    if (
      appConfig.getShortcutHoldOnlyId() !== null &&
      isWindowsComboTriggerReleaseEvent(
        appConfig.getShortcutHoldOnlyId()!,
        keyEvent
      )
    ) {
      return
    }

    if (
      keyEvent.keyDown &&
      keyEvent.keycode === Key.enter &&
      !keyEvent.isRepeat
    ) {
      finishObservedCorrection()
    }

    const hybrid = getHybridShortcut()
    const holdOnly = getHoldOnlyShortcut()

    if (streamSession !== null) {
      const activeStreamShortcut =
        activeStreamShortcutMode === 'holdOnly' && holdOnly !== null
          ? holdOnly
          : hybrid
      if (activeStreamShortcut.matchesHoldUp(keyEvent)) {
        if (holdArmTimer !== null) clearHoldArmTimer()
        const releaseStops =
          activeStreamShortcutMode === 'holdOnly' || holdQualified
        if (releaseStops && activeStreamShortcutMode !== null) {
          logShortcutDecision(
            'hold release (stream)',
            activeStreamShortcutMode,
            'stop',
            keyEvent
          )
          await tryStopStream('commit')
        }
        return
      }
    }

    if (keyEvent.keycode === Key.escape && keyEvent.keyDown) {
      if (streamSession !== null) {
        log('shortcut', 'escape stopping active stream session')
        if (appConfig.getSoundEffectsEnabled()) playCancelSound()
        void tryStopStream('cancel')
        return
      }
      if (recorderProc) {
        resetHoldGate()
        activeRecordingMode = null
        if (recordingSession) recordingSession.discard = true
        recorderProc.kill()
        recorderProc = null
        setTrayIdle()
        onStatusChange?.('ready')
        if (appConfig.getSoundEffectsEnabled()) playCancelSound()
        return
      }
    }

    if (recorderProc !== null) {
      const def =
        activeRecordingMode === 'holdOnly' && holdOnly !== null
          ? holdOnly
          : hybrid

      if (def.matchesHoldUp(keyEvent)) {
        if (
          activeRecordingMode === 'hybrid' &&
          !isWindowsModifierReleaseEvent(appConfig.getShortcutId(), keyEvent)
        ) {
          return
        }
        if (sessionStarting) {
          pendingHoldReleaseWhileStarting =
            activeRecordingMode === 'holdOnly' ||
            Date.now() - pendingHoldReleaseStartedAtMs >=
              DICTATION_HOLD_QUALIFY_MS
        }
        if (holdArmTimer !== null) clearHoldArmTimer()
        const releaseStops = activeRecordingMode === 'holdOnly' || holdQualified
        if (releaseStops) await tryStop()
        return
      }
      if (
        activeRecordingMode === 'hybrid' &&
        hybrid.matchesToggleDown(keyEvent) &&
        !keyEvent.isRepeat
      ) {
        resetHoldGate()
        await tryStop()
      }
      return
    }

    if (transcriptionPipelineActive || sessionStarting) return

    if (streamStarting) {
      if (
        activeStreamShortcutMode === 'hybrid' &&
        hybrid.matchesHoldUp(keyEvent)
      ) {
        if (
          !isWindowsModifierReleaseEvent(appConfig.getShortcutId(), keyEvent)
        ) {
          return
        }
        if (holdArmTimer !== null) clearHoldArmTimer()
        if (
          holdQualified ||
          Date.now() - pendingStreamHoldReleaseStartedAtMs >=
            DICTATION_HOLD_QUALIFY_MS
        ) {
          pendingStreamHoldReleaseWhileStarting = true
        }
        return
      }
      if (
        activeStreamShortcutMode === 'holdOnly' &&
        holdOnly !== null &&
        holdOnly.matchesHoldUp(keyEvent)
      ) {
        pendingStreamHoldReleaseWhileStarting = true
        return
      }
      return
    }

    const hybridId = appConfig.getShortcutId()
    const holdId = appConfig.getShortcutHoldOnlyId()

    const fnGlobeDef = getShortcutDefinition('fn-globe')
    const deferFnGlobeForFnChord =
      holdOnly !== null && holdFnChordConflictsWithFnGlobeMain(hybridId, holdId)

    if (deferFnGlobeForFnChord) {
      if (pendingFnGlobeHybridDefer) {
        if (holdOnly.matchesToggleDown(keyEvent) && !keyEvent.isRepeat) {
          pendingFnGlobeHybridDefer = false
          await routeShortcutAction(
            'holdOnly',
            keyEvent,
            'fn-globe deferred hold-only'
          )
          return
        }
        if (fnGlobeDef.matchesHoldUp(keyEvent)) {
          pendingFnGlobeHybridDefer = false
          await routeShortcutAction(
            'hybrid',
            keyEvent,
            'fn-globe deferred hybrid'
          )
          return
        }
        if (
          keyEvent.keyDown &&
          !keyEvent.isRepeat &&
          !FN_GLOBE_DEFER_CANCEL_SUPPRESS.has(keyEvent.keycode)
        ) {
          pendingFnGlobeHybridDefer = false
          // Fall through: e.g. unrelated key — may match nothing.
        } else {
          return
        }
      } else if (
        hybrid.matchesToggleDown(keyEvent) &&
        !keyEvent.isRepeat &&
        FN_PHYSICAL_KEYCODES.includes(
          keyEvent.keycode as (typeof FN_PHYSICAL_KEYCODES)[number]
        )
      ) {
        pendingFnGlobeHybridDefer = true
        return
      }
    } else {
      pendingFnGlobeHybridDefer = false
    }

    if (
      holdOnly !== null &&
      holdOnly.matchesToggleDown(keyEvent) &&
      !keyEvent.isRepeat
    ) {
      await routeShortcutAction('holdOnly', keyEvent, 'direct hold-only')
      return
    }
    if (hybrid.matchesToggleDown(keyEvent) && !keyEvent.isRepeat) {
      await routeShortcutAction('hybrid', keyEvent, 'direct hybrid')
    }
  }

  const relayPermissions = onPermissions
    ? (status: PermissionStatus) => {
        void (async () => {
          let microphone = status.microphone
          try {
            microphone = await checkMicrophoneAuthorization()
          } catch {
            /* MicRecorder missing in some dev setups — keep KeyListener value */
          }
          onPermissions({ ...status, microphone })
        })()
      }
    : undefined

  startObserverHelper(
    async ({ original, corrected }) => {
      const outcome = await appConfig.stageAutoLearnCorrection(
        original,
        corrected
      )
      log('observer', 'processed auto-learn candidate', {
        original,
        corrected,
        outcome,
      })
      if (outcome === 'committed') {
        onAutoLearnedEntry?.()
      }
    },
    async ({ currentText, candidatesFound }) => {
      if (candidatesFound > 0) return
      const removed =
        await appConfig.invalidateDictionaryCandidatesForText(currentText)
      if (removed.length === 0) return
      log('observer', 'discarded pending auto-learn candidates', {
        currentText,
        removed: removed.map((candidate) => ({
          from: candidate.from,
          to: candidate.to,
          corrections: candidate.corrections,
        })),
      })
    },
    () => appConfig.getDictionaryAutoLearn(),
    () => appConfig.getDictionaryEntries()
  )

  const keyboard = startKeyboardListener(
    (keyEvent) => {
      void handleKeyEvent(keyEvent)
    },
    getMergedSwallowRules(),
    relayPermissions
  )

  /** The app is ending the stream (settings change, quit, mode off): never a paste. */
  const stopActiveParakeetStream = async () => {
    await tryStopStream('abandon')
  }

  return {
    ...keyboard,
    stopActiveParakeetStream,
  }
}
