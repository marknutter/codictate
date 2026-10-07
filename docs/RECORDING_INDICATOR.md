# Recording indicator

A floating status HUD that shows the current dictation state: `ready`, `recording`, or `transcribing`. Implemented natively on both macOS and Windows. During a Live Transcription it grows into the **Staging Overlay**, a text panel beside the orb showing the running transcript (see [Staging Overlay](#staging-overlay) below and `docs/adr/0008-live-transcription-stages-in-an-overlay.md`).

## Architecture

The indicator is a native AppKit `NSPanel` managed by `CodictateWindowHelper` — a separate Swift helper process. The main Bun process sends `show` / `hide` / `status` / `theme` / `text` commands over stdin/stdout (see [Command protocol](#command-protocol)).

Key files:

| File | Role |
|------|------|
| `native/CodictateWindowHelper/Sources/.../main.swift` | NSPanel, drawing, animation, drag |
| `src/bun/utils/window/native-indicator-helper.ts` | Spawns helper, sends commands |
| `src/bun/setup-indicator-window.ts` | Decides when/where to show the indicator, and when to send overlay text |
| `src/bun/utils/window/staging-overlay-text.ts` | Shapes the running transcript into the overlay's text (pure) |

## Why native AppKit

An earlier implementation used an Electrobun `BrowserWindow`. It worked in normal Spaces but failed in native macOS fullscreen Spaces. Moving to a native `NSPanel` fixed both fullscreen Spaces and AeroSpace. Bun FFI was also ruled out — it crashed when driving an `NSPanel` directly across the dylib boundary.

## Panel behaviour

The NSPanel uses `.canJoinAllSpaces`, `.fullScreenAuxiliary`, `.stationary`, `.ignoresCycle`, and a high window level (`.screenSaver`). Note: `canJoinAllSpaces` and `moveToActiveSpace` cannot both be set — AppKit throws.

## Animation

Drawn natively in AppKit:

- `ready` — subtle breathing pulse
- `recording` — red ring animation
- `transcribing` — animated blue level bars

## Position persistence

The helper reports drag moves back to Bun as JSON lines on stdout. `setup-indicator-window.ts` debounces and saves the top-left position to app config. Positions are clamped to a valid display on restore.

## Command protocol

One JSON object per stdin line, the same on both platforms. The helper reports drags back as
`{"type":"move","x":…,"y":…}` lines on stdout: the top-left of the **orb's** 72px frame, even
while the window is wider for the Staging Overlay.

| Command | Fields | Effect |
|---------|--------|--------|
| `show` | `x`, `y`, `width`, `height`, `status`, optional `theme` | Places the orb frame (top-left screen coordinates) and shows it |
| `hide` | | Hides the window and clears any overlay text |
| `status` | `status`: `ready`, `recording` or `transcribing` | Changes the orb's state |
| `theme` | `theme`: `light`, `dark` or `system` | Light or dark drawing |
| `text` | `committed`, `partial` (strings, both default to `""`) | Sets the Staging Overlay's text; both empty collapses back to the orb |
| `quit` | | Exits the helper |

`text` is drawn as `committed` followed immediately by `partial`, verbatim: the helper adds no
separator, so `partial` carries its own leading space. `committed` is text Parakeet will not
revise and is drawn in the full foreground color; `partial` is the segment in progress and is
drawn dimmer. A `show` or `status` while text is set keeps the text: only `text` with both
parts empty, or `hide`, clears it.

## Staging Overlay

What a Live Transcription looks like in the indicator. Nothing is pasted until the Dictation
ends; the overlay is only where the words are staged.

### States

- **Orb alone** - every status other than a running Live Transcription, and a Live
  Transcription that has heard nothing yet. The window is the 72px orb frame.
- **Overlay** - a Live Transcription is streaming (app status `streaming`, drawn as the
  `recording` orb) and the running transcript is not empty. The window grows to hold the orb
  and a text panel beside it.
- **Collapse** - the moment the Live Transcription ends, however it ends (a normal stop goes to
  `transcribing`; Escape, an app-initiated stop or a blocked start go to `ready`; a helper that
  ends the session on its own goes to `transcribing`), Bun sends an empty `text` and the window
  is the orb again. Late stream events after that are ignored, so they cannot reopen it.

### What Bun sends

`setup-recording.ts` reports every change of the running transcript - committed segments and
the current partial, tagged with the Transcription Language of the Dictation Plan the stream
started with - and `index.ts` hands it to the indicator handle's `onLiveText`.
`shapeStagingOverlayText` in `staging-overlay-text.ts` then:

1. applies the Scratch Command when that language is eligible
   (`scratchCommandAppliesToLanguage`), so "scratch that" visibly removes the phrase. The paste
   goes through `outcomeFromTranscript`, which applies the same function to the same text by
   the same language, so what was shown is what is pasted (before the Dictionary, Self-correction
   Cleanup and the Formatting Mode do their usual work);
2. trims the result; empty means collapse;
3. splits it into `committed` and `partial` at the common prefix of the shaped whole text and
   the shaped committed text, moved back so no word is split between the two;
4. keeps only the last 240 characters, cut at a word boundary, with `…` in front when anything
   was cut. The native side shows the last four lines of that.

Sends are throttled to at most one every 50ms (20 per second); the newest text wins. Identical
text is not resent. Nothing is sent while the indicator is not visible: indicator mode **Off**
means no overlay either, and with **When active** the indicator is visible for the whole
Live Transcription because `streaming` is an active status.

### macOS layout

- A rounded panel (12pt corner radius) beside the orb, vertically centred on it, 4pt from the
  56pt orb. It grows to the right; when the orb is too close to the right edge of the
  screen's visible frame it grows to the left. It is kept 8pt inside the visible frame, and the
  orb itself never moves.
- Text is the 14pt system font with 18pt lines, 14pt horizontal and 10pt vertical padding. The
  panel is as wide as the text on one line, up to a 340pt text column, then wraps. At most four
  lines are visible; the text is bottom-aligned and clipped, so older lines scroll off the top.
- Dark theme: black panel at 88% opacity, committed text white at 92%, partial white at 48%.
  Light theme: white panel at 96%, committed black at 92%, partial black at 48%. `system`
  follows the macOS appearance, like the orb.
- The panel is still the same non-activating `NSPanel` (`canBecomeKey` and `canBecomeMain` are
  false; nothing calls `makeKey` or `activate`), so typing and the final paste go to whatever app
  has focus, and it keeps working in fullscreen Spaces.

### Windows layout

- The same geometry in pixels: panel beside the orb, right unless the monitor work area runs out,
  8px inside the work area, 340px maximum text width, four lines, bottom-aligned with older lines
  clipped off the top.
- Segoe UI at 15px character height, word-wrapped by `DrawTextW`. GDI draws one color per call,
  so the whole text is drawn in the partial color and the committed text over it in the
  foreground color with the same rectangle and wrap; Bun never splits a word between the two,
  which keeps the wraps identical.
- The window is a colorkey layered window, so nothing in the panel is pure black. Dark: panel
  `#121317`, committed `#ECEDF0`, partial `#80838C`. Light: panel `#F6F6F8`, committed `#1C1D21`,
  partial `#888A92`. `system` draws dark, like the orb, which has a single look on Windows.
- Painting is double-buffered. The window keeps `WS_EX_NOACTIVATE` and is shown with
  `SW_SHOWNOACTIVATE`.
- The layout is a pure function, `overlay_layout` in `src/indicator/overlay.rs`; measuring and
  drawing are in `src/indicator/text.rs`.

## Windows implementation

On Windows the indicator is part of `CodictateWindowsHelper` (Rust) — the same binary that handles keyboard hook and audio recording. It runs as a separate mode (`indicator`) spawned by Bun, receiving commands over stdin/stdout exactly like the macOS helper.

The window is a Win32 layered window (`WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED`) with black as the colorkey for transparency. Animation and drawing are done with GDI — the same states and visual style as macOS (breathing pulse, red ring, orange bars). Drag moves are reported back to Bun as JSON lines on stdout.

It accepts the same commands as the macOS helper, including `theme` and `text`.

Build: `bun run build:native:windows-helper` (Cargo).

## Checklist

- Indicator won't launch on macOS: verify `vendors/window-helper/CodictateWindowHelper` exists (`bun run build:native`)
- Indicator won't launch on Windows: verify `CodictateWindowsHelper.exe` is built (`bun run build:native:windows-helper`)
- macOS notarization fails: check `scripts/post-build.ts` and `entitlements/CodictateWindowHelper.entitlements`
