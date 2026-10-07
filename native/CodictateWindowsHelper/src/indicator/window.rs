use super::draw::{
    INDICATOR_FRAME_MS, INDICATOR_TIMER_ID, IndicatorAnimation, draw_indicator_content, rgb,
};
use super::overlay::{OverlayLayout, orb_only_layout};
use super::protocol::{
    IndicatorCommand, IndicatorStartedMessage, IndicatorStatus, IndicatorTheme, MoveMessage,
    StatusMessage,
};
use super::text::{draw_overlay_panel, layout_for_text};
use crate::ipc::emit_json;
use std::io::{self, BufRead};
use std::process::ExitCode;
use std::sync::{Mutex, OnceLock};
use std::thread;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BLACK_BRUSH, BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC,
    DeleteObject, EndPaint, FillRect, GetStockObject, HDC, InvalidateRect, PAINTSTRUCT, SRCCOPY,
    SelectObject, UpdateWindow,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW, GetWindowRect,
    HTCAPTION, HWND_TOPMOST, KillTimer, LWA_COLORKEY, MSG, PostMessageW, PostQuitMessage,
    RegisterClassW, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SetLayeredWindowAttributes,
    SetTimer, SetWindowPos, ShowWindow, TranslateMessage, WM_APP, WM_CLOSE, WM_DESTROY, WM_MOVE,
    WM_NCHITTEST, WM_PAINT, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};

static INDICATOR_STATE: OnceLock<Mutex<IndicatorState>> = OnceLock::new();
static INDICATOR_ANIMATION: OnceLock<Mutex<IndicatorAnimation>> = OnceLock::new();

const WM_INDICATOR_COMMAND: u32 = WM_APP + 1;

#[derive(Clone, Copy)]
struct IndicatorFrame {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl Default for IndicatorFrame {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 72,
            height: 72,
        }
    }
}

impl IndicatorFrame {
    fn rect(&self) -> RECT {
        RECT {
            left: self.x,
            top: self.y,
            right: self.x + self.width,
            bottom: self.y + self.height,
        }
    }
}

#[derive(Clone)]
struct IndicatorState {
    visible: bool,
    /// The orb's 72px frame in screen coordinates. The window is exactly this while the
    /// indicator is the orb alone, and grows around it for the Staging Overlay.
    frame: IndicatorFrame,
    status: IndicatorStatus,
    theme: IndicatorTheme,
    /// The Staging Overlay's text; both empty means the orb alone.
    committed: String,
    partial: String,
    /// Where the window, the orb and the text panel go for the fields above.
    layout: OverlayLayout,
}

