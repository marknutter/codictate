/**
 * The **Scratch Command**: the spoken phrase "scratch that", which removes itself and the
 * phrase before it from a transcript.
 *
 * A text rule, not a model. It works offline, costs nothing and behaves the same every time,
 * where a model would guess. See docs/adr/0008-live-transcription-stages-in-an-overlay.md.
 *
 * Pure and idempotent: text with no Scratch Command in it comes back unchanged, so it is safe
 * to apply to a running Live Transcription on every update as well as once to a Batch
 * Dictation's Raw Transcript.
 */

/**
 * Transcription Languages the phrase is recognised in. English only for now, plus automatic
 * detection because an English speaker on `auto` says it in English. Other languages get
 * their own phrases when someone who speaks them chooses them.
 */
const SCRATCH_COMMAND_LANGUAGE_IDS: ReadonlySet<string> = new Set([
  'en',
  'auto',
])

/**
 * Whether the Scratch Command applies to a Dictation in this Transcription Language. Pass the
 * Dictation Plan's language, never a live config read (ADR-0005).
 */
export function scratchCommandAppliesToLanguage(
  transcriptionLanguageId: string
): boolean {
  return SCRATCH_COMMAND_LANGUAGE_IDS.has(transcriptionLanguageId)
}

/**
 * "scratch that" as whole words, case-insensitive, plus any punctuation the Speech Engine
 * attached after it ("Scratch that." / "scratch that,"). `\b` on both ends leaves
 * "scratchthat" and "scratch thatch" alone, and the lookahead leaves "scratch that's".
 */
const SCRATCH_COMMAND_PATTERN =
  /\bscratch\s+that\b(?!['’]\w)(?:\s*[,.;:!?…]+)?/gi

/** A sentence boundary: terminal punctuation followed by whitespace. */
const SENTENCE_BOUNDARY_PATTERN = /[.?!]\s+/g

/** Whitespace and punctuation left dangling at either side of a removal. */
const TRAILING_SEAM_PATTERN = /[\s,.;:!?…]+$/
const LEADING_SEAM_PATTERN = /^[\s,.;:!?…]+/

/** Where the phrase that ends `text` starts: just past its last sentence boundary, or 0. */
function lastSentenceStart(text: string): number {
  let start = 0
  for (const match of text.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    start = match.index + match[0].length
  }
  return start
}

/**
 * Applies every Scratch Command in `text`, left to right.
 *
 * Each command removes itself and the phrase before it: back to the previous sentence
 * boundary (`.`, `?` or `!` followed by whitespace, or the start of the text) or back to the
 * previous Scratch Command, whichever is later. When nothing was said since the previous
 * command, that command no longer bounds the removal, so repeated commands each remove one
 * more phrase ("One. Two. Three. scratch that scratch that" is "One."). A command with
 * nothing before it removes only itself.
 *
 * The seams are tidied - one space where text meets text, no orphaned leading punctuation,
 * no surrounding whitespace - but casing and everything away from a removal is left as the
 * Speech Engine wrote it.
 */
export function applyScratchCommand(text: string): string {
  const commands = [...text.matchAll(SCRATCH_COMMAND_PATTERN)]
  if (commands.length === 0) return text

  let kept = ''
  // Positions in `kept` where an earlier command cut, innermost last. Each one bounds the
  // next removal until a command arrives with nothing new said since it.
  const floors: number[] = []
  let cursor = 0

  const append = (segment: string, afterCommand: boolean): void => {
    const trimmed = afterCommand
      ? segment.replace(LEADING_SEAM_PATTERN, '')
      : segment.trimStart()
    if (trimmed === '') return
    kept = kept === '' ? trimmed : `${kept.trimEnd()} ${trimmed}`
  }

  for (const command of commands) {
    append(text.slice(cursor, command.index), cursor > 0)
    cursor = command.index + command[0].length

    // The phrase being scratched, without the punctuation that ended it, so its own full
    // stop is not mistaken for the boundary before it.
    const phrase = kept.replace(TRAILING_SEAM_PATTERN, '')
    while (floors.length > 0 && floors[floors.length - 1] >= phrase.length) {
      floors.pop()
    }
    const floor = floors.length > 0 ? floors[floors.length - 1] : 0
    const start = Math.max(lastSentenceStart(phrase), floor)

    kept = kept.slice(0, start).trimEnd()
    if (floors[floors.length - 1] !== kept.length) floors.push(kept.length)
  }
  append(text.slice(cursor), true)

  return kept.trim()
}

/**
 * A Live Transcription's staged text as History keeps it when it is not pasted (a failed
 * session, or a stop the app made): with the Scratch Command applied by the same rule the
 * Staging Overlay showed and the paste would have used, so a phrase the user watched
 * disappear does not come back in History. Trimmed; an empty result means nothing is left to
 * keep. Pass the Dictation Plan's Transcription Language.
 */
export function stagedTextForHistory(
  text: string,
  transcriptionLanguageId: string
): string {
  const scratched = scratchCommandAppliesToLanguage(transcriptionLanguageId)
    ? applyScratchCommand(text)
    : text
  return scratched.trim()
}
