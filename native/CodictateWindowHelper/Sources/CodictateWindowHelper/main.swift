import AppKit
import Foundation
import QuartzCore

enum IndicatorStatus: String, Codable {
  case ready
  case recording
  case transcribing
}

enum IndicatorTheme: String, Codable {
  case light
  case dark
  case system
}

struct IndicatorCommand: Codable {
  let command: String
  let x: Double?
  let y: Double?
  let width: Double?
  let height: Double?
  let status: IndicatorStatus?
  let theme: IndicatorTheme?
  /// `text` command: the Staging Overlay's committed text (full-opacity foreground).
  let committed: String?
  /// `text` command: the segment in progress (dimmer). Drawn right after `committed`.
  let partial: String?
}

/// The Staging Overlay's text panel, in the content view's coordinates.
struct StagingTextLayout {
  /// The rounded panel.
  let box: NSRect
  /// The visible text area inside `box`: whole lines only, at most `maxLines` of them.
  let textArea: NSRect
  /// Height of the whole wrapped text. Taller than `textArea` when older lines scroll off.
  let fullTextHeight: CGFloat
}

/// Typography and geometry of the Staging Overlay, shared by measuring and drawing.
@MainActor
enum StagingOverlayStyle {
  static let font = NSFont.systemFont(ofSize: 14)
  static let lineHeight: CGFloat = 18
  static let maxLines = 4
  /// The widest the text column gets before it wraps.
  static let maxTextWidth: CGFloat = 340
  /// Narrowest panel when the screen edge squeezes it.
  static let minPanelWidth: CGFloat = 140
  static let paddingX: CGFloat = 14
  static let paddingY: CGFloat = 10
  static let cornerRadius: CGFloat = 12
  /// The panel starts this far inside the 72px orb frame, which leaves a 4px gap to the
  /// 56px orb itself.
  static let orbOverlap: CGFloat = 4
  /// Distance kept from the edges of the screen's visible frame.
  static let screenMargin: CGFloat = 8

  static func paragraphStyle() -> NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    style.minimumLineHeight = lineHeight
    style.maximumLineHeight = lineHeight
    return style
  }

  /// Committed text in `foreground`, the partial after it in `dimmed`.
  static func attributedText(
    committed: String,
    partial: String,
    foreground: NSColor,
    dimmed: NSColor
  ) -> NSAttributedString {
    let paragraph = paragraphStyle()
    let text = NSMutableAttributedString(
      string: committed,
      attributes: [.font: font, .foregroundColor: foreground, .paragraphStyle: paragraph]
    )
    text.append(
      NSAttributedString(
        string: partial,
        attributes: [.font: font, .foregroundColor: dimmed, .paragraphStyle: paragraph]
      )
    )
    return text
  }

  static func measure(_ text: NSAttributedString, width: CGFloat) -> NSSize {
    let rect = text.boundingRect(
      with: NSSize(width: width, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading]
    )
    return NSSize(width: ceil(rect.width), height: ceil(rect.height))
  }
}

struct IndicatorEvent: Codable {
  let type: String
  let x: Double?
  let y: Double?
}

@MainActor
final class IndicatorContentView: NSView {
  private let readyBases: [CGFloat] = [0.45, 0.75, 1, 0.7, 0.5]
  private let readyIdleOpacity: [CGFloat] = [0.55, 0.62, 0.78, 0.62, 0.55]
  private let readyRecOpacity: [CGFloat] = [0.68, 0.76, 0.92, 0.76, 0.68]
  private let maxOrbSize: CGFloat = 56

  var status: IndicatorStatus = .ready {
    didSet {
      targetScale = status == .ready ? (38 / maxOrbSize) : 1
      needsDisplay = true
    }
  }

  var theme: IndicatorTheme = .dark {
    didSet { needsDisplay = true }
  }

  /// The 72px orb frame in view coordinates. `nil` means the whole view, as before the
  /// Staging Overlay existed.
  var orbFrame: NSRect? {
    didSet { needsDisplay = true }
  }