impl Default for IndicatorState {
    fn default() -> Self {
        let frame = IndicatorFrame::default();
        Self {
            visible: false,
            frame,
            status: IndicatorStatus::default(),
            theme: IndicatorTheme::default(),
            committed: String::new(),
            partial: String::new(),
            layout: orb_only_layout(frame.rect()),
        }
    }
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn state_snapshot() -> IndicatorState {
    INDICATOR_STATE
        .get()
        .and_then(|state| state.lock().ok().map(|state| state.clone()))
        .unwrap_or_default()
}

fn animation_frame() -> (f32, f32) {
    INDICATOR_ANIMATION
        .get()
        .and_then(|animation| animation.lock().ok().map(|animation| animation.frame()))
        .unwrap_or((0.0, 38.0 / 56.0))
}

unsafe extern "system" fn indicator_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(hwnd, &mut paint) };
            let mut rect = RECT::default();
            unsafe { GetClientRect(hwnd, &mut rect) };
            paint_buffered(hdc, rect, &state_snapshot());
            unsafe { EndPaint(hwnd, &paint) };
            0
        }
        WM_TIMER => {
            if wparam == INDICATOR_TIMER_ID {
                let status = state_snapshot().status;
                if let Some(animation) = INDICATOR_ANIMATION.get()
                    && let Ok(mut animation) = animation.lock()
                {
                    animation.update(status);
                }
                unsafe { InvalidateRect(hwnd, std::ptr::null(), 0) };
                return 0;
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_INDICATOR_COMMAND => {
            if wparam != 0 {
                let command = unsafe { Box::from_raw(wparam as *mut IndicatorCommand) };
                apply_indicator_command(hwnd, *command);
            }
            0
        }
        WM_NCHITTEST => HTCAPTION as LRESULT,
        WM_MOVE => {
            // Report and remember where the orb is, not the window: with the Staging
            // Overlay open the window is wider than the orb and may start left of it.
            let mut rect = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut rect) } != 0
                && let Some(state) = INDICATOR_STATE.get()
                && let Ok(mut state) = state.lock()
                && state.visible
            {
                state.frame.x = rect.left + state.layout.orb.left;
                state.frame.y = rect.top + state.layout.orb.top;
                let (x, y) = (state.frame.x, state.frame.y);
                drop(state);
                let _ = emit_json(&MoveMessage::new(x, y));
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        WM_DESTROY => {
            unsafe { KillTimer(hwnd, INDICATOR_TIMER_ID) };
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Draws a frame off screen and copies it in one blit, so the text panel does not flicker
/// at the 30fps animation rate. Black is the colorkey: everything left black is see-through.
fn paint_buffered(hdc: HDC, rect: RECT, state: &IndicatorState) {
    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);
    let (animation_time, current_scale) = animation_frame();
    let draw = |target: HDC| {
        unsafe { FillRect(target, &rect, GetStockObject(BLACK_BRUSH) as _) };
        if let Some(panel) = &state.layout.panel {
            draw_overlay_panel(target, panel, state.theme, &state.committed, &state.partial);
        }
        draw_indicator_content(
            target,
            state.status,
            state.layout.orb,
            animation_time,
            current_scale,
        );
    };

    let memory = unsafe { CreateCompatibleDC(hdc) };
    let bitmap = if memory.is_null() {
        std::ptr::null_mut()
    } else {
        unsafe { CreateCompatibleBitmap(hdc, width, height) }
    };
    if memory.is_null() || bitmap.is_null() {
        // Out of GDI resources: draw straight to the window rather than not at all.
        draw(hdc);
    } else {
        unsafe {
            let previous = SelectObject(memory, bitmap as _);
            draw(memory);
            BitBlt(hdc, 0, 0, width, height, memory, 0, 0, SRCCOPY);
            SelectObject(memory, previous);
        }
    }
    unsafe {
        if !bitmap.is_null() {
            DeleteObject(bitmap as _);
        }
        if !memory.is_null() {
            DeleteDC(memory);
        }
    }
}

fn apply_indicator_state(hwnd: HWND, state: &IndicatorState) {
    unsafe {
        InvalidateRect(hwnd, std::ptr::null(), 1);
        if state.visible {
            if let Some(animation) = INDICATOR_ANIMATION.get()
                && let Ok(mut animation) = animation.lock()
            {
                animation.reset_tick();
            }
            SetTimer(hwnd, INDICATOR_TIMER_ID, INDICATOR_FRAME_MS, None);
            let window = state.layout.window;
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                window.left,
                window.top,
                window.right - window.left,
                window.bottom - window.top,
                SWP_NOACTIVATE,
            );
            // Never activate: the paste at the end of a Dictation goes to the focused app.
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            UpdateWindow(hwnd);
        } else {
            KillTimer(hwnd, INDICATOR_TIMER_ID);
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

fn apply_indicator_command(hwnd: HWND, command: IndicatorCommand) {
    let should_close = matches!(command, IndicatorCommand::Quit);
    let mut snapshot = None;
    if let Some(state) = INDICATOR_STATE.get()
        && let Ok(mut state) = state.lock()
    {
        match command {
            IndicatorCommand::Show {
                x,
                y,
                width,
                height,
                status,
                theme,
            } => {
                state.visible = true;
                state.frame = IndicatorFrame {
                    x,
                    y,
                    width: width.max(24),
                    height: height.max(24),
                };
                state.status = status;
                if let Some(theme) = theme {
                    state.theme = theme;
                }
            }
            IndicatorCommand::Hide => {
                state.visible = false;
                state.committed.clear();
                state.partial.clear();
            }
            IndicatorCommand::Status { status } => state.status = status,
            IndicatorCommand::Theme { theme } => state.theme = theme,
            IndicatorCommand::Text { committed, partial } => {
                state.committed = committed;
                state.partial = partial;
            }
            IndicatorCommand::Quit => state.visible = false,
        }
        snapshot = Some(state.clone());
    }

    // Measure outside the lock: `GetDC` and `DrawTextW` are slow next to a field write, and
    // the paint and move handlers take the same lock.
    if let Some(mut state) = snapshot {
        state.layout = layout_for_text(hwnd, state.frame.rect(), &state.committed, &state.partial);
        if let Some(shared) = INDICATOR_STATE.get()
            && let Ok(mut shared) = shared.lock()
        {
            shared.layout = state.layout;
        }
        // The layout is stored before the window moves, so the `WM_MOVE` this triggers maps
        // the new window origin back onto the same orb frame.
        apply_indicator_state(hwnd, &state);
    }

    if should_close {
        let _ = unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
    }
}

fn post_indicator_command(hwnd: HWND, command: IndicatorCommand) -> bool {
    let raw = Box::into_raw(Box::new(command));
    let posted = unsafe { PostMessageW(hwnd, WM_INDICATOR_COMMAND, raw as WPARAM, 0) } != 0;
    if !posted {
        unsafe { drop(Box::from_raw(raw)) };
    }
    posted
}

fn spawn_indicator_command_thread(hwnd_value: isize) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let hwnd = hwnd_value as HWND;
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let command = match serde_json::from_str::<IndicatorCommand>(trimmed) {
                Ok(command) => command,
                Err(err) => {
                    let _ = emit_json(&StatusMessage::error(format!(
                        "Invalid indicator command: {err}"
                    )));
                    continue;
                }
            };

            let should_exit = matches!(command, IndicatorCommand::Quit);
            if !post_indicator_command(hwnd, command) || should_exit {
                return;
            }
        }

        let _ = post_indicator_command(hwnd, IndicatorCommand::Quit);
    })
}

