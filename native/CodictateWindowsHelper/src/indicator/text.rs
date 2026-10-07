//! GDI side of the Staging Overlay: measuring the running transcript for
//! `overlay::overlay_layout`, and drawing the text panel.

use super::draw::rgb;
use super::overlay::{
    OVERLAY_CORNER_RADIUS, OverlayLayout, OverlayPanel, OverlayTextMetrics, orb_only_layout,
    overlay_layout,
};
use super::protocol::IndicatorTheme;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, CreateFontW, CreatePen, CreateSolidBrush,
    DEFAULT_CHARSET, DEFAULT_PITCH, DT_CALCRECT, DT_NOPREFIX, DT_SINGLELINE, DT_WORDBREAK,
    DeleteObject, DrawTextW, FF_SWISS, FW_NORMAL, GetDC, GetMonitorInfoW, GetTextMetricsW, HDC,
    HFONT, HGDIOBJ, IntersectClipRect, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect,
    OUT_DEFAULT_PRECIS, PS_SOLID, ReleaseDC, RestoreDC, RoundRect, SaveDC, SelectObject, SetBkMode,
    SetTextColor, TEXTMETRICW, TRANSPARENT,
};

/// Text height in pixels (negative: character height, not cell height), matching the
/// 14pt-ish system text of the macOS overlay.
const OVERLAY_FONT_HEIGHT: i32 = -15;

struct OverlayColors {
    panel: u32,
    outline: u32,
    committed: u32,
    partial: u32,
}

/// Never pure black: black is the window's transparency colorkey.
fn overlay_colors(theme: IndicatorTheme) -> OverlayColors {
    match theme {
        IndicatorTheme::Light => OverlayColors {
            panel: rgb(246, 246, 248),
            outline: rgb(214, 214, 220),
            committed: rgb(28, 29, 33),
            partial: rgb(136, 138, 146),
        },
        IndicatorTheme::Dark | IndicatorTheme::System => OverlayColors {
            panel: rgb(18, 19, 23),
            outline: rgb(46, 48, 56),
            committed: rgb(236, 237, 240),
            partial: rgb(128, 131, 140),
        },
    }
}

fn to_utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// The overlay font, deleted when dropped.
struct OverlayFont(HFONT);

impl OverlayFont {
    fn new() -> Option<Self> {
        let face: Vec<u16> = "Segoe UI"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let font = unsafe {
            CreateFontW(
                OVERLAY_FONT_HEIGHT,
                0,
                0,
                0,
                FW_NORMAL as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                (DEFAULT_PITCH | FF_SWISS) as u32,
                face.as_ptr(),
            )
        };
        if font.is_null() {
            None
        } else {
            Some(Self(font))
        }
    }
}

impl Drop for OverlayFont {
    fn drop(&mut self) {
        unsafe { DeleteObject(self.0 as _) };
    }
}

/// `font` selected into `hdc` until dropped.
struct SelectedFont {
    hdc: HDC,
    previous: HGDIOBJ,
}

impl SelectedFont {
    fn new(hdc: HDC, font: &OverlayFont) -> Self {
        let previous = unsafe { SelectObject(hdc, font.0 as _) };
        Self { hdc, previous }
    }
}

impl Drop for SelectedFont {
    fn drop(&mut self) {
        unsafe { SelectObject(self.hdc, self.previous) };
    }
}

struct GdiTextMetrics<'a> {
    hdc: HDC,
    text: &'a [u16],
    line_height: i32,
}

impl GdiTextMetrics<'_> {
    fn calc_rect(&self, mut rect: RECT, format: u32) -> RECT {
        unsafe {
            DrawTextW(
                self.hdc,
                self.text.as_ptr(),
                self.text.len() as i32,
                &mut rect,
                format | DT_CALCRECT | DT_NOPREFIX,
            )
        };
        rect
    }
}

impl OverlayTextMetrics for GdiTextMetrics<'_> {
    fn single_line_width(&self) -> i32 {
        let rect = self.calc_rect(RECT::default(), DT_SINGLELINE);
        rect.right - rect.left
    }

    fn wrapped_height(&self, width: i32) -> i32 {
        let rect = self.calc_rect(
            RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: 0,
            },
            DT_WORDBREAK,
        );
        rect.bottom - rect.top
    }

    fn line_height(&self) -> i32 {
        self.line_height
    }
}