  /// The Staging Overlay's panel, or `nil` when the indicator is the orb alone.
  var stagingLayout: StagingTextLayout? {
    didSet { needsDisplay = true }
  }

  var stagingCommitted = "" {
    didSet { needsDisplay = true }
  }

  var stagingPartial = "" {
    didSet { needsDisplay = true }
  }

  private var animationTime: TimeInterval = 0
  private var currentScale: CGFloat = 38 / 56
  private var targetScale: CGFloat = 38 / 56

  override var isOpaque: Bool { false }

  private var isDarkAppearance: Bool {
    switch theme {
    case .dark:
      return true
    case .light:
      return false
    case .system:
      if let appearance = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) {
        return appearance == .darkAqua
      }
      return true
    }
  }

  func tick(delta: TimeInterval) {
    animationTime += delta
    let speed = min(1, CGFloat(delta * 14))
    currentScale += (targetScale - currentScale) * speed
    if abs(currentScale - targetScale) > 0.0005 || status != .ready {
      needsDisplay = true
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    dirtyRect.fill(using: .clear)

    let dark = isDarkAppearance
    let isRecording = status == .recording
    let isTranscribing = status == .transcribing
    if let stagingLayout {
      drawStagingText(stagingLayout, dark: dark)
    }

    let orbBounds = orbFrame ?? bounds
    let displaySize = maxOrbSize * currentScale
    let orbRect = NSRect(
      x: orbBounds.minX + (orbBounds.width - displaySize) / 2,
      y: orbBounds.minY + (orbBounds.height - displaySize) / 2,
      width: displaySize,
      height: displaySize
    )

    let orbFill = dark ? NSColor.black : NSColor.white
    let overlayBase = dark ? NSColor.white : NSColor.black

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowBlurRadius = dark ? 5 : 8
    shadow.shadowOffset = NSSize(width: 0, height: -1)
    shadow.shadowColor = NSColor.black.withAlphaComponent(dark ? 0.24 : 0.12)
    shadow.set()
    orbFill.setFill()
    NSBezierPath(ovalIn: orbRect).fill()
    NSGraphicsContext.restoreGraphicsState()

    let borderColor: NSColor
    let fillColor: NSColor
    if isRecording {
      borderColor = overlayBase.withAlphaComponent(0.10)
      fillColor = overlayBase.withAlphaComponent(0.04)
    } else if isTranscribing {
      borderColor = NSColor.systemOrange.withAlphaComponent(0.20)
      fillColor = NSColor.systemOrange.withAlphaComponent(0.05)
    } else {
      borderColor = overlayBase.withAlphaComponent(0.08)
      fillColor = overlayBase.withAlphaComponent(0.03)
    }

    fillColor.setFill()
    NSBezierPath(ovalIn: orbRect).fill()
    borderColor.setStroke()
    let borderPath = NSBezierPath(ovalIn: orbRect.insetBy(dx: 0.5, dy: 0.5))
    borderPath.lineWidth = 1
    borderPath.stroke()

    if isTranscribing {
      drawTranscribingBars(in: orbRect)
    } else {
      drawReadyBars(in: orbRect, active: isRecording, dark: dark)
    }
  }

  /// The Staging Overlay: a rounded panel with the most recent lines of the running
  /// transcript. Lines are bottom-aligned, so when the text is taller than the panel the
  /// oldest lines are the ones clipped off the top.
  private func drawStagingText(_ layout: StagingTextLayout, dark: Bool) {
    let panelPath = NSBezierPath(
      roundedRect: layout.box,
      xRadius: StagingOverlayStyle.cornerRadius,
      yRadius: StagingOverlayStyle.cornerRadius
    )

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowBlurRadius = dark ? 5 : 8
    shadow.shadowOffset = NSSize(width: 0, height: -1)
    shadow.shadowColor = NSColor.black.withAlphaComponent(dark ? 0.24 : 0.12)
    shadow.set()
    let panelFill = dark
      ? NSColor.black.withAlphaComponent(0.88)
      : NSColor.white.withAlphaComponent(0.96)
    panelFill.setFill()
    panelPath.fill()
    NSGraphicsContext.restoreGraphicsState()

    let overlayBase = dark ? NSColor.white : NSColor.black
    overlayBase.withAlphaComponent(0.08).setStroke()
    let borderPath = NSBezierPath(
      roundedRect: layout.box.insetBy(dx: 0.5, dy: 0.5),
      xRadius: StagingOverlayStyle.cornerRadius,
      yRadius: StagingOverlayStyle.cornerRadius
    )
    borderPath.lineWidth = 1
    borderPath.stroke()

    let text = StagingOverlayStyle.attributedText(
      committed: stagingCommitted,
      partial: stagingPartial,
      foreground: overlayBase.withAlphaComponent(0.92),
      dimmed: overlayBase.withAlphaComponent(0.48)
    )

    // Bottom-aligned: the rect is as tall as the whole text and starts at the bottom of the
    // visible area, so the newest line sits at the bottom and older ones are clipped.
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(rect: layout.textArea).addClip()
    let textRect = NSRect(
      x: layout.textArea.minX,
      y: layout.textArea.minY,
      width: layout.textArea.width,
      height: max(layout.fullTextHeight, layout.textArea.height)
    )
    text.draw(with: textRect, options: [.usesLineFragmentOrigin, .usesFontLeading])
    NSGraphicsContext.restoreGraphicsState()
  }

  private func drawReadyBars(in orbRect: NSRect, active: Bool, dark: Bool) {
    let scale = orbRect.width / maxOrbSize
    let rowHeight = 16 as CGFloat * scale
    let barWidth = 3 as CGFloat * scale
    let gap = 2 as CGFloat * scale
    let totalWidth = barWidth * 5 + gap * 4
    let originX = orbRect.midX - totalWidth / 2
    let originY = orbRect.midY - rowHeight / 2
    let overlayBase = dark ? NSColor.white : NSColor.black

    for index in 0..<readyBases.count {
      let base = readyBases[index]
      let scaleY: CGFloat
      if active {
        let duration = 0.58 + Double(index) * 0.06
        let progress = ((animationTime + Double(index) * 0.09) / duration)
          .truncatingRemainder(dividingBy: 1)
        scaleY = interpolate(progress: progress, values: [base, base * 0.35 + 0.12, base + 0.18, base])
      } else {
        scaleY = base
      }

      let rect = NSRect(
        x: originX + CGFloat(index) * (barWidth + gap),
        y: originY,
        width: barWidth,
        height: rowHeight * scaleY
      )
      let alpha = active ? readyRecOpacity[index] : readyIdleOpacity[index]
      let color = active
        ? NSColor.systemRed.withAlphaComponent(alpha)
        : overlayBase.withAlphaComponent(alpha)
      color.setFill()
      NSBezierPath(
        roundedRect: rect,
        xRadius: barWidth / 2,
        yRadius: barWidth / 2
      ).fill()
    }
  }

  private func drawTranscribingBars(in orbRect: NSRect) {
    let scale = orbRect.width / maxOrbSize
    let rowHeight = 16 as CGFloat * scale
    let barWidth = 3 as CGFloat * scale
    let gap = 2 as CGFloat * scale
    let totalWidth = barWidth * 3 + gap * 2
    let originX = orbRect.midX - totalWidth / 2
    let originY = orbRect.midY - rowHeight / 2

    for index in 0..<3 {
      let duration = 0.85
      let progress = ((animationTime + Double(index) * 0.14) / duration)
        .truncatingRemainder(dividingBy: 1)
      let scaleY = interpolate(progress: progress, values: [0.28, 1, 0.28])
      let rect = NSRect(
        x: originX + CGFloat(index) * (barWidth + gap),
        y: originY,
        width: barWidth,
        height: rowHeight * scaleY
      )
      NSColor.systemOrange.withAlphaComponent(0.60).setFill()
      NSBezierPath(
        roundedRect: rect,
        xRadius: barWidth / 2,
        yRadius: barWidth / 2
      ).fill()
    }
  }

  private func interpolate(progress: Double, values: [CGFloat]) -> CGFloat {
    guard values.count >= 2 else { return values.first ?? 1 }
    let segmentCount = values.count - 1
    let scaled = min(max(progress, 0), 0.999_999) * Double(segmentCount)
    let index = Int(floor(scaled))
    let local = CGFloat(scaled - Double(index))
    let start = values[index]
    let end = values[index + 1]
    return start + (end - start) * local
  }
}

