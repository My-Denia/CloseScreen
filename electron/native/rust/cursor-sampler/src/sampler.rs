//! The sampling loop (background thread). One iteration per interval: drain
//! click counters, read cursor state, emit exactly one sample line — plus an
//! asset object the first time each cursor handle is seen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, GetCursorInfo, GetWindowRect, HCURSOR, IsWindow, LoadCursorW,
    PostThreadMessageW, WM_QUIT,
};

use closescreen_native_protocol::LineWriter;

use crate::cursor_asset::build_asset_json;
use crate::cursor_type::STANDARD_CURSORS;
use crate::events::{SampleFields, format_bounds_json, format_error_line, format_sample_line};
use crate::hook::MouseHook;

pub static STOP: AtomicBool = AtomicBool::new(false);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lazily-initialized standard cursor handle table, mirroring the C++
/// static-init-once lookup. Values are raw handle pointers for comparison.
fn standard_cursor_type(hc: HCURSOR) -> Option<&'static str> {
    use std::sync::OnceLock;
    static HANDLES: OnceLock<Vec<(isize, &'static str)>> = OnceLock::new();
    if hc.is_invalid() {
        return None;
    }
    let table = HANDLES.get_or_init(|| {
        STANDARD_CURSORS
            .iter()
            .filter_map(|&(id, name)| {
                // SAFETY: MAKEINTRESOURCE-style lookup of shared system
                // cursors; failures are skipped like the C++ table init.
                let h =
                    unsafe { LoadCursorW(None, windows::core::PCWSTR(id as usize as *const u16)) };
                h.ok().map(|h| (h.0 as isize, name))
            })
            .collect()
    });
    let raw = hc.0 as isize;
    table
        .iter()
        .find(|&&(h, _)| h == raw)
        .map(|&(_, name)| name)
}

pub fn run_sampling_loop(
    interval_ms: u64,
    target_window: Option<HWND>,
    writer: &LineWriter,
    main_thread_id: u32,
) {
    let mut last_cursor: isize = 0;

    while !STOP.load(Ordering::Relaxed) {
        let (down_count, up_count) = MouseHook::consume_click_counts();

        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: ci.cbSize is set; plain data out-param.
        if unsafe { GetCursorInfo(&mut ci) }.is_err() {
            let _ = writer.write_line(&format_error_line(now_ms(), "GetCursorInfo failed"));
            std::thread::sleep(Duration::from_millis(interval_ms));
            continue;
        }

        let visible = (ci.flags.0 & CURSOR_SHOWING.0) != 0;
        let hc = ci.hCursor;
        let has_cursor = !hc.is_invalid();

        // Handle string: uppercase hex, matching the C++ "0x%llX".
        let handle_str = if has_cursor {
            format!("0x{:X}", hc.0 as usize)
        } else {
            String::new()
        };

        let mut cursor_type = standard_cursor_type(hc);

        // Mouse button state.
        // SAFETY: plain key-state query.
        let ks = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) };
        let left_down = (ks as u16 & 0x8000) != 0;
        let left_pressed = down_count > 0 || (ks as u16 & 0x0001) != 0;
        let left_released = up_count > 0;

        // Asset — only when the cursor handle changes. lastCursor advances
        // even when rendering fails, exactly like the C++.
        let mut asset_json: Option<String> = None;
        if visible && has_cursor && hc.0 as isize != last_cursor {
            if let Some((json, custom_type)) = build_asset_json(hc, &handle_str) {
                if cursor_type.is_none() && custom_type.is_some() {
                    cursor_type = custom_type;
                }
                asset_json = Some(json);
            }
            last_cursor = hc.0 as isize;
        }

        // Window bounds.
        let mut bounds_json = String::from("null");
        if let Some(hwnd) = target_window {
            // SAFETY: hwnd validity is checked by IsWindow before use.
            unsafe {
                if IsWindow(Some(hwnd)).as_bool() {
                    let mut r = RECT::default();
                    if GetWindowRect(hwnd, &mut r).is_ok() {
                        let bw = r.right - r.left;
                        let bh = r.bottom - r.top;
                        if bw > 0 && bh > 0 {
                            bounds_json = format_bounds_json(r.left, r.top, bw, bh);
                        }
                    }
                }
            }
        }

        let line = format_sample_line(&SampleFields {
            timestamp_ms: now_ms(),
            x: ci.ptScreenPos.x,
            y: ci.ptScreenPos.y,
            visible,
            handle: if has_cursor { Some(&handle_str) } else { None },
            cursor_type,
            left_button_down: left_down,
            left_button_pressed: left_pressed,
            left_button_released: left_released,
            bounds_json: &bounds_json,
            asset_json: asset_json.as_deref().unwrap_or("null"),
        });

        // Exit if the stdout pipe is broken (parent process died).
        if writer.write_line(&line).is_err() {
            // SAFETY: posting WM_QUIT to our own main thread's queue.
            unsafe {
                let _ = PostThreadMessageW(
                    main_thread_id,
                    WM_QUIT,
                    Default::default(),
                    Default::default(),
                );
            }
            break;
        }

        std::thread::sleep(Duration::from_millis(interval_ms));
    }
}
