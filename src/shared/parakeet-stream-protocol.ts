/**
 * NDJSON protocol for a Live Transcription session, and the running transcript built from it.
 *
 * `CodictateParakeetHelper stream` (macOS) and `CodictateWindowsHelper stream` (Windows) no
 * longer type into the focused app. They write one event per stdout line and Bun keeps the
 * running transcript, shows it, and pastes once when the Dictation ends, through the same
 * pipeline a Batch Dictation uses. See docs/adr/0008-live-transcription-stages-in-an-overlay.md.
 *
 * Pure on purpose - no Bun, no process, no platform - so the parser and the accumulator are
 * covered by the default `bun test` run. The spawning lives in `parakeet-stream-runner.ts`.
 */

export type ParakeetStreamEvent =
  /**
   * The current hypothesis for the segment in progress. Replaces the previous partial; it is
   * never appended to it, because Parakeet revises the whole segment on every pass.
   */
  | { kind: 'partial'; text: string }
  /**
   * A finished segment, which clears the partial. An empty commit is a segment that turned out
   * to hold nothing: it clears the partial and adds no segment.
   */
  | { kind: 'commit'; text: string }
  /**
   * The session ended normally, after its last commit. A helper that exits without writing
   * one did not end normally, whatever its exit code says.
   */
  | { kind: 'final' }

export function encodeParakeetStreamEvent(event: ParakeetStreamEvent): string {
  return JSON.stringify(event)
}

/** Parse one stdout line, or `null` when it is not an event this protocol defines. */
export function parseParakeetStreamEvent(
  line: string
): ParakeetStreamEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.kind === 'final') return { kind: 'final' }
  if (
    (record.kind === 'partial' || record.kind === 'commit') &&
    typeof record.text === 'string'
  ) {
    return { kind: record.kind, text: record.text }
  }
  return null
}

/**
 * The line Bun writes to a stream helper's stdin to end the session.
 *
 * - `stop` - finish normally: the helper transcribes the segment in progress, commits it,
 *   writes `final` and exits 0, within its own drain deadline.
 * - `cancel` - finish now: the helper commits the partial it last reported, if any, writes
 *   `final` and exits 0 with no final transcription pass. For a session whose text will not
 *   be pasted, so the Dictation pipeline is released in milliseconds rather than after a pass.
 *
 * Both helpers also treat stdin closing as `stop`.
 */
export type StreamStopCommand = 'stop' | 'cancel'

/**
 * Which stop line a Live Transcription ending sends. Only an ending that pastes (`commit`)
 * needs the final pass; Escape (`cancel`) and an app-initiated stop (`abandon`) do not, and
 * the shortcut is refused until the helper has exited.
 */
export function streamStopCommandFor(
  intent: 'commit' | 'cancel' | 'abandon'
): StreamStopCommand {
  return intent === 'commit' ? 'stop' : 'cancel'
}

/**
 * What the Staging Overlay needs from a running transcript: the whole visible text, and the
 * part of it that is committed. `text` always starts with `committedText`; the rest is the
 * partial for the segment in progress, which Parakeet may still revise.
 */
export interface LiveTranscriptSnapshot {
  text: string
  committedText: string
}

/** Collapses whitespace runs so segments join with exactly one space. */
function normaliseSegment(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * The running transcript of one Live Transcription: committed segments plus the partial
 * for the segment in progress.
 *
 * `text()` is what the user sees while speaking; `finalText()` is what reaches the Dictation
 * pipeline when the session stops. They differ only in intent today - both include a trailing
 * partial, because the words the user watched are the words that should be pasted
 * (ADR-0008: what is pasted is what was shown) - and the two names keep the call sites honest
 * about which one they mean.
 */
export class LiveTranscript {
  private readonly segments: string[] = []
  private partial = ''

  /** Applies one event. Returns whether the visible text changed. */
  apply(event: ParakeetStreamEvent): boolean {
    const before = this.text()
    switch (event.kind) {
      case 'partial':
        this.partial = normaliseSegment(event.text)
        break
      case 'commit': {
        const segment = normaliseSegment(event.text)
        if (segment !== '') this.segments.push(segment)
        this.partial = ''
        break
      }
      case 'final':
        break
    }
    return this.text() !== before
  }

  /** Committed segments and the current partial, joined with single spaces. */
  text(): string {
    return this.join(this.partial)
  }

  /** The committed segments only, joined with single spaces. No partial. */
  committedText(): string {
    return this.segments.join(' ')
  }

  /** `text()` and `committedText()` together, for the Staging Overlay. */
  snapshot(): LiveTranscriptSnapshot {
    return { text: this.text(), committedText: this.committedText() }
  }

  /**
   * The staged text once the session has stopped: the committed segments plus any partial a
   * segment never got to commit. Empty when nothing was heard.
   */
  finalText(): string {
    return this.join(this.partial)
  }

  private join(partial: string): string {
    return partial === ''
      ? this.segments.join(' ')
      : [...this.segments, partial].join(' ')
  }
}