@MainActor
final class IndicatorPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

@MainActor
final class IndicatorWindowDelegate: NSObject, NSWindowDelegate {
  /// Called with the window's new frame. The controller turns it into the orb's frame, which
  /// is what Bun saves: with the Staging Overlay open the window is wider than the orb.
  var onMove: ((NSWindow) -> Void)?

  func windowDidMove(_ notification: Notification) {
    guard let window = notification.object as? NSWindow else { return }
    onMove?(window)
  }
}

@MainActor
final class IndicatorController {
  private var panel: IndicatorPanel?
  private var contentView: IndicatorContentView?
  private let delegate = IndicatorWindowDelegate()
  private var animationTimer: Timer?
  private var lastTick = CACurrentMediaTime()

  /// The orb's 72px frame in AppKit screen coordinates. The window is exactly this frame
  /// while the indicator is the orb alone, and grows around it for the Staging Overlay.
  private var orbFrame = NSRect(x: 0, y: 0, width: 72, height: 72)
  /// Offset from the window's origin to the orb frame's origin, so a drag of the grown
  /// window still reports and remembers where the orb is.
  private var orbOffsetInWindow = NSPoint.zero
  private var stagingCommitted = ""
  private var stagingPartial = ""

  private var hasStagingText: Bool {
    !stagingCommitted.isEmpty || !stagingPartial.isEmpty
  }

