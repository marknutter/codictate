/**
 * Self-correction Cleanup, decided: whether it can run, and what to do when it cannot.
 *
 * Self-correction Cleanup is an optional step of the Dictation pipeline that resolves spoken
 * self-corrections ("meet at three, no, four" becomes "meet at four") with the selected
 * Formatting Model, after the Dictionary and before the Formatting Mode. See CONTEXT.md and
 * docs/adr/0008-live-transcription-stages-in-an-overlay.md.
 *
 * It needs an installed Formatting Model, so it follows ADR-0005 the same way Translate to
 * English and Live Transcription do, with the same three arms:
 *
 * - **Readiness** (`getSelfCorrectionCleanupReadiness`) is computed in the main process and
 *   shipped in the settings payload, so Settings disables the toggle with a sentence and
 *   derives nothing itself.
 * - **On write, refuse** (`applySelfCorrectionCleanupPatch`): turning it on while it cannot
 *   run is told no. A write that makes it unrunnable without mentioning it - selecting a
 *   Formatting Model that is not downloaded - turns it off and says so.
 * - **On an availability change, heal** (`healSelfCorrectionCleanup`): removing the
 *   Formatting Model is never refused, so the setting is switched off and announced.
 *
 * Pure functions over `(settings, availability)` only - no filesystem, no `llama-completion`
 * probe - because the webview imports this module too, and because a pure rule is one the
 * readiness, the write and the heal cannot disagree about.
 *
 * Deliberately not part of `RunnableDictationSettings`: that slice is the Speech Model side
 * of a Dictation, whose availability is a Speech Model predicate. Self-correction Cleanup
 * depends on the Formatting Model side, and folding it in would put formatting availability
 * into every Dictation Plan build for a step the plan never needs to choose.
 *
 * There is no Apple Intelligence arm. The formatting runner has one backend, llama.cpp
 * (`llama-completion`): Apple Intelligence was retired as a Formatting Backend, so the only
 * runtime requirement is the bundled binary plus the selected model's weights.
 */

import type { FormatterModelTier } from './types'

/** Display names for the Formatting Models, as the Settings model picker shows them. */
export const FORMATTING_MODEL_LABELS: Record<FormatterModelTier, string> = {
  fast: 'Qwen2.5 3B',
  quality: 'Qwen3 4B',
  's1-mini': 'S1-mini by Superwhisper',
}

/** The settings Self-correction Cleanup depends on. Nothing else can make it unrunnable. */
export interface SelfCorrectionCleanupSettings {
  /** The user's "Clean up self-corrections" toggle. */
  selfCorrectionCleanup: boolean
  /** The selected Formatting Model, which is what runs the cleanup. */
  formatterModelTier: FormatterModelTier
}

/**
 * Everything outside the settings that decides whether Self-correction Cleanup can run. The
 * same two facts `FormattingSettings` already carries as `available` and `modelAvailability`,
 * so the main process passes those.
 */
export interface SelfCorrectionCleanupAvailability {
  /** The bundled `llama-completion` binary is present. */
  formattingAvailable: boolean
  /** Per Formatting Model: its weights are on disk. */
  modelAvailability: Record<FormatterModelTier, boolean>
}

/** Why Self-correction Cleanup cannot run. Closed union, each with a message below. */
export type SelfCorrectionCleanupReadinessReason =
  /** This build has no `llama-completion` binary, so no Formatting Model can run at all. */
  | 'formatting_runtime_missing'
  /** The selected Formatting Model's weights are not on disk. */
  | 'formatting_model_not_installed'

/**
 * One capability, decided, as plain serialisable data for the settings payload. Same shape
 * as the Speech Model side's `CapabilityReadiness`, minus its Speech Model download pointer:
 * the Formatting Model to download here is always the selected one.
 */
export type SelfCorrectionCleanupReadiness =
  | {
      ready: true
      reason: null
      /** One finished sentence, shown to the user as written. */
      message: string
    }
  | {
      ready: false
      reason: SelfCorrectionCleanupReadinessReason
      /** One finished sentence, shown to the user as written. */
      message: string
    }

const SETTING_LABEL = 'Clean up self-corrections'

