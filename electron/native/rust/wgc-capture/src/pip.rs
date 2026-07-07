//! Picture-in-picture webcam compositing + the visible-frame luma sampler.
//! Pure ports of compositeWebcam (mf_encoder.cpp:46-81) and
//! hasVisibleBgraContent (main.cpp:152-175) so the geometry and thresholds
//! get golden unit tests.

/// A borrowed BGRA frame (the C++ BgraFrameView).
pub struct BgraFrame<'a> {
    pub data: &'a [u8],
    pub width: i32,
    pub height: i32,
}

/// Overlay rectangle in destination coordinates: (origin_x, origin_y,
/// width, height). Geometry from compositeWebcam: margin max(16,min/60),
/// width capped at w/4, height capped at h/3 with aspect preserved, both
/// clamped into the margins, anchored bottom-right.
pub fn overlay_rect(
    width: i32,
    height: i32,
    cam_width: i32,
    cam_height: i32,
) -> (i32, i32, i32, i32) {
    let margin = 16.max(width.min(height) / 60);
    let max_overlay_width = 2.max(width / 4);
    let mut overlay_width = max_overlay_width;
    let mut overlay_height =
        ((i64::from(overlay_width) * i64::from(cam_height)) / i64::from(cam_width.max(1))) as i32;
    let max_overlay_height = 2.max(height / 3);
    if overlay_height > max_overlay_height {
        overlay_height = max_overlay_height;
        overlay_width = ((i64::from(overlay_height) * i64::from(cam_width))
            / i64::from(cam_height.max(1))) as i32;
    }

    overlay_width = 2.max(overlay_width.min(width - margin * 2));
    overlay_height = 2.max(overlay_height.min(height - margin * 2));
    let origin_x = 0.max(width - overlay_width - margin);
    let origin_y = 0.max(height - overlay_height - margin);
    (origin_x, origin_y, overlay_width, overlay_height)
}

/// Composites the webcam frame bottom-right into `destination` (a
/// width*height BGRA buffer), nearest-neighbor sampled, alpha forced 255.
pub fn composite_webcam(destination: &mut [u8], width: i32, height: i32, webcam: &BgraFrame<'_>) {
    if webcam.data.is_empty()
        || webcam.width <= 0
        || webcam.height <= 0
        || width <= 0
        || height <= 0
    {
        return;
    }

    let (origin_x, origin_y, overlay_width, overlay_height) =
        overlay_rect(width, height, webcam.width, webcam.height);

    for y in 0..overlay_height {
        let source_y =
            ((i64::from(y) * i64::from(webcam.height)) / i64::from(overlay_height)) as i32;
        let dest_row = (((origin_y + y) * width + origin_x) * 4) as usize;
        for x in 0..overlay_width {
            let source_x =
                ((i64::from(x) * i64::from(webcam.width)) / i64::from(overlay_width)) as i32;
            let src = ((source_y * webcam.width + source_x) * 4) as usize;
            let dst = dest_row + (x * 4) as usize;
            destination[dst] = webcam.data[src];
            destination[dst + 1] = webcam.data[src + 1];
            destination[dst + 2] = webcam.data[src + 2];
            destination[dst + 3] = 255;
        }
    }
}