  init() {
    delegate.onMove = { [weak self] window in
      self?.windowDidMove(window)
    }
  }

  private func screenForTopLeftRect(_ rect: NSRect) -> NSScreen? {
    NSScreen.screens.first { $0.frame.intersects(rect) } ?? NSScreen.main
  }

  private func appKitFrame(fromTopLeftRect rect: NSRect) -> NSRect {
    guard let screen = screenForTopLeftRect(rect) else { return rect }
    let y = screen.frame.maxY - rect.origin.y - rect.size.height
    return NSRect(
      x: rect.origin.x,
      y: y,
      width: rect.size.width,
      height: rect.size.height
    )
  }

  private func screenForAppKitRect(_ rect: NSRect) -> NSScreen? {
    let center = NSPoint(x: rect.midX, y: rect.midY)
    return NSScreen.screens.first { $0.frame.contains(center) }
      ?? NSScreen.screens.first { $0.frame.intersects(rect) }
      ?? NSScreen.main
  }

  private func windowDidMove(_ window: NSWindow) {
    let frame = window.frame
    orbFrame.origin = NSPoint(
      x: frame.origin.x + orbOffsetInWindow.x,
      y: frame.origin.y + orbOffsetInWindow.y
    )
    guard let screen = window.screen ?? screenForAppKitRect(orbFrame) else { return }

    let topLeftY = screen.frame.maxY - orbFrame.origin.y - orbFrame.size.height
    let event = IndicatorEvent(type: "move", x: orbFrame.origin.x, y: topLeftY)
    if let data = try? JSONEncoder().encode(event),
       let line = String(data: data, encoding: .utf8) {
      FileHandle.standardOutput.write(Data((line + "\n").utf8))
      fflush(stdout)
    }
  }

