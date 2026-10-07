/**
 * What the Staging Overlay shows for a running Live Transcription.
 *
 * Pure: no Bun, no process, no platform. The indicator handle in `setup-indicator-window.ts`
 * calls it and sends the result to the native helper as a `text` command. See
 * docs/RECORDING_INDICATOR.md and docs/adr/0008-live-transcription-stages-in-an-overlay.md.
 */

import type { LiveTranscriptSnapshot } from '../../../shared/parakeet-stream-protocol'
import {
  applyScratchCommand,
  scratchCommandAppliesToLanguage,
} from '../../../shared/scratch-command'

/**
 * One update of the running transcript, with the Transcription Language of the Dictation
 * Plan the stream was started from - never a live config read (ADR-0005).
 */
export interface LiveTranscriptUpdate extends LiveTranscriptSnapshot {
  transcriptionLanguageId: string
}

/**
 * The overlay's text, split so the native helpers can style the two parts differently.
 * The helpers draw `committed + partial` verbatim - no separator is added between them - so
 * `partial` carries its own leading space when it starts a new word.
 */
export interface StagingOverlayText {
  /** Text Parakeet will not revise: full-opacity foreground. */
  committed: string
  /** The segment in progress, which Parakeet may still revise: dimmer. */
  partial: string
}

/**
 * The most characters the overlay is sent. Comfortably more than its four visible lines hold,
 * so the native side always has the last full lines to show, and small enough that a long
 * Dictation does not resend kilobytes on every partial.
 */
export const STAGING_OVERLAY_MAX_CHARS = 240

/** Prefix that marks text cut from the front of a long transcript. */
export const STAGING_OVERLAY_ELLIPSIS = '…'

export const EMPTY_STAGING_OVERLAY_TEXT: StagingOverlayText = {
  committed: '',
  partial: '',
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index++
  return index
}

/**
 * Where the tail that fits starts: the first word that begins inside the last `maxChars`
 * characters. A transcript whose tail is one unbroken run of characters is cut mid-run,
 * because there is no word boundary to cut at.
 */
function tailStart(text: string, maxChars: number): number {
  if (text.length <= maxChars) return 0
  const cut = text.length - maxChars
  // A cut that already lands on a word start needs no adjustment.
  if (/\s/.test(text[cut - 1] ?? '')) return cut
  const rest = text.slice(cut)
  const boundary = rest.search(/\s\S/)
  return boundary < 0 ? cut : cut + boundary + 1
}

/**
 * Shapes a running transcript for the Staging Overlay.
 *
 * 1. The Scratch Command is applied when the plan's Transcription Language is eligible
 *    (`scratchCommandAppliesToLanguage`), so the overlay shows a scratched phrase disappear as
 *    it is spoken. `outcomeFromTranscript` applies the same function to the same text at the
 *    end, so the overlay and the paste agree (ADR-0008: what is pasted is what was shown).
 * 2. The result is trimmed. An empty result means "collapse back to the orb".
 * 3. The committed/partial split is the longest common prefix of the shaped whole text and
 *    the shaped committed text. A Scratch Command spoken in the partial can remove committed
 *    words, so the shaped committed text is not always a prefix of the shaped whole; the
 *    common prefix is what both agree on.
 * 4. Only the tail that fits is kept: at most `maxChars` characters, cut at a word boundary,
 *    with `…` in front when anything was cut. The `…` belongs to whichever part the first
 *    kept character belongs to.
 */
export function shapeStagingOverlayText(
  update: LiveTranscriptUpdate,
  maxChars: number = STAGING_OVERLAY_MAX_CHARS
): StagingOverlayText {
  const scratch = scratchCommandAppliesToLanguage(
    update.transcriptionLanguageId
  )
    ? applyScratchCommand
    : (text: string) => text
  const whole = scratch(update.text).trim()
  if (whole === '') return EMPTY_STAGING_OVERLAY_TEXT
  const committedWhole = scratch(update.committedText).trim()
  const committedLength = commonPrefixLength(whole, committedWhole)

  const start = tailStart(whole, Math.max(1, maxChars))
  const prefix = start > 0 ? STAGING_OVERLAY_ELLIPSIS : ''
  const keptCommittedLength = Math.max(0, committedLength - start)
  const committed = whole.slice(start, start + keptCommittedLength)
  const partial = whole.slice(start + keptCommittedLength)

  return committed !== ''
    ? { committed: prefix + committed, partial }
    : { committed: '', partial: prefix + partial }
}

/** Whether two overlay texts draw the same thing. */
export function stagingOverlayTextEquals(
  a: StagingOverlayText,
  b: StagingOverlayText
): boolean {
  return a.committed === b.committed && a.partial === b.partial
}

/** Whether the overlay has anything to show; `false` means the orb alone. */
export function stagingOverlayTextIsEmpty(text: StagingOverlayText): boolean {
  return text.committed === '' && text.partial === ''
}
