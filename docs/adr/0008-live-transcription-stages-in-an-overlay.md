# Live Transcription stages its text in an overlay and pastes once

Live Transcription types into the focused app while the user speaks. Every revision Parakeet
makes becomes a burst of synthetic Backspace presses followed by a clipboard paste, so the field
flickers, terminal multiplexers such as zellij receive dozens of pastes per sentence, the
clipboard is overwritten on every update, and a mistake can only be fixed in the target field
once it has landed. Because the Native Helper pastes the text itself, Codictate never sees it:
Live Transcription skips the Dictionary and the Formatting Mode, and ADR-0006 left it outside
the Dictation Outcome for that reason.

The decision is that **Live Transcription shows the running transcript in a floating overlay
and inserts nothing until the Dictation ends**. It then pastes once, through the same pipeline a
Batch Dictation uses. This is the "decision for its own day" ADR-0006 deferred: the helpers
stream their text back and Codictate owns the paste in both modes.

Two ways to correct a mistake come with it, both chosen by the user over a key binding:

- **Scratch command** - saying "scratch that" removes the previous phrase from the staged text.
- **Self-correction cleanup** - at commit, a Formatting Model resolves spoken self-corrections,
  so "meet at three, no, four" is pasted as "meet at four".

## The overlay replaces paste-as-you-go

There is one Live Transcription behaviour, not two. Keeping type-as-you-go beside the overlay
would put a third Dictation mode in front of every later feature on both platforms, and its one
advantage - text appearing in the target app immediately - is the source of every problem above.

The overlay is the recording indicator grown into a text panel, not a new window type: the
AppKit `NSPanel` in `CodictateWindowHelper` and the Win32 layered window in
`CodictateWindowsHelper`. It keeps the indicator's properties that already work in fullscreen
Spaces and AeroSpace, and it never takes focus, so the paste at commit lands in whatever app has
focus at that moment, the same rule a Batch Dictation follows.

## The helpers stream events instead of pasting

Both Parakeet Native Helpers stop injecting text. In `stream` mode they write NDJSON events to
stdout: a partial hypothesis for the segment in progress, a committed segment when silence ends
one, and a final event when the session stops. Bun owns the running transcript, applies the
Scratch command to it, sends it to the overlay, and on stop hands the text to the Dictation
pipeline. Clipboard and synthetic-key injection move out of the helpers, on macOS and Windows in
the same change.

## What is pasted is what was shown

The pasted text is the staged transcript, after the Scratch command, then the Dictionary,
Self-correction cleanup and the Formatting Mode. It is not a fresh batch transcription of the
whole recording. Re-transcribing would be marginally more accurate, but it would discard every
Scratch command the user saw take effect, because those act on text rather than on audio.

## Self-correction cleanup is a pipeline step with its own readiness

Self-correction cleanup runs in the Dictation pipeline for both Batch Dictation and Live
Transcription, after the Dictionary and before the Formatting Mode, and only when the user has
turned it on. It needs an installed Formatting Model, so it follows ADR-0005: unavailable in the
UI and healed off when no model is installed, never a silent skip at run time. With S1-mini it
applies to English transcripts only, as ADR-0007 already requires. It adds the Formatting Model's
inference time to the end of every Dictation it runs on, which is why it is a setting and not a
default behaviour.

This amends ADR-0007's exclusion of Live Transcription: that exclusion existed because rewriting
already-inserted text needed a separate design, and with nothing inserted until commit the
reason is gone.

## The Scratch command is a text rule

"Scratch that" is recognised in the transcript, not by a model: case-insensitive, as whole words,
ignoring surrounding punctuation. It removes itself and the phrase before it, back to the previous
sentence boundary or the previous Scratch command. A deterministic rule works offline, costs
nothing and behaves the same every time; a model would guess. The phrase is English only for now;
other Transcription Languages get their own phrases when someone who speaks them chooses them.

## Failure

A helper that exits non-zero mid-session is a failed Dictation under ADR-0006: error chime, tray
error state, the message on the banner or notification. Nothing is pasted, and the staged text is
written to History so the words are not lost.

## Considered and rejected

- **Backspace deletes the last word while dictating.** Both key hooks can already swallow a key,
  but Hold dictation means holding a shortcut while pressing another key. Not chosen.
- **Keep type-as-you-go as a separate mode.** See above.
- **Clicking a word in the overlay to fix it.** Needs the overlay to take focus, which breaks the
  paste target and the fullscreen-Space behaviour the indicator was rebuilt natively to get.