  /// Where the window goes and what the content view draws, for the current orb frame and
  /// Staging Overlay text. With no text the window is the orb frame. With text, a rounded
  /// panel sits beside the orb, vertically centred on it: to the right, or to the left when
  /// the orb is too close to the right edge of the screen's visible frame. The panel is kept
  /// inside the visible frame; the orb never moves.
  private func applyLayout() {
    guard let panel, let contentView else { return }

    guard hasStagingText else {
      orbOffsetInWindow = .zero
      contentView.stagingLayout = nil
      contentView.orbFrame = nil
      panel.setFrame(orbFrame, display: true)
      contentView.frame = NSRect(origin: .zero, size: orbFrame.size)
      return
    }

    let style = StagingOverlayStyle.self
    let visible = (screenForAppKitRect(orbFrame) ?? NSScreen.main)?.visibleFrame
      ?? orbFrame.insetBy(dx: -1000, dy: -1000)
    let measureText = style.attributedText(
      committed: stagingCommitted,
      partial: stagingPartial,
      foreground: .white,
      dimmed: .white
    )

    // Width: the text's own single-line width up to the wrap width, then squeezed to the
    // space between the orb and the screen edge on whichever side has room.
    let singleLine = style.measure(measureText, width: .greatestFiniteMagnitude)
    var textWidth = min(style.maxTextWidth, max(singleLine.width, 1))
    let desiredPanelWidth = textWidth + style.paddingX * 2
    let roomRight = visible.maxX - style.screenMargin - (orbFrame.maxX - style.orbOverlap)
    let roomLeft = (orbFrame.minX + style.orbOverlap) - visible.minX - style.screenMargin
    let growRight = roomRight >= desiredPanelWidth || roomRight >= roomLeft
    let room = growRight ? roomRight : roomLeft
    let panelWidth = max(style.minPanelWidth, min(desiredPanelWidth, room))
    textWidth = panelWidth - style.paddingX * 2

    // Height: whole lines, at most `maxLines`; the rest scrolls off the top.
    let fullTextHeight = style.measure(measureText, width: textWidth).height
    let lineCount = min(
      style.maxLines,
      max(1, Int((fullTextHeight / style.lineHeight).rounded()))
    )
    let textHeight = CGFloat(lineCount) * style.lineHeight
    let panelHeight = textHeight + style.paddingY * 2

    var box = NSRect(
      x: growRight
        ? orbFrame.maxX - style.orbOverlap
        : orbFrame.minX + style.orbOverlap - panelWidth,
      y: orbFrame.midY - panelHeight / 2,
      width: panelWidth,
      height: panelHeight
    )
    let minY = visible.minY + style.screenMargin
    let maxY = visible.maxY - style.screenMargin - panelHeight
    if maxY >= minY {
      box.origin.y = min(max(box.origin.y, minY), maxY)
    }

    let windowFrame = orbFrame.union(box).integral
    orbOffsetInWindow = NSPoint(
      x: orbFrame.minX - windowFrame.minX,
      y: orbFrame.minY - windowFrame.minY
    )
    let localBox = box.offsetBy(dx: -windowFrame.minX, dy: -windowFrame.minY)
    let textArea = NSRect(
      x: localBox.minX + style.paddingX,
      y: localBox.minY + style.paddingY,
      width: textWidth,
      height: textHeight
    )

    contentView.orbFrame = orbFrame.offsetBy(dx: -windowFrame.minX, dy: -windowFrame.minY)
    contentView.stagingLayout = StagingTextLayout(
      box: localBox,
      textArea: textArea,
      fullTextHeight: fullTextHeight
    )
    // The offset is set before the frame, so the `windowDidMove` this triggers maps the
    // new window origin back onto the same orb frame.
    panel.setFrame(windowFrame, display: true)
    contentView.frame = NSRect(origin: .zero, size: windowFrame.size)
  }

