//! DirectShow frame conversions to top-down BGRA — pure port of
//! DirectShowWebcamCapture::storeFrame + yuvToBgr
//! (dshow_webcam_capture.cpp:82-94, 324-398).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    Bgra,
    Nv12,
    Yuy2,
}

fn clamp_to_byte(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

/// BT.601 integer YUV→BGR (yuvToBgr, dshow_webcam_capture.cpp:86-94).
pub fn yuv_to_bgr(y: u8, u: u8, v: u8) -> [u8; 3] {
    let c = i32::from(y) - 16;
    let d = i32::from(u) - 128;
    let e = i32::from(v) - 128;
    let blue = (298 * c + 516 * d + 128) >> 8;
    let green = (298 * c - 100 * d - 208 * e + 128) >> 8;
    let red = (298 * c + 409 * e + 128) >> 8;
    [
        clamp_to_byte(blue),
        clamp_to_byte(green),
        clamp_to_byte(red),
    ]
}

/// storeFrame's expectedLength gate (dshow_webcam_capture.cpp:326-330).
pub fn expected_length(format: PixelFormat, source_stride: i32, height: i32) -> i32 {
    match format {
        PixelFormat::Nv12 => source_stride * height + source_stride * ((height + 1) / 2),
        _ => source_stride * height,
    }
}

/// Converts one captured buffer into a top-down BGRA frame (alpha 255).
/// Returns None exactly when the C++ storeFrame早-returns: short buffer or
/// non-positive dims. `source_stride <= 0` falls back to width*4 like the
/// C++ local `sourceStride`.
pub fn convert_frame(
    buffer: &[u8],
    format: PixelFormat,
    width: i32,
    height: i32,
    source_stride: i32,
    source_top_down: bool,
) -> Option<Vec<u8>> {
    let destination_stride = width * 4;
    let source_stride = if source_stride > 0 {
        source_stride
    } else {
        destination_stride
    };
    let expected = expected_length(format, source_stride, height);
    if buffer.is_empty() || (buffer.len() as i64) < i64::from(expected) || width <= 0 || height <= 0
    {
        return None;
    }

    let w = width as usize;
    let dst_stride = destination_stride as usize;
    let src_stride = source_stride as usize;
    let mut frame = vec![0u8; dst_stride * height as usize];

    for y in 0..height as usize {
        let source_y = if source_top_down {
            y
        } else {
            height as usize - 1 - y
        };
        let source = &buffer[source_y * src_stride..];
        let destination = &mut frame[y * dst_stride..(y + 1) * dst_stride];

        match format {
            PixelFormat::Bgra => {
                destination.copy_from_slice(&source[..dst_stride]);
                for x in 0..w {
                    destination[x * 4 + 3] = 255;
                }
            }
            PixelFormat::Nv12 => {
                // uv plane starts after stride*height; uv row indexed by the
                // LITERAL sourceY/2 formula (equivalent to y/2 only because
                // NV12 forces topDown — port verbatim).
                let y_plane = &buffer[source_y * src_stride..];
                let uv_plane =
                    &buffer[src_stride * height as usize + (source_y / 2) * src_stride..];
                for x in 0..w {
                    let uv_x = (x / 2) * 2;
                    let color = yuv_to_bgr(y_plane[x], uv_plane[uv_x], uv_plane[uv_x + 1]);
                    let pixel = &mut destination[x * 4..x * 4 + 4];
                    pixel[0] = color[0];
                    pixel[1] = color[1];
                    pixel[2] = color[2];
                    pixel[3] = 255;
                }
            }
            PixelFormat::Yuy2 => {
                let mut x = 0;
                while x + 1 < w {
                    let y0 = source[x * 2];
                    let u = source[x * 2 + 1];
                    let y1 = source[x * 2 + 2];
                    let v = source[x * 2 + 3];
                    let first = yuv_to_bgr(y0, u, v);
                    let second = yuv_to_bgr(y1, u, v);
                    destination[x * 4..x * 4 + 4]
                        .copy_from_slice(&[first[0], first[1], first[2], 255]);
                    destination[x * 4 + 4..x * 4 + 8]
                        .copy_from_slice(&[second[0], second[1], second[2], 255]);
                    x += 2;
                }
                if w % 2 == 1 {
                    // Odd width: the last pixel reuses the PREVIOUS pair's
                    // chroma (dshow_webcam_capture.cpp:380-392). Signed math
                    // like the C++: for a width-1 frame x==0 and (x-1)/2
                    // truncates to 0 — usize would underflow (Codex, PR #81).
                    let x = w - 1;
                    let previous_pair_start = ((x as i32 - 1) / 2 * 4) as usize;
                    let y = source[x * 2];
                    let u = source[previous_pair_start + 1];
                    let v = source[previous_pair_start + 3];
                    let color = yuv_to_bgr(y, u, v);
                    destination[x * 4..x * 4 + 4]
                        .copy_from_slice(&[color[0], color[1], color[2], 255]);
                }
            }
        }
    }

    Some(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yuv_math_matches_cpp() {
        // Black (16,128,128) → 0,0,0; white (235,128,128) → 255,255,255.
        assert_eq!(yuv_to_bgr(16, 128, 128), [0, 0, 0]);
        assert_eq!(yuv_to_bgr(235, 128, 128), [255, 255, 255]);
        // Saturating clamp on out-of-range: blue/red overflow to 255,
        // green stays in range at 125.
        assert_eq!(yuv_to_bgr(255, 255, 255), [255, 125, 255]);
        // Spot value: (81,90,240) ≈ red. blue lands at -1>>8 → arithmetic
        // shift → clamp 0, matching the C++ signed shift.
        assert_eq!(yuv_to_bgr(81, 90, 240), [0, 0, 255]);
    }

    #[test]
    fn bgra_flips_bottom_up_and_forces_alpha() {
        // 2x2 bottom-up: source row 0 is the BOTTOM of the image.
        let src = [
            1, 2, 3, 0, /**/ 4, 5, 6, 0, // bottom row
            7, 8, 9, 0, /**/ 10, 11, 12, 0, // top row
        ];
        let out = convert_frame(&src, PixelFormat::Bgra, 2, 2, 8, false).unwrap();
        assert_eq!(&out[0..8], &[7, 8, 9, 255, 10, 11, 12, 255]);
        assert_eq!(&out[8..16], &[1, 2, 3, 255, 4, 5, 6, 255]);
        // Top-down (negative biHeight) copies straight through.
        let out = convert_frame(&src, PixelFormat::Bgra, 2, 2, 8, true).unwrap();
        assert_eq!(&out[0..8], &[1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn bgra_respects_padded_stride() {
        // width 1, stride 8 (4 bytes padding per row), bottom-up.
        let src = [
            1, 1, 1, 0, 99, 99, 99, 99, // bottom row + pad
            2, 2, 2, 0, 88, 88, 88, 88, // top row + pad
        ];
        let out = convert_frame(&src, PixelFormat::Bgra, 1, 2, 8, false).unwrap();
        assert_eq!(out, vec![2, 2, 2, 255, 1, 1, 1, 255]);
    }

    #[test]
    fn short_buffer_and_bad_dims_reject() {
        assert!(convert_frame(&[0; 15], PixelFormat::Bgra, 2, 2, 8, true).is_none());
        assert!(convert_frame(&[0; 16], PixelFormat::Bgra, 0, 2, 8, true).is_none());
        assert!(convert_frame(&[], PixelFormat::Bgra, 2, 2, 8, true).is_none());
        // NV12 expected length includes the uv plane: 4x2 stride 4 needs
        // 4*2 + 4*1 = 12.
        assert_eq!(expected_length(PixelFormat::Nv12, 4, 2), 12);
        assert!(convert_frame(&[0; 11], PixelFormat::Nv12, 4, 2, 4, true).is_none());
        assert!(convert_frame(&[16; 12], PixelFormat::Nv12, 4, 2, 4, true).is_some());
    }

    #[test]
    fn nv12_samples_uv_pairs() {
        // 2x2, stride 2. y plane rows: [16,235],[16,16]; uv plane one row
        // [128,128] (neutral) → grayscale.
        let buf = [16u8, 235, 16, 16, 128, 128];
        let out = convert_frame(&buf, PixelFormat::Nv12, 2, 2, 2, true).unwrap();
        assert_eq!(&out[0..4], &[0, 0, 0, 255]);
        assert_eq!(&out[4..8], &[255, 255, 255, 255]);
        assert_eq!(&out[8..12], &[0, 0, 0, 255]);
    }

    #[test]
    fn yuy2_pairs_share_chroma_and_odd_width_reuses_previous() {
        // width 3 (odd), 1 row, stride 8: [y0 u y1 v | y2 u2 y3 v2].
        // Pixels 0,1 use (u,v); pixel 2 (odd tail) reuses pair 0's chroma —
        // NOT u2/v2 at offsets 5/7.
        let row = [235u8, 128, 16, 128, 235, 90, 0, 240];
        let out = convert_frame(&row, PixelFormat::Yuy2, 3, 1, 8, true).unwrap();
        assert_eq!(&out[0..4], &[255, 255, 255, 255]);
        assert_eq!(&out[4..8], &[0, 0, 0, 255]);
        // Pixel 2: y=235 with NEUTRAL chroma from pair 0 → white.
        assert_eq!(&out[8..12], &[255, 255, 255, 255]);
    }

    #[test]
    fn yuy2_width_one_uses_offset_zero_chroma() {
        // Width 1: the odd-width tail hits x==0; the C++ signed (x-1)/2
        // truncates to offset 0 — must not underflow. Stride for 1px YUY2 is
        // ((16+31)/32)*4 = 4: [y, u, pad, v].
        let row = [235u8, 128, 0, 128];
        let out = convert_frame(&row, PixelFormat::Yuy2, 1, 1, 4, true).unwrap();
        assert_eq!(out, vec![255, 255, 255, 255]);
    }
}