export function getSelfCorrectionCleanupReadiness(
  settings: Pick<SelfCorrectionCleanupSettings, 'formatterModelTier'>,
  availability: SelfCorrectionCleanupAvailability
): SelfCorrectionCleanupReadiness {
  const tier = settings.formatterModelTier
  const label = FORMATTING_MODEL_LABELS[tier]

  if (!availability.formattingAvailable) {
    return {
      ready: false,
      reason: 'formatting_runtime_missing',
      message: `${SETTING_LABEL} needs the bundled llama.cpp runtime, which is missing from this build.`,
    }
  }

  if (!availability.modelAvailability[tier]) {
    const anyInstalled = Object.values(availability.modelAvailability).some(
      Boolean
    )
    return {
      ready: false,
      reason: 'formatting_model_not_installed',
      message: anyInstalled
        ? `${SETTING_LABEL} runs on the selected Formatting Model, and ${label} is not installed. Download it or select an installed model above.`
        : `${SETTING_LABEL} needs a Formatting Model. Download one above to use it.`,
    }
  }

  return {
    ready: true,
    reason: null,
    message:
      tier === 's1-mini'
        ? `Resolves spoken corrections such as "at three, no, four" with ${label} before pasting. English dictation only; other languages are pasted as spoken.`
        : `Resolves spoken corrections such as "at three, no, four" with ${label} before pasting. Adds the model's run time to each dictation.`,
  }
}

/** What the heal pass says when it switches the setting off. One finished sentence. */
export function selfCorrectionCleanupHealMessage(
  settings: Pick<SelfCorrectionCleanupSettings, 'formatterModelTier'>,
  reason: SelfCorrectionCleanupReadinessReason
): string {
  switch (reason) {
    case 'formatting_runtime_missing':
      return `${SETTING_LABEL} turned off because the bundled llama.cpp runtime that runs ${FORMATTING_MODEL_LABELS[settings.formatterModelTier]} is missing.`
    case 'formatting_model_not_installed':
      return `${SETTING_LABEL} turned off because the ${FORMATTING_MODEL_LABELS[settings.formatterModelTier]} Formatting Model is not installed.`
  }
}

export interface SelfCorrectionCleanupHealResult {
  /** The corrected toggle. */
  selfCorrectionCleanup: boolean
  /** Why it was switched off, or `null` when nothing changed. */
  healed: {
    reason: SelfCorrectionCleanupReadinessReason
    message: string
  } | null
}

/**
 * The availability arm: run at boot and whenever a Formatting Model is downloaded or
 * removed. Only ever switches the setting off, and says why; a setting that is off, or that
 * can run, is returned as it is.
 */
export function healSelfCorrectionCleanup(
  settings: SelfCorrectionCleanupSettings,
  availability: SelfCorrectionCleanupAvailability
): SelfCorrectionCleanupHealResult {
  if (!settings.selfCorrectionCleanup) {
    return { selfCorrectionCleanup: false, healed: null }
  }
  const readiness = getSelfCorrectionCleanupReadiness(settings, availability)
  if (readiness.ready) {
    return { selfCorrectionCleanup: true, healed: null }
  }
  return {
    selfCorrectionCleanup: false,
    healed: {
      reason: readiness.reason,
      message: selfCorrectionCleanupHealMessage(settings, readiness.reason),
    },
  }
}

export type SelfCorrectionCleanupWriteOutcome =
  | {
      kind: 'accepted'
      /** The toggle to store, corrected if the write made it unrunnable. */
      selfCorrectionCleanup: boolean
      /** Set when the write switched it off as collateral, to be announced. */
      healed: SelfCorrectionCleanupHealResult['healed']
    }
  | {
      kind: 'refused'
      reason: SelfCorrectionCleanupReadinessReason
    }

/**
 * The write arm: validate the settings a formatting write would produce, not the patch.
 *
 * A patch that turns Self-correction Cleanup on while it cannot run is refused whole, because
 * the user is right there and can fix it. A patch that never mentioned it but leaves it
 * unrunnable - selecting a Formatting Model that is not downloaded - is accepted with the
 * setting switched off and announced, the same split `applyRunnableDictationPatch` draws.
 */
export function applySelfCorrectionCleanupPatch(
  next: SelfCorrectionCleanupSettings,
  patchTurnsItOn: boolean,
  availability: SelfCorrectionCleanupAvailability
): SelfCorrectionCleanupWriteOutcome {
  const healed = healSelfCorrectionCleanup(next, availability)
  if (healed.healed !== null && patchTurnsItOn) {
    return { kind: 'refused', reason: healed.healed.reason }
  }
  return {
    kind: 'accepted',
    selfCorrectionCleanup: healed.selfCorrectionCleanup,
    healed: healed.healed,
  }
}