  private func startAnimationTimer() {
    guard animationTimer == nil else { return }
    lastTick = CACurrentMediaTime()
    animationTimer = Timer.scheduledTimer(
      timeInterval: 1 / 30,
      target: self,
      selector: #selector(handleAnimationTimer),
      userInfo: nil,
      repeats: true
    )
    if let animationTimer {
      RunLoop.main.add(animationTimer, forMode: .common)
    }
  }

  @objc private func handleAnimationTimer() {
    guard let contentView else { return }
    let now = CACurrentMediaTime()
    let delta = now - lastTick
    lastTick = now
    contentView.tick(delta: delta)
  }

  private func stopAnimationTimer() {
    animationTimer?.invalidate()
    animationTimer = nil
  }

  func show(frame: NSRect, status: IndicatorStatus) {
    let appKitFrame = appKitFrame(fromTopLeftRect: frame)
    if panel == nil {
      let nextPanel = IndicatorPanel(
        contentRect: appKitFrame,
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
      )
      let nextContentView = IndicatorContentView(
        frame: NSRect(origin: .zero, size: frame.size)
      )
      nextPanel.isOpaque = false
      nextPanel.backgroundColor = .clear
      nextPanel.hasShadow = false
      nextPanel.hidesOnDeactivate = false
      nextPanel.isMovableByWindowBackground = true
      nextPanel.level = .screenSaver
      nextPanel.collectionBehavior = [
        .canJoinAllSpaces,
        .fullScreenAuxiliary,
        .stationary,
        .ignoresCycle,
      ]
      nextPanel.contentView = nextContentView
      nextPanel.delegate = delegate
      panel = nextPanel
      contentView = nextContentView
    }

    orbFrame = appKitFrame
    applyLayout()
    contentView?.status = status
    panel?.orderFrontRegardless()
    startAnimationTimer()
  }

  func hide() {
    setStagingText(committed: "", partial: "")
    panel?.orderOut(nil)
  }

  func setStatus(_ status: IndicatorStatus) {
    contentView?.status = status
    panel?.orderFrontRegardless()
    startAnimationTimer()
  }

  func setTheme(_ theme: IndicatorTheme) {
    contentView?.theme = theme
  }

  /// The Staging Overlay's text. Both empty collapses the window back to the orb. Never
  /// shows a hidden panel, never makes it key: `orderFrontRegardless` is only called by
  /// `show` and `setStatus`, and `IndicatorPanel` cannot become key or main.
  func setStagingText(committed: String, partial: String) {
    guard committed != stagingCommitted || partial != stagingPartial else { return }
    let hadText = hasStagingText
    stagingCommitted = committed
    stagingPartial = partial
    contentView?.stagingCommitted = committed
    contentView?.stagingPartial = partial
    if hadText || hasStagingText {
      applyLayout()
    }
  }

  func destroyAndQuit() {
    stopAnimationTimer()
    panel?.close()
    panel = nil
    contentView = nil
    NSApp.terminate(nil)
  }
}

let controller = IndicatorController()

DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8) else { continue }
    guard
      let cmd = try? JSONDecoder().decode(IndicatorCommand.self, from: data)
    else { continue }

    Task { @MainActor in
      switch cmd.command {
      case "show":
        guard
          let x = cmd.x,
          let y = cmd.y,
          let width = cmd.width,
          let height = cmd.height
        else { return }
        controller.show(
          frame: NSRect(x: x, y: y, width: width, height: height),
          status: cmd.status ?? .ready
        )
        if let theme = cmd.theme {
          controller.setTheme(theme)
        }
      case "hide":
        controller.hide()
      case "status":
        if let status = cmd.status {
          controller.setStatus(status)
        }
      case "theme":
        if let theme = cmd.theme {
          controller.setTheme(theme)
        }
      case "text":
        controller.setStagingText(
          committed: cmd.committed ?? "",
          partial: cmd.partial ?? ""
        )
      case "quit":
        controller.destroyAndQuit()
      default:
        break
      }
    }
  }

  Task { @MainActor in
    controller.destroyAndQuit()
  }
}

NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
