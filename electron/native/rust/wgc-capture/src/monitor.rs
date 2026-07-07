//! Monitor resolution — port of monitor_utils.cpp. Bounds are the reliable
//! contract (Electron display ids are not stable across capture backends);
//! displayId is only honored when it exactly equals the HMONITOR value.

use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, HDC, HMONITOR, MONITOR_DEFAULTTOPRIMARY, MonitorFromPoint,
};

use crate::config::MonitorBounds;

struct Candidate {
    monitor: HMONITOR,
    rect: RECT,
}

unsafe extern "system" fn enum_proc(
    monitor: HMONITOR,
    _hdc: HDC,
    rect: *mut RECT,
    user_data: LPARAM,
) -> windows::core::BOOL {
    // SAFETY: user_data is the Vec pointer passed by enumerate_monitors below,
    // valid for the duration of the EnumDisplayMonitors call.
    unsafe {
        let list = &mut *(user_data.0 as *mut Vec<Candidate>);
        list.push(Candidate {
            monitor,
            rect: *rect,
        });
    }
    true.into()
}

fn enumerate_monitors() -> Vec<Candidate> {
    let mut monitors: Vec<Candidate> = Vec::new();
    // SAFETY: callback + userData contract as documented; the Vec outlives the call.
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(enum_proc),
            LPARAM(&raw mut monitors as isize),
        );
    }
    monitors
}

fn rect_matches(rect: &RECT, bounds: &MonitorBounds) -> bool {
    rect.left == bounds.x
        && rect.top == bounds.y
        && (rect.right - rect.left) == bounds.width
        && (rect.bottom - rect.top) == bounds.height
}

fn overlap_area(rect: &RECT, bounds: &MonitorBounds) -> i64 {
    let left = rect.left.max(bounds.x);
    let top = rect.top.max(bounds.y);
    let right = rect.right.min(bounds.x + bounds.width);
    let bottom = rect.bottom.min(bounds.y + bounds.height);
    if right <= left || bottom <= top {
        return 0;
    }
    i64::from(right - left) * i64::from(bottom - top)
}

fn primary_monitor() -> HMONITOR {
    // SAFETY: plain point query; always returns the primary monitor.
    unsafe {
        MonitorFromPoint(
            windows::Win32::Foundation::POINT { x: 0, y: 0 },
            MONITOR_DEFAULTTOPRIMARY,
        )
    }
}

pub fn find_monitor_for_capture(display_id: i64, bounds: Option<&MonitorBounds>) -> HMONITOR {
    let monitors = enumerate_monitors();
    if monitors.is_empty() {
        return primary_monitor();
    }

    if let Some(b) = bounds
        && b.width > 0
        && b.height > 0
    {
        for c in &monitors {
            if rect_matches(&c.rect, b) {
                return c.monitor;
            }
        }
        let mut best: Option<HMONITOR> = None;
        let mut best_area = 0i64;
        for c in &monitors {
            let area = overlap_area(&c.rect, b);
            if area > best_area {
                best_area = area;
                best = Some(c.monitor);
            }
        }
        if let Some(m) = best {
            return m;
        }
    }

    for c in &monitors {
        if c.monitor.0 as i64 == display_id {
            return c.monitor;
        }
    }

    primary_monitor()
}
