//! Geometry of the Staging Overlay: where the window goes and where the orb and the text
//! panel sit inside it. Pure, so the layout rules are testable on any host; measuring the
//! text is the caller's job (GDI `DrawTextW` with `DT_CALCRECT`).

use windows_sys::Win32::Foundation::RECT;

/// The widest the text column gets before it wraps, in pixels.
pub const OVERLAY_MAX_TEXT_WIDTH: i32 = 340;
/// Narrowest panel when the screen edge squeezes it.
pub const OVERLAY_MIN_PANEL_WIDTH: i32 = 140;
/// Most lines shown; older lines scroll off the top.
pub const OVERLAY_MAX_LINES: i32 = 4;
pub const OVERLAY_PADDING_X: i32 = 14;
pub const OVERLAY_PADDING_Y: i32 = 10;
pub const OVERLAY_CORNER_RADIUS: i32 = 24;
/// The panel starts this far inside the 72px orb frame: a 4px gap to the 56px orb.
pub const OVERLAY_ORB_OVERLAP: i32 = 4;
/// Distance kept from the edges of the monitor's work area.
pub const OVERLAY_SCREEN_MARGIN: i32 = 8;

/// Where everything goes for one frame of the indicator.
#[derive(Clone, Copy)]
pub struct OverlayLayout {
    /// The window, in screen coordinates.
    pub window: RECT,
    /// The 72px orb frame, in client coordinates.
    pub orb: RECT,
    /// The text panel, in client coordinates; `None` when the indicator is the orb alone.
    pub panel: Option<OverlayPanel>,
}

#[derive(Clone, Copy)]
pub struct OverlayPanel {
    /// The rounded panel.
    pub frame: RECT,
    /// The visible text area inside it: whole lines only.
    pub text_area: RECT,
    /// Height of the whole wrapped text. Taller than `text_area` when lines scroll off.
    pub full_text_height: i32,
}

/// What the caller measured about the text, for one font.
pub trait OverlayTextMetrics {
    /// Width of the whole text on one line.
    fn single_line_width(&self) -> i32;
    /// Height of the text word-wrapped at `width`.
    fn wrapped_height(&self, width: i32) -> i32;
    /// Height of one line.
    fn line_height(&self) -> i32;
}

fn width(rect: &RECT) -> i32 {
    rect.right - rect.left
}

fn height(rect: &RECT) -> i32 {
    rect.bottom - rect.top
}

fn offset(rect: RECT, dx: i32, dy: i32) -> RECT {
    RECT {
        left: rect.left + dx,
        top: rect.top + dy,
        right: rect.right + dx,
        bottom: rect.bottom + dy,
    }
}

/// The orb alone: the window is the orb frame.
pub fn orb_only_layout(orb: RECT) -> OverlayLayout {
    OverlayLayout {
        window: orb,
        orb: offset(orb, -orb.left, -orb.top),
        panel: None,
    }
}

/// The Staging Overlay beside the orb, vertically centred on it: to the right, or to the
/// left when the orb is too close to the right edge of the work area. The panel is kept
/// inside the work area and the orb never moves.
pub fn overlay_layout(orb: RECT, work_area: RECT, text: &impl OverlayTextMetrics) -> OverlayLayout {
    let line_height = text.line_height().max(1);
    let desired_text_width = text.single_line_width().clamp(1, OVERLAY_MAX_TEXT_WIDTH);
    let desired_panel_width = desired_text_width + OVERLAY_PADDING_X * 2;

    let room_right = work_area.right - OVERLAY_SCREEN_MARGIN - (orb.right - OVERLAY_ORB_OVERLAP);
    let room_left = (orb.left + OVERLAY_ORB_OVERLAP) - work_area.left - OVERLAY_SCREEN_MARGIN;
    let grow_right = room_right >= desired_panel_width || room_right >= room_left;
    let room = if grow_right { room_right } else { room_left };
    let panel_width = desired_panel_width.min(room).max(OVERLAY_MIN_PANEL_WIDTH);
    let text_width = panel_width - OVERLAY_PADDING_X * 2;

    let full_text_height = text.wrapped_height(text_width).max(line_height);
    let line_count =
        ((full_text_height + line_height / 2) / line_height).clamp(1, OVERLAY_MAX_LINES);
    let text_height = line_count * line_height;
    let panel_height = text_height + OVERLAY_PADDING_Y * 2;

    let panel_left = if grow_right {
        orb.right - OVERLAY_ORB_OVERLAP
    } else {
        orb.left + OVERLAY_ORB_OVERLAP - panel_width
    };
    let mut panel_top = (orb.top + orb.bottom - panel_height) / 2;
    let min_top = work_area.top + OVERLAY_SCREEN_MARGIN;
    let max_top = work_area.bottom - OVERLAY_SCREEN_MARGIN - panel_height;
    if max_top >= min_top {
        panel_top = panel_top.clamp(min_top, max_top);
    }
    let panel = RECT {
        left: panel_left,
        top: panel_top,
        right: panel_left + panel_width,
        bottom: panel_top + panel_height,
    };

    let window = RECT {
        left: orb.left.min(panel.left),
        top: orb.top.min(panel.top),
        right: orb.right.max(panel.right),
        bottom: orb.bottom.max(panel.bottom),
    };
    let frame = offset(panel, -window.left, -window.top);
    let text_area = RECT {
        left: frame.left + OVERLAY_PADDING_X,
        top: frame.top + OVERLAY_PADDING_Y,
        right: frame.left + OVERLAY_PADDING_X + text_width,
        bottom: frame.top + OVERLAY_PADDING_Y + text_height,
    };

    debug_assert!(width(&text_area) > 0 && height(&text_area) > 0);
    OverlayLayout {
        window,
        orb: offset(orb, -window.left, -window.top),
        panel: Some(OverlayPanel {
            frame,
            text_area,
            full_text_height,
        }),
    }
}