/// hasVisibleBgraContent (main.cpp:152-175): sample ~4096 pixels, Rec.601-ish
/// integer luma, visible when maxLuma > 24 or averageLuma > 4. Gates both
/// warmup adoption and writer-loop refresh so an all-black warmup frame is
/// never composited.
pub fn has_visible_bgra_content(frame: &[u8]) -> bool {
    if frame.len() < 4 {
        return false;
    }

    let mut luma_total: u64 = 0;
    let mut max_luma: u8 = 0;
    let pixel_count = frame.len() / 4;
    let step = 1.max(pixel_count / 4096);
    let mut sampled: u64 = 0;
    let mut pixel = 0;
    while pixel < pixel_count {
        let offset = pixel * 4;
        let b = u16::from(frame[offset]);
        let g = u16::from(frame[offset + 1]);
        let r = u16::from(frame[offset + 2]);
        let luma = ((r * 54 + g * 183 + b * 19) >> 8) as u8;
        luma_total += u64::from(luma);
        max_luma = max_luma.max(luma);
        sampled += 1;
        pixel += step;
    }

    let average = luma_total.checked_div(sampled).unwrap_or(0);
    max_luma > 24 || average > 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_geometry_golden() {
        // 1920x1080, 16:9 cam: margin max(16,1080/60=18)=18; w=480 →
        // h=480*720/1280=270 <= 360 cap; origin (1920-480-18, 1080-270-18).
        assert_eq!(overlay_rect(1920, 1080, 1280, 720), (1422, 792, 480, 270));
        // Portrait cam hits the h/3 cap and recomputes width:
        // w=480 → h=480*1280/720=853 > 360 → h=360, w=360*720/1280=202.
        assert_eq!(overlay_rect(1920, 1080, 720, 1280), (1700, 702, 202, 360));
        // 2560x1440: margin 24, w=640, h=360 <= 480.
        assert_eq!(overlay_rect(2560, 1440, 1280, 720), (1896, 1056, 640, 360));
        // Tiny destination: margin 16, maxW max(2,25)=25, h=25*720/1280=14
        // (< 33 cap); clamp w to 100-32=68 → 25 stays; origins positive.
        assert_eq!(overlay_rect(100, 100, 1280, 720), (59, 70, 25, 14));
        // Degenerate cam width guards the divide.
        let (_, _, w, h) = overlay_rect(1920, 1080, 0, 720);
        assert!(w >= 2 && h >= 2);
    }

    #[test]
    fn composite_forces_alpha_and_places_bottom_right() {
        // 40x40 destination, 4x4 solid-red cam. margin=16, overlay w=max(2,10)=10,
        // h=10*4/4=10 (< max(2,13)); clamp to 40-32=8 → w=8,h=8; origin (16,16).
        let mut dest = vec![0u8; 40 * 40 * 4];
        let cam: Vec<u8> = std::iter::repeat_n([0u8, 0, 255, 0], 16)
            .flatten()
            .collect();
        composite_webcam(
            &mut dest,
            40,
            40,
            &BgraFrame {
                data: &cam,
                width: 4,
                height: 4,
            },
        );
        assert_eq!(overlay_rect(40, 40, 4, 4), (16, 16, 8, 8));
        let px = |x: usize, y: usize| {
            let o = (y * 40 + x) * 4;
            (dest[o], dest[o + 1], dest[o + 2], dest[o + 3])
        };
        // Inside the overlay: red with alpha forced 255 (source alpha was 0).
        assert_eq!(px(16, 16), (0, 0, 255, 255));
        assert_eq!(px(23, 23), (0, 0, 255, 255));
        // Outside: untouched.
        assert_eq!(px(15, 16), (0, 0, 0, 0));
        assert_eq!(px(24, 23), (0, 0, 0, 0));
        assert_eq!(px(16, 24), (0, 0, 0, 0));
    }

    #[test]
    fn visibility_thresholds_match_cpp() {
        assert!(!has_visible_bgra_content(&[]));
        assert!(!has_visible_bgra_content(&[0, 0, 0])); // < one pixel
        // All black → invisible.
        assert!(!has_visible_bgra_content(&vec![0u8; 64 * 64 * 4]));
        // Single bright pixel in a black frame small enough that step=1
        // samples it: maxLuma > 24 fires.
        let mut frame = vec![0u8; 64 * 64 * 4];
        frame[0] = 255; // b
        frame[1] = 255; // g
        frame[2] = 255; // r
        assert!(has_visible_bgra_content(&frame));
        // Uniform very dark gray: luma((8,8,8)) = (54+183+19)*8>>8 = 8 → avg
        // 8 > 4 fires even though max 8 <= 24.
        assert!(has_visible_bgra_content(&vec![8u8; 64 * 64 * 4]));
        // Uniform luma 4: (r=g=b=4) → luma 4; avg 4 NOT > 4, max 4 <= 24.
        assert!(!has_visible_bgra_content(&vec![4u8; 64 * 64 * 4]));
    }
}
