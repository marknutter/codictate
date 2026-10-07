/**
 * The Self-correction Cleanup step of the Dictation pipeline: after the Dictionary, before
 * the Formatting Mode, and only when the user turned "Clean up self-corrections" on. It
 * resolves spoken self-corrections ("meet at three, no, four" becomes "meet at four") with
 * the selected Formatting Model and otherwise leaves the text and its wording alone. See
 * CONTEXT.md and docs/adr/0008-live-transcription-stages-in-an-overlay.md.
 *
 * Whether the setting *can* be on is decided elsewhere (src/shared/self-correction-cleanup.ts,
 * ADR-0005): it is unavailable in Settings, refused on write and healed off when no
 * Formatting Model is installed, so this step never adapts to an unrunnable configuration.
 * What is decided here is only what this one transcript gets, by the pure
 * `resolveSelfCorrectionCleanupStep`.
 *
 * **Per Formatting Model.**
 *
 * - **Qwen** gets a dedicated, minimal instruction that resolves self-corrections and nothing
 *   else - no restyling, that is the Formatting Mode's job - through the same constrained-JSON
 *   runner and output contract every other Qwen call uses. Any Transcription Language.
 * - **S1-mini** cannot take arbitrary instructions (ADR-0007); its documented normalisation
 *   protocol already resolves self-corrections as part of its cleanup. So:
 *   - When the Formatting Mode will run S1-mini on this same transcript anyway (Auto-polish
 *     on and the transcript eligible), this step does not run. Running the same model over
 *     the same text twice doubles the latency for no change: the Formatting Mode's S1-mini
 *     pass resolves the self-corrections itself, and it still happens after the Dictionary,
 *     which is the ordering this step promises.
 *   - When Auto-polish is off, this step is the only S1-mini pass, and it runs S1-mini's
 *     protocol with the user's general writing style and `prose` structure, so no bullets
 *     are introduced by a step that is not a Formatting Mode. S1-mini's cleanup is broader
 *     than self-corrections alone (it also normalises punctuation, spoken numbers and
 *     fillers); that is the model's documented capability, not something this step can
 *     narrow, and Settings says which model will run.
 *   - English transcripts only, with ADR-0007's own eligibility check. Anything else is left
 *     as spoken - the same rule the S1-mini Formatting Mode follows, not a fallback to Qwen.
 *
 * **Failure** follows ADR-0006's rule for the Formatting Backend: an inference failure keeps
 * the uncleaned transcript, which continues to the Formatting Mode and is pasted; it is
 * logged, and never turns into an empty paste. A successful empty result for a non-empty
 * transcript is treated as a failure too, because a step that only removes replaced words
 * cannot honestly remove all of them.
 */

import type {
  FormatterModelTier,
  FormattingRuntimeSettings,
} from '../../shared/types'
import { getFormatterModelConfig } from '../platform/runtime'
import { log } from '../utils/logger'
import { runLlamaFormatter } from '../utils/formatting/llama-runner'
import {
  buildSelfCorrectionInstructions,
  buildSelfCorrectionUserPrompt,
} from '../utils/formatting/prompts'
import { isEnglishTranscriptEligible } from '../utils/formatting/resolve-formatting-request'
import type { S1Controls } from '../utils/formatting/s1-protocol'
import { runS1Formatter } from '../utils/formatting/s1-runner'
import {
  selfCorrectionSchema,
  type SelfCorrectedText,
} from '../utils/formatting/schemas'

/** Why this transcript gets no Self-correction Cleanup pass. */
export type SelfCorrectionCleanupSkipReason =
  /** The user has not turned "Clean up self-corrections" on. */
  | 'setting_off'
  /** Nothing to clean. */
  | 'empty_transcript'
  /** S1-mini is selected and the transcript is not confidently English (ADR-0007). */
  | 's1_not_english'
  /** The Formatting Mode will run S1-mini on this transcript and resolves them itself. */
  | 's1_formatting_mode_resolves'

export type SelfCorrectionCleanupStep =
  | { kind: 'skip'; reason: SelfCorrectionCleanupSkipReason }
  | {
      kind: 'qwen'
      modelTier: Exclude<FormatterModelTier, 's1-mini'>
      /** Transcription Language for the language rule ('auto' lets the model detect). */
      languageId: string
    }
  | { kind: 's1-mini'; controls: S1Controls }

/**
 * Decide what Self-correction Cleanup does with this transcript. Pure: the settings carry
 * everything, including the Transcription Language the pipeline resolved (English when
 * Translate to English ran).
 */