pub fn handle_indicator() -> ExitCode {
    let _ = INDICATOR_STATE.set(Mutex::new(IndicatorState::default()));
    let _ = INDICATOR_ANIMATION.set(Mutex::new(IndicatorAnimation::default()));
    let class_name = to_wide("CodictateWindowsIndicator");
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let wc = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(indicator_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: unsafe { GetStockObject(BLACK_BRUSH) as _ },
        lpszMenuName: std::ptr::null(),
        lpszClassName: class_name.as_ptr(),
    };
    unsafe { RegisterClassW(&wc) };

    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
            class_name.as_ptr(),
            class_name.as_ptr(),
            WS_POPUP,
            0,
            0,
            72,
            72,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null_mut(),
        )
    };

    if hwnd.is_null() {
        let _ = emit_json(&StatusMessage::error(
            "CreateWindowExW failed for Windows indicator.",
        ));
        return ExitCode::from(1);
    }

    unsafe {
        SetLayeredWindowAttributes(hwnd, rgb(0, 0, 0), 0, LWA_COLORKEY);
        ShowWindow(hwnd, SW_HIDE);
    }

    let command_thread = spawn_indicator_command_thread(hwnd as isize);

    let _ = emit_json(&IndicatorStartedMessage::new());

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
        if result <= 0 {
            break;
        }

        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    let _ = command_thread.join();
    ExitCode::SUCCESS
}