/// The work area of the monitor the orb is on, or `orb` grown generously when there is none.
fn work_area_for(orb: RECT) -> RECT {
    let monitor = unsafe { MonitorFromRect(&orb, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !monitor.is_null() && unsafe { GetMonitorInfoW(monitor, &mut info) } != 0 {
        return info.rcWork;
    }
    RECT {
        left: orb.left - 4096,
        top: orb.top - 4096,
        right: orb.right + 4096,
        bottom: orb.bottom + 4096,
    }
}

/// Lays the window out for this orb frame (screen coordinates) and overlay text. Falls back
/// to the orb alone when there is no text, or when GDI cannot measure it.
pub fn layout_for_text(hwnd: HWND, orb: RECT, committed: &str, partial: &str) -> OverlayLayout {
    if committed.is_empty() && partial.is_empty() {
        return orb_only_layout(orb);
    }
    let Some(font) = OverlayFont::new() else {
        return orb_only_layout(orb);
    };
    let hdc = unsafe { GetDC(hwnd) };
    if hdc.is_null() {
        return orb_only_layout(orb);
    }

    let layout = {
        let _selected = SelectedFont::new(hdc, &font);
        let mut tm = TEXTMETRICW::default();
        unsafe { GetTextMetricsW(hdc, &mut tm) };
        let text = to_utf16(&format!("{committed}{partial}"));
        let metrics = GdiTextMetrics {
            hdc,
            text: &text,
            line_height: tm.tmHeight.max(1),
        };
        overlay_layout(orb, work_area_for(orb), &metrics)
    };
    unsafe { ReleaseDC(hwnd, hdc) };
    layout
}

fn draw_text(hdc: HDC, text: &[u16], rect: RECT, color: u32) {
    if text.is_empty() {
        return;
    }
    let mut rect = rect;
    unsafe {
        SetTextColor(hdc, color);
        DrawTextW(
            hdc,
            text.as_ptr(),
            text.len() as i32,
            &mut rect,
            DT_WORDBREAK | DT_NOPREFIX,
        );
    }
}

/// The Staging Overlay's panel: a rounded rectangle with the most recent lines of the
/// running transcript. Lines are bottom-aligned, so when the text is taller than the panel
/// the oldest lines are clipped off the top.
///
/// GDI's `DrawTextW` draws one color, so the whole text is drawn in the partial color and
/// the committed text over it in the committed color, with the same rectangle and word
/// wrap. Bun never splits a word between the two, so the committed lines wrap identically
/// in both passes.
pub fn draw_overlay_panel(
    hdc: HDC,
    panel: &OverlayPanel,
    theme: IndicatorTheme,
    committed: &str,
    partial: &str,
) {
    let colors = overlay_colors(theme);
    let brush = unsafe { CreateSolidBrush(colors.panel) };
    let pen = unsafe { CreatePen(PS_SOLID, 1, colors.outline) };
    unsafe {
        let old_brush = SelectObject(hdc, brush as _);
        let old_pen = SelectObject(hdc, pen as _);
        RoundRect(
            hdc,
            panel.frame.left,
            panel.frame.top,
            panel.frame.right,
            panel.frame.bottom,
            OVERLAY_CORNER_RADIUS,
            OVERLAY_CORNER_RADIUS,
        );
        SelectObject(hdc, old_pen);
        SelectObject(hdc, old_brush);
        DeleteObject(pen as _);
        DeleteObject(brush as _);
    }

    let Some(font) = OverlayFont::new() else {
        return;
    };
    let _selected = SelectedFont::new(hdc, &font);
    let area = panel.text_area;
    let text_rect = RECT {
        left: area.left,
        top: area.bottom - panel.full_text_height.max(area.bottom - area.top),
        right: area.right,
        bottom: area.bottom,
    };
    let whole = to_utf16(&format!("{committed}{partial}"));
    let committed = to_utf16(committed);

    unsafe {
        let saved = SaveDC(hdc);
        IntersectClipRect(hdc, area.left, area.top, area.right, area.bottom);
        SetBkMode(hdc, TRANSPARENT as i32);
        draw_text(hdc, &whole, text_rect, colors.partial);
        draw_text(hdc, &committed, text_rect, colors.committed);
        RestoreDC(hdc, saved);
    }
}
