import Foundation

/// Live Transcription's stdout protocol: one NDJSON event per line, read by Bun.
///
/// The helper no longer types into the focused app. It reports what it heard and Bun keeps the
/// running transcript, shows it, and pastes once when the Dictation ends, through the same
/// pipeline a Batch Dictation uses. See docs/adr/0008-live-transcription-stages-in-an-overlay.md.
/// The TypeScript side of this contract is `src/shared/parakeet-stream-protocol.ts`; the Windows
/// helper writes the same three events.
///
/// - `{"kind":"partial","text":…}` — the current hypothesis for the segment in progress. Replaces
///   the previous partial; it is never appended to it.
/// - `{"kind":"commit","text":…}` — a finished segment. Clears the partial. An empty commit is a
///   segment that turned out to hold nothing, and only clears the partial.
/// - `{"kind":"final"}` — the session ended normally, after the last commit. A session that
///   exits without one did not end normally.
///
/// Logs stay on stderr; stdout carries nothing but these events.
final class StreamEventSink: @unchecked Sendable {
  static let shared = StreamEventSink()

  /// Serialises the audio loop's writes against the stop path's, which runs on a signal or
  /// stdin queue and must not interleave half a line with the loop's.
  private let lock = NSLock()
  /// The last partial written and not yet committed. The stop path commits it when the audio
  /// loop cannot finish the segment in time, so the words the user saw are the words pasted.
  private var inFlightPartial = ""
  private var finished = false

  func partial(_ text: String) {
    lock.lock()
    defer { lock.unlock() }
    guard !finished else { return }
    inFlightPartial = text
    write(["kind": "partial", "text": text])
  }

  func commit(_ text: String) {
    lock.lock()
    defer { lock.unlock() }
    guard !finished else { return }
    if text.isEmpty && inFlightPartial.isEmpty { return }
    inFlightPartial = ""
    write(["kind": "commit", "text": text])
  }

  /// Ends the session normally: commit whatever partial is still in flight, write `final`,
  /// run `cleanup`, exit 0. Safe to reach from the audio loop and from the stop watchdog at
  /// once; the first caller writes, and both exit.
  func finishAndExit(cleanup: () -> Void) -> Never {
    lock.lock()
    if !finished {
      finished = true
      let pending = inFlightPartial.trimmingCharacters(in: .whitespacesAndNewlines)
      if !pending.isEmpty {
        write(["kind": "commit", "text": pending])
      }
      inFlightPartial = ""
      write(["kind": "final"])
    }
    cleanup()
    exit(0)
  }

  /// Caller holds `lock`. A closed stdout is not fatal here: `SIGPIPE` is ignored in stream
  /// mode and `write(contentsOf:)` throws instead of raising, so a vanished host costs the
  /// events and nothing else.
  private func write(_ obj: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(0x0a)
    try? FileHandle.standardOutput.write(contentsOf: data)
  }
}

/// How Bun ends a stream session: `stop` on stdin, or stdin closing. SIGINT and SIGTERM mean
/// the same thing, so a stop from a terminal or a process manager also ends the session cleanly.
/// (`cancel` on stdin skips all of this; see `handleStreamCancel`.)
///
/// A stop does not exit on the spot. It ends the audio loop, which transcribes the segment in
/// progress before it writes `final` - otherwise the last words before a push-to-talk release
/// would be lost whenever they had not reached a partial yet. A watchdog bounds that wait.
final class StreamStopRequest: @unchecked Sendable {
  static let shared = StreamStopRequest()

  /// How long the audio loop gets to finish its last segment after a stop.
  static let drainDeadlineSeconds: TimeInterval = 3

  private let lock = NSLock()
  private var requested = false
  private var drain: (() -> Void)?

  var isRequested: Bool {
    lock.lock()
    defer { lock.unlock() }
    return requested
  }

  /// Registers what ends the audio loop. Runs it straight away when the stop already arrived.
  func setDrain(_ drain: @escaping () -> Void) {
    lock.lock()
    let alreadyRequested = requested
    if !alreadyRequested { self.drain = drain }
    lock.unlock()
    if alreadyRequested { drain() }
  }

  /// Returns whether this was the first stop, and whether an audio loop was there to drain.
  fileprivate func request() -> (first: Bool, drained: Bool) {
    lock.lock()
    let first = !requested
    requested = true
    let drain = self.drain
    self.drain = nil
    lock.unlock()
    if first, let drain { drain() }
    return (first, drain != nil)
  }
}

/// Every stop source lands here: the first stop drains the audio loop under a deadline; a stop
/// before the loop exists, or a second stop, finishes at once.
private func handleStreamStop(source: String, cleanup: @escaping @Sendable () -> Void) {
  let (first, drained) = StreamStopRequest.shared.request()
  logPhase("stream: stop requested (\(source))")
  guard first, drained else {
    StreamEventSink.shared.finishAndExit(cleanup: cleanup)
  }
  DispatchQueue.global(qos: .userInitiated).asyncAfter(
    deadline: .now() + StreamStopRequest.drainDeadlineSeconds
  ) {
    logPhase("stream: drain deadline passed — finishing with the last partial")
    StreamEventSink.shared.finishAndExit(cleanup: cleanup)
  }
}

private enum StreamStopSources {
  nonisolated(unsafe) static var sigint: DispatchSourceSignal?
  nonisolated(unsafe) static var sigterm: DispatchSourceSignal?
}

/// Installs every stop source for a stream session. `cleanup` runs once, just before exit.
func installStreamStopHandlers(cleanup: @escaping @Sendable () -> Void) {
  signal(SIGPIPE, SIG_IGN)

  let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global(qos: .userInitiated))
  sigint.setEventHandler { handleStreamStop(source: "SIGINT", cleanup: cleanup) }
  signal(SIGINT, SIG_IGN)
  sigint.resume()

  let sigterm = DispatchSource.makeSignalSource(
    signal: SIGTERM, queue: .global(qos: .userInitiated))
  sigterm.setEventHandler { handleStreamStop(source: "SIGTERM", cleanup: cleanup) }
  signal(SIGTERM, SIG_IGN)
  sigterm.resume()

  StreamStopSources.sigint = sigint
  StreamStopSources.sigterm = sigterm

  // Same contract as the Windows helper: a `stop` line, or EOF when the host goes away, so an
  // orphaned helper does not keep the microphone open. A `cancel` line ends the session at once.
  Thread.detachNewThread {
    var cancelled = false
    while let line = readLine() {
      let command = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if command == "stop" { break }
      if command == "cancel" {
        cancelled = true
        break
      }
    }
    if cancelled {
      handleStreamCancel(cleanup: cleanup)
    } else {
      handleStreamStop(source: "stdin", cleanup: cleanup)
    }
  }
}

/// `cancel` on stdin: Bun will not paste this session's text (Escape, or a stop the app made),
/// so there is no reason to wait for the segment in progress. Commit the partial last written,
/// if any, write `final` and exit 0 now, with no final transcription pass, so Bun can release
/// the Dictation pipeline straight away. Safe against the audio loop and a stop watchdog: the
/// sink's lock lets only one of them write `final`.
private func handleStreamCancel(cleanup: @escaping @Sendable () -> Void) -> Never {
  logPhase("stream: cancel requested (stdin) — finishing without a final pass")
  StreamEventSink.shared.finishAndExit(cleanup: cleanup)
}