export function resolveSelfCorrectionCleanupStep(
  transcript: string,
  settings: Pick<
    FormattingRuntimeSettings,
    | 'selfCorrectionCleanup'
    | 'formatterModelTier'
    | 'enabled'
    | 'transcriptionLanguageId'
    | 's1'
  >
): SelfCorrectionCleanupStep {
  if (!settings.selfCorrectionCleanup) {
    return { kind: 'skip', reason: 'setting_off' }
  }
  if (transcript.trim() === '') {
    return { kind: 'skip', reason: 'empty_transcript' }
  }

  if (settings.formatterModelTier === 's1-mini') {
    if (
      !isEnglishTranscriptEligible(transcript, settings.transcriptionLanguageId)
    ) {
      return { kind: 'skip', reason: 's1_not_english' }
    }
    // Same condition under which `buildFormatterRequest` hands S1-mini this transcript: the
    // master switch, then English eligibility (checked above). The Formatting Mode runs
    // after this step on text this step would not have changed, so the S1-mini pass there
    // resolves the self-corrections and a second pass here would only add latency.
    if (settings.enabled) {
      return { kind: 'skip', reason: 's1_formatting_mode_resolves' }
    }
    return {
      kind: 's1-mini',
      controls: {
        styling: settings.s1.styling,
        structure: 'prose',
        context: 'general',
      },
    }
  }

  return {
    kind: 'qwen',
    modelTier: settings.formatterModelTier,
    languageId: settings.transcriptionLanguageId,
  }
}

/**
 * The model's answer, accepted or not. Trimmed text when it is usable; `null` when it is not
 * - an empty or whitespace-only result for a non-empty transcript, which the caller treats as
 * a failure and keeps the input.
 */
export function acceptSelfCorrectionOutput(
  input: string,
  output: string
): string | null {
  const trimmed = output.trim()
  if (trimmed === '' && input.trim() !== '') return null
  return trimmed
}

/**
 * Output budget for the Qwen pass. The answer is the transcript minus the replaced words, so
 * it scales with the input; the floor matches the other Qwen calls and the ceiling keeps a
 * runaway generation bounded.
 */
export function selfCorrectionMaxTokens(transcript: string): number {
  return Math.min(2048, Math.max(512, Math.ceil(transcript.length / 2)))
}

export type SelfCorrectionCleanupResult =
  | { status: 'cleaned'; text: string }
  | { status: 'skipped'; reason: SelfCorrectionCleanupSkipReason; text: string }
  /** Inference failed or returned nothing usable; `text` is the uncleaned input. */
  | { status: 'failed'; text: string; error: string }

async function runStep(
  transcript: string,
  step: Exclude<SelfCorrectionCleanupStep, { kind: 'skip' }>
): Promise<string> {
  if (step.kind === 's1-mini') {
    return runS1Formatter({
      transcript,
      ...step.controls,
      modelPath: getFormatterModelConfig('s1-mini').path,
    })
  }
  const result = await runLlamaFormatter<SelfCorrectedText>({
    systemPrompt: buildSelfCorrectionInstructions(step.languageId),
    userPrompt: buildSelfCorrectionUserPrompt(transcript),
    schema: selfCorrectionSchema,
    modelTier: step.modelTier,
    maxTokens: selfCorrectionMaxTokens(transcript),
    debugTag: 'self-correction',
  })
  return typeof result.text === 'string' ? result.text : ''
}

/**
 * Run the step. Never throws and never returns less than it was given on failure: whatever
 * goes wrong, the result's `text` is something honest to hand to the Formatting Mode.
 */
export async function applySelfCorrectionCleanup(
  transcript: string,
  settings: FormattingRuntimeSettings
): Promise<SelfCorrectionCleanupResult> {
  const step = resolveSelfCorrectionCleanupStep(transcript, settings)
  if (step.kind === 'skip') {
    if (step.reason !== 'setting_off') {
      log('self-correction', 'skip', { reason: step.reason })
    }
    return { status: 'skipped', reason: step.reason, text: transcript }
  }

  log('self-correction', 'running', {
    model: step.kind === 'qwen' ? step.modelTier : 's1-mini',
    length: transcript.length,
  })
  try {
    const output = await runStep(transcript, step)
    const accepted = acceptSelfCorrectionOutput(transcript, output)
    if (accepted === null) {
      console.error(
        '[self-correction] empty output, keeping the uncleaned transcript'
      )
      log(
        'self-correction',
        'empty output - keeping the uncleaned transcript',
        {
          model: step.kind === 'qwen' ? step.modelTier : 's1-mini',
        }
      )
      return {
        status: 'failed',
        text: transcript,
        error: 'empty output for a non-empty transcript',
      }
    }
    log('self-correction', 'complete', {
      originalLength: transcript.length,
      cleanedLength: accepted.length,
      changed: accepted !== transcript.trim(),
    })
    return { status: 'cleaned', text: accepted }
  } catch (err) {
    // Reported outside debug logging too: the user turned this on, and a cleanup that
    // silently stopped working would look like the model ignoring their corrections.
    console.error(
      '[self-correction] inference failed, keeping the uncleaned transcript:',
      err
    )
    log(
      'self-correction',
      'inference failed - keeping the uncleaned transcript',
      {
        model: step.kind === 'qwen' ? step.modelTier : 's1-mini',
        error: String(err),
      }
    )
    return { status: 'failed', text: transcript, error: String(err) }
  }
}
