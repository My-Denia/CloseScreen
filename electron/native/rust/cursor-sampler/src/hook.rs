//! Global low-level mouse hook. WH_MOUSE_LL requires a message pump on the
//! installing thread, so `install` is called from main before the pump runs;
//! the sampler thread drains the click counters.

use std::sync::atomic::{AtomicI32, Ordering};

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, HHOOK, SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL, WM_LBUTTONDOWN,
    WM_LBUTTONUP,
};

static LEFT_DOWN_COUNT: AtomicI32 = AtomicI32::new(0);
static LEFT_UP_COUNT: AtomicI32 = AtomicI32::new(0);

unsafe extern "system" fn low_level_mouse_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code >= 0 {
        if w_param.0 == WM_LBUTTONDOWN as usize {
            LEFT_DOWN_COUNT.fetch_add(1, Ordering::Relaxed);
        } else if w_param.0 == WM_LBUTTONUP as usize {
            LEFT_UP_COUNT.fetch_add(1, Ordering::Relaxed);
        }
    }
    // SAFETY: forwarding the hook chain call exactly as received.
    unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
}

pub struct MouseHook {
    handle: HHOOK,
}

impl MouseHook {
    /// Installs the WH_MOUSE_LL hook on the calling thread. Returns None on
    /// failure (caller prints the same stderr line as the C++ and exits 1).
    pub fn install() -> Option<Self> {
        // SAFETY: standard hook installation; the proc is a static fn and the
        // module handle outlives the process.
        let handle = unsafe {
            let module = GetModuleHandleW(None).ok()?;
            SetWindowsHookExW(
                WH_MOUSE_LL,
                Some(low_level_mouse_proc),
                Some(module.into()),
                0,
            )
            .ok()?
        };
        Some(Self { handle })
    }

    /// Atomically drains (downCount, upCount) accumulated since last call.
    pub fn consume_click_counts() -> (i32, i32) {
        (
            LEFT_DOWN_COUNT.swap(0, Ordering::Relaxed),
            LEFT_UP_COUNT.swap(0, Ordering::Relaxed),
        )
    }
}

impl Drop for MouseHook {
    fn drop(&mut self) {
        // SAFETY: handle came from a successful SetWindowsHookExW.
        unsafe {
            let _ = UnhookWindowsHookEx(self.handle);
        }
    }
}
