//! cursor-sampler — protocol-compatible Rust port of the C++ helper
//! (electron/native/wgc-capture/src/cursor-sampler.cpp).
//!
//! Usage: cursor-sampler <intervalMs> [windowHandle]
//!        cursor-sampler --gdi-leak-test [iterations]
//!
//! Emits newline-delimited JSON on stdout (ready / error / sample events);
//! the parent stops the helper by killing the process. See
//! electron/native/README.md for the contract.

mod cursor_asset;
mod cursor_type;
mod events;
mod hook;
mod sampler;

use std::sync::atomic::Ordering;

use closescreen_native_protocol::{LineWriter, atoi, stoull};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::{
    GR_GDIOBJECTS, GR_USEROBJECTS, GetCurrentProcess, GetCurrentThreadId, GetGuiResources,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, LoadCursorW, MSG, TranslateMessage,
};

use crate::cursor_type::STANDARD_CURSORS;
use crate::events::{format_gdi_leak_test_line, format_ready_line};
use crate::hook::MouseHook;
use crate::sampler::{STOP, now_ms, run_sampling_loop};

static WRITER: LineWriter = LineWriter::new();

/// GDI object-count regression test (issue 13-B in the C++ tree): loop the
/// asset builder over the standard system cursors and assert process-wide
/// GDI/USER object counts stay flat. Exit 0 = flat, 2 = leak, 1 = init fail.
fn run_gdi_leak_test(iterations_arg: Option<&str>) -> i32 {
    let iters = iterations_arg
        .map(|a| atoi(a).max(1) as i32)
        .unwrap_or(5000);

    // Warm-up: first-touch of each shared system cursor can lazily allocate
    // one-time objects that are not per-sample leaks; baseline after warm-up.
    for &(id, _) in STANDARD_CURSORS.iter() {
        // SAFETY: shared system cursor lookup, no ownership taken.
        let Ok(hc) =
            (unsafe { LoadCursorW(None, windows::core::PCWSTR(id as usize as *const u16)) })
        else {
            continue;
        };
        let _ = cursor_asset::build_asset_json(hc, "warmup");
    }

    // SAFETY: pseudo-handle query of our own process's GUI object counts.
    let (gdi_before, user_before) = unsafe {
        let p = GetCurrentProcess();
        (
            GetGuiResources(p, GR_GDIOBJECTS),
            GetGuiResources(p, GR_USEROBJECTS),
        )
    };

    for i in 0..iters {
        let (id, _) = STANDARD_CURSORS[(i as usize) % STANDARD_CURSORS.len()];
        // SAFETY: shared system cursor lookup, no ownership taken.
        let Ok(hc) =
            (unsafe { LoadCursorW(None, windows::core::PCWSTR(id as usize as *const u16)) })
        else {
            continue;
        };
        let _ = cursor_asset::build_asset_json(hc, "test");
    }

    // SAFETY: pseudo-handle query of our own process's GUI object counts.
    let (gdi_after, user_after) = unsafe {
        let p = GetCurrentProcess();
        (
            GetGuiResources(p, GR_GDIOBJECTS),
            GetGuiResources(p, GR_USEROBJECTS),
        )
    };

    let _ = WRITER.write_line(&format_gdi_leak_test_line(
        iters,
        gdi_before,
        gdi_after,
        user_before,
        user_after,
    ));

    // Tolerance for one-time lazy allocations that slip past warm-up; a real
    // per-sample leak scales with `iters` and dwarfs this.
    const TOLERANCE: i64 = 8;
    let gdi_delta = (i64::from(gdi_after) - i64::from(gdi_before)).abs();
    let user_delta = (i64::from(user_after) - i64::from(user_before)).abs();
    if gdi_delta <= TOLERANCE && user_delta <= TOLERANCE {
        0
    } else {
        2
    }
}

fn parse_window_handle(arg: &str) -> Option<HWND> {
    if arg.is_empty() || arg == "null" {
        return None;
    }
    let base = if arg.starts_with("0x") || arg.starts_with("0X") {
        16
    } else {
        10
    };
    let v = stoull(arg, base)?;
    if v == 0 {
        return None;
    }
    Some(HWND(v as usize as *mut core::ffi::c_void))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: cursor-sampler <intervalMs> [windowHandle]");
        std::process::exit(1);
    }

    if args[1] == "--gdi-leak-test" {
        std::process::exit(run_gdi_leak_test(args.get(2).map(String::as_str)));
    }

    let interval_ms = atoi(&args[1]).max(1) as u64;
    let target_window = args.get(2).and_then(|a| parse_window_handle(a));
    let target_window_raw = target_window.map(|h| h.0 as isize);

    // Install the global low-level mouse hook on this thread; the message
    // pump below is required for WH_MOUSE_LL callbacks to be delivered.
    let Some(_hook) = MouseHook::install() else {
        eprintln!("SetWindowsHookEx failed");
        std::process::exit(1);
    };

    // Prime GetAsyncKeyState so the first poll doesn't return stale
    // "pressed since last call" bits.
    // SAFETY: plain key-state query.
    unsafe {
        let _ = GetAsyncKeyState(VK_LBUTTON.0 as i32);
    }

    // Signal readiness — first stdout line, only after hook install.
    // SAFETY: current thread id query.
    let main_thread_id = unsafe { GetCurrentThreadId() };
    let _ = WRITER.write_line(&format_ready_line(now_ms()));

    // Sampling runs on a background thread.
    let sampler_thread = std::thread::spawn(move || {
        let target = target_window_raw.map(|raw| HWND(raw as usize as *mut core::ffi::c_void));
        run_sampling_loop(interval_ms, target, &WRITER, main_thread_id);
    });

    // Message pump on the main thread.
    let mut msg = MSG::default();
    // SAFETY: standard message pump; GetMessageW returns 0 on WM_QUIT and
    // -1 on error, both of which end the loop like the C++ `> 0` check.
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    STOP.store(true, Ordering::Relaxed);
    let _ = sampler_thread.join();
    // Hook unhooked by MouseHook::drop.
}
