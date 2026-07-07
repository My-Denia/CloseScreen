//! Cursor-type classification. Pure logic — no Win32 calls — so the exact
//! thresholds ported from the C++ helper stay under unit test.

/// Standard system cursors by resource id, in the same order as the C++
/// table. The names are part of the stdout protocol.
pub const STANDARD_CURSORS: [(u16, &str); 14] = [
    (32512, "arrow"),
    (32513, "text"),
    (32514, "wait"),
    (32515, "crosshair"),
    (32516, "up-arrow"),
    (32642, "resize-nwse"),
    (32643, "resize-nesw"),
    (32644, "resize-ew"),
    (32645, "resize-ns"),
    (32646, "move"),
    (32648, "not-allowed"),
    (32649, "pointer"),
    (32650, "app-starting"),
    (32651, "help"),
];

/// Heuristic detection of custom open-hand / closed-hand drag cursors from
/// the rendered BGRA pixels. Thresholds are a byte-for-byte port of the C++
/// `detectCustomCursorType` (itself replicating an older PowerShell sampler);
/// the alpha channel is the high byte of each little-endian BGRA word.
pub fn detect_custom_cursor_type(
    pixels: &[u32],
    w: i32,
    h: i32,
    hot_x: i32,
    hot_y: i32,
) -> Option<&'static str> {
    if w < 24 || h < 24 || w > 64 || h > 64 {
        return None;
    }
    if f64::from(hot_x) < f64::from(w) * 0.25 || f64::from(hot_x) > f64::from(w) * 0.75 {
        return None;
    }
    if f64::from(hot_y) < f64::from(h) * 0.15 || f64::from(hot_y) > f64::from(h) * 0.55 {
        return None;
    }

    let mut opaque = 0i32;
    let mut top_half = 0i32;
    let mut left = w;
    let mut top = h;
    let mut right = -1i32;
    let mut bottom = -1i32;

    for y in 0..h {
        for x in 0..w {
            let a = (pixels[(y * w + x) as usize] >> 24) as u8;
            if a <= 32 {
                continue;
            }
            opaque += 1;
            // Integer division, as in the C++ (`y < h / 2`).
            if y < h / 2 {
                top_half += 1;
            }
            if x < left {
                left = x;
            }
            if x > right {
                right = x;
            }
            if y < top {
                top = y;
            }
            if y > bottom {
                bottom = y;
            }
        }
    }

    if opaque < 90 || right < left || bottom < top {
        return None;
    }

    let ow = right - left + 1;
    let oh = bottom - top + 1;
    if f64::from(ow) < f64::from(w) * 0.35 || f64::from(ow) > f64::from(w) * 0.9 {
        return None;
    }
    if f64::from(oh) < f64::from(h) * 0.45 || f64::from(oh) > f64::from(h) {
        return None;
    }
    if f64::from(top) > f64::from(h) * 0.45 || f64::from(bottom) < f64::from(h) * 0.65 {
        return None;
    }

    if f64::from(top_half) > f64::from(opaque) * 0.55 {
        Some("closed-hand")
    } else {
        Some("open-hand")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a w×h transparent canvas with an axis-aligned block of pixels
    /// carrying the given BGRA word.
    fn canvas_with_block_value(
        w: i32,
        h: i32,
        block: (i32, i32, i32, i32), // left, top, right, bottom inclusive
        value: u32,
    ) -> Vec<u32> {
        let mut px = vec![0u32; (w * h) as usize];
        let (l, t, r, b) = block;
        for y in t..=b {
            for x in l..=r {
                px[(y * w + x) as usize] = value;
            }
        }
        px
    }

    fn canvas_with_block(w: i32, h: i32, block: (i32, i32, i32, i32)) -> Vec<u32> {
        canvas_with_block_value(w, h, block, 0xFF00_0000) // opaque black
    }

    #[test]
    fn rejects_out_of_range_dimensions() {
        let px = canvas_with_block(20, 32, (2, 2, 17, 29));
        assert_eq!(detect_custom_cursor_type(&px, 20, 32, 10, 8), None);
        let px = canvas_with_block(70, 32, (10, 2, 60, 29));
        assert_eq!(detect_custom_cursor_type(&px, 70, 32, 35, 8), None);
    }

    #[test]
    fn rejects_hotspot_outside_grab_zone() {
        let px = canvas_with_block(32, 32, (8, 6, 26, 28));
        // hotX below 25% of width
        assert_eq!(detect_custom_cursor_type(&px, 32, 32, 7, 10), None);
        // hotY above 55% of height
        assert_eq!(detect_custom_cursor_type(&px, 32, 32, 16, 18), None);
    }

    #[test]
    fn rejects_too_few_opaque_pixels() {
        // 8x8 block = 64 opaque pixels < 90
        let px = canvas_with_block(32, 32, (12, 8, 19, 15));
        assert_eq!(detect_custom_cursor_type(&px, 32, 32, 16, 10), None);
    }

    #[test]
    fn detects_open_hand_when_mass_is_balanced() {
        // Block spanning y=6..=28 of a 32-high canvas: top-half rows (y<16)
        // are 10 of 23 rows → topHalf/opaque ≈ 0.43 ≤ 0.55 → open-hand.
        let px = canvas_with_block(32, 32, (8, 6, 26, 28));
        assert_eq!(
            detect_custom_cursor_type(&px, 32, 32, 16, 10),
            Some("open-hand")
        );
    }

    #[test]
    fn detects_closed_hand_when_mass_is_top_heavy() {
        // Wide block y=4..=14 (all in top half) plus a thin stem y=15..=24
        // keeps bottom ≥ 0.65*h while placing most mass in the top half.
        let w = 32;
        let h = 32;
        let mut px = canvas_with_block(w, h, (6, 4, 27, 14));
        for y in 15..=24 {
            for x in 14..=17 {
                px[(y * w + x) as usize] = 0xFF00_0000;
            }
        }
        assert_eq!(
            detect_custom_cursor_type(&px, w, h, 16, 10),
            Some("closed-hand")
        );
    }

    #[test]
    fn alpha_threshold_is_exclusive_at_32() {
        // Same block geometry the open-hand test accepts, but with alpha
        // exactly 32: every pixel counts as transparent (a <= 32 skipped),
        // so detection falls through to None.
        let block = (8, 6, 26, 28);
        let at_threshold = canvas_with_block_value(32, 32, block, 0x2000_0000);
        assert_eq!(
            detect_custom_cursor_type(&at_threshold, 32, 32, 16, 10),
            None
        );
        // Alpha 33 counts as opaque: identical geometry now detects.
        let above_threshold = canvas_with_block_value(32, 32, block, 0x2100_0000);
        assert_eq!(
            detect_custom_cursor_type(&above_threshold, 32, 32, 16, 10),
            Some("open-hand")
        );
    }
}
