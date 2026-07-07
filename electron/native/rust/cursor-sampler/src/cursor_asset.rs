//! Cursor bitmap capture: render the HCURSOR onto a transparent 32-bpp DIB
//! via DrawIconEx (preserves per-pixel alpha, unlike Bitmap::FromHICON-style
//! conversion), classify custom hand cursors from the pixels, and encode a
//! PNG data URL. The C++ used GDI+ for the PNG step; here the `png` crate
//! replaces it — output bytes differ but consumers treat the data URL as
//! opaque, and dimensions/hotspot stay identical.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetObjectW, HGDIOBJ, SelectObject,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CopyIcon, DI_NORMAL, DestroyIcon, DrawIconEx, GetIconInfo, HCURSOR, ICONINFO,
};

use crate::cursor_type::detect_custom_cursor_type;
use crate::events::format_asset_json;

/// Result of rendering a cursor: everything needed for the asset JSON.
pub struct RenderedCursor {
    pub bgra: Vec<u8>,
    pub width: i32,
    pub height: i32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
}

/// Renders the cursor to BGRA pixels. Returns None on any Win32 failure,
/// mirroring the C++'s empty-string returns; all GDI objects acquired here
/// are released on every path (the --gdi-leak-test mode asserts this).
pub fn render_cursor(hcursor: HCURSOR) -> Option<RenderedCursor> {
    // Hotspot and dimensions from the icon info. For color cursors hbmColor
    // gives the size; monochrome cursors stack AND/XOR masks so the mask
    // bitmap is twice the cursor height.
    let mut ii = ICONINFO::default();
    // SAFETY: hcursor is a live cursor handle; ICONINFO is plain data.
    unsafe { GetIconInfo(hcursor.into(), &mut ii) }.ok()?;
    let hot_x = ii.xHotspot as i32;
    let hot_y = ii.yHotspot as i32;

    let mut w = 0i32;
    let mut h = 0i32;
    if !ii.hbmColor.is_invalid() {
        let mut bm = BITMAP::default();
        // SAFETY: hbmColor is a valid bitmap from GetIconInfo; sized output.
        let got = unsafe {
            GetObjectW(
                ii.hbmColor.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some((&raw mut bm).cast()),
            )
        };
        if got != 0 {
            w = bm.bmWidth;
            h = bm.bmHeight;
        }
    }
    if !ii.hbmMask.is_invalid() && (w == 0 || h == 0) {
        let mut bm = BITMAP::default();
        // SAFETY: hbmMask is a valid bitmap from GetIconInfo; sized output.
        let got = unsafe {
            GetObjectW(
                ii.hbmMask.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some((&raw mut bm).cast()),
            )
        };
        if got != 0 {
            w = bm.bmWidth;
            h = if ii.hbmColor.is_invalid() {
                bm.bmHeight / 2
            } else {
                bm.bmHeight
            };
        }
    }
    // SAFETY: GetIconInfo hands ownership of both bitmaps to the caller.
    unsafe {
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(ii.hbmMask.into());
        }
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(ii.hbmColor.into());
        }
    }
    if w <= 0 || h <= 0 {
        return None;
    }

    // Copy the handle so DrawIconEx cannot affect the live system cursor.
    // SAFETY: hcursor is live; the copy is destroyed below on all paths.
    let hcopy = unsafe { CopyIcon(hcursor.into()) }.ok()?;

    let stride = w * 4;
    let bih = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // negative = top-down scanline order
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let bmi = BITMAPINFO {
        bmiHeader: bih,
        ..Default::default()
    };

    // SAFETY: standard DIB render sequence; every handle created here is
    // released before return on both the success and failure paths.
    let bgra = unsafe {
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            let _ = DestroyIcon(hcopy);
            return None;
        }
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbmp = match CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(b) if !bits.is_null() => b,
            _ => {
                let _ = DeleteDC(hdc);
                let _ = DestroyIcon(hcopy);
                return None;
            }
        };

        let old: HGDIOBJ = SelectObject(hdc, hbmp.into());
        std::ptr::write_bytes(bits.cast::<u8>(), 0, (stride * h) as usize); // transparent black
        let _ = DrawIconEx(hdc, 0, 0, hcopy, w, h, 0, None, DI_NORMAL);
        let _ = GdiFlush();
        SelectObject(hdc, old);
        let _ = DeleteDC(hdc);
        let _ = DestroyIcon(hcopy);

        let slice = std::slice::from_raw_parts(bits.cast::<u8>(), (stride * h) as usize);
        let copy = slice.to_vec();
        let _ = DeleteObject(hbmp.into());
        copy
    };

    Some(RenderedCursor {
        bgra,
        width: w,
        height: h,
        hotspot_x: hot_x,
        hotspot_y: hot_y,
    })
}

/// PNG-encodes BGRA pixels into a data URL. Pure — unit-testable.
pub fn encode_png_data_url(bgra: &[u8], width: i32, height: i32) -> Option<String> {
    let mut rgba = bgra.to_vec();
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2); // BGRA -> RGBA
    }
    let mut png_bytes: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(format!(
        "data:image/png;base64,{}",
        BASE64.encode(&png_bytes)
    ))
}

/// Builds the asset JSON for a cursor, returning (json, custom_cursor_type).
/// Returns None where the C++ returned an empty string. The custom type is
/// reported even when it doesn't end up in the asset JSON's cursorType (the
/// sampler promotes it to the sample's cursorType exactly as the C++ does).
pub fn build_asset_json(
    hcursor: HCURSOR,
    handle_str: &str,
) -> Option<(String, Option<&'static str>)> {
    let rendered = render_cursor(hcursor)?;

    // The DIB stores little-endian BGRA; alpha is the high byte of each u32.
    let pixels: Vec<u32> = rendered
        .bgra
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let custom_type = detect_custom_cursor_type(
        &pixels,
        rendered.width,
        rendered.height,
        rendered.hotspot_x,
        rendered.hotspot_y,
    );

    let data_url = encode_png_data_url(&rendered.bgra, rendered.width, rendered.height)?;
    let json = format_asset_json(
        handle_str,
        &data_url,
        rendered.width,
        rendered.height,
        rendered.hotspot_x,
        rendered.hotspot_y,
        custom_type,
    );
    Some((json, custom_type))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_data_url_round_trips_dimensions() {
        // 2x2 BGRA: red, green, blue, transparent.
        let bgra: Vec<u8> = vec![
            0, 0, 255, 255, // red
            0, 255, 0, 255, // green
            255, 0, 0, 255, // blue
            0, 0, 0, 0, // transparent
        ];
        let url = encode_png_data_url(&bgra, 2, 2).unwrap();
        let b64 = url.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = BASE64.decode(b64).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (2, 2));
        // First pixel decodes back to RGBA red.
        assert_eq!(&buf[0..4], &[255, 0, 0, 255]);
    }
}
