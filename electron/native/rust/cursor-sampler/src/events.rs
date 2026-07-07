//! stdout line formatting. Field order and null spelling are protocol —
//! `windowsNativeRecordingSession.ts` treats every non-ready/error line as a
//! sample, so these formatters are kept pure and golden-tested byte-for-byte
//! against the C++ emitter's output shape.

use closescreen_native_protocol::json_escape;

pub fn format_ready_line(timestamp_ms: i64) -> String {
    format!("{{\"type\":\"ready\",\"timestampMs\":{timestamp_ms}}}")
}

pub fn format_error_line(timestamp_ms: i64, message: &str) -> String {
    format!(
        "{{\"type\":\"error\",\"timestampMs\":{timestamp_ms},\"message\":\"{}\"}}",
        json_escape(message)
    )
}

pub struct SampleFields<'a> {
    pub timestamp_ms: i64,
    pub x: i32,
    pub y: i32,
    pub visible: bool,
    /// Uppercase hex handle string ("0x1A2B") or None for a null cursor.
    pub handle: Option<&'a str>,
    pub cursor_type: Option<&'a str>,
    pub left_button_down: bool,
    pub left_button_pressed: bool,
    pub left_button_released: bool,
    /// Pre-rendered `{"x":..,"y":..,"width":..,"height":..}` or "null".
    pub bounds_json: &'a str,
    /// Pre-rendered asset object or "null".
    pub asset_json: &'a str,
}

pub fn format_sample_line(f: &SampleFields) -> String {
    let mut out = String::with_capacity(256);
    out.push_str("{\"type\":\"sample\"");
    out.push_str(",\"timestampMs\":");
    out.push_str(&f.timestamp_ms.to_string());
    out.push_str(",\"x\":");
    out.push_str(&f.x.to_string());
    out.push_str(",\"y\":");
    out.push_str(&f.y.to_string());
    out.push_str(",\"visible\":");
    out.push_str(if f.visible { "true" } else { "false" });
    out.push_str(",\"handle\":");
    match f.handle {
        Some(h) => {
            out.push('"');
            out.push_str(h);
            out.push('"');
        }
        None => out.push_str("null"),
    }
    out.push_str(",\"cursorType\":");
    match f.cursor_type {
        Some(t) => {
            out.push('"');
            out.push_str(t);
            out.push('"');
        }
        None => out.push_str("null"),
    }
    out.push_str(",\"leftButtonDown\":");
    out.push_str(if f.left_button_down { "true" } else { "false" });
    out.push_str(",\"leftButtonPressed\":");
    out.push_str(if f.left_button_pressed {
        "true"
    } else {
        "false"
    });
    out.push_str(",\"leftButtonReleased\":");
    out.push_str(if f.left_button_released {
        "true"
    } else {
        "false"
    });
    out.push_str(",\"bounds\":");
    out.push_str(f.bounds_json);
    out.push_str(",\"asset\":");
    out.push_str(f.asset_json);
    out.push('}');
    out
}

pub fn format_bounds_json(x: i32, y: i32, width: i32, height: i32) -> String {
    format!("{{\"x\":{x},\"y\":{y},\"width\":{width},\"height\":{height}}}")
}

pub fn format_asset_json(
    handle_str: &str,
    data_url: &str,
    width: i32,
    height: i32,
    hotspot_x: i32,
    hotspot_y: i32,
    cursor_type: Option<&str>,
) -> String {
    let mut json = String::with_capacity(data_url.len() + 128);
    json.push_str("{\"id\":\"");
    json.push_str(handle_str);
    json.push('"');
    json.push_str(",\"imageDataUrl\":\"");
    json.push_str(&json_escape(data_url));
    json.push('"');
    json.push_str(",\"width\":");
    json.push_str(&width.to_string());
    json.push_str(",\"height\":");
    json.push_str(&height.to_string());
    json.push_str(",\"hotspotX\":");
    json.push_str(&hotspot_x.to_string());
    json.push_str(",\"hotspotY\":");
    json.push_str(&hotspot_y.to_string());
    match cursor_type {
        Some(t) => {
            json.push_str(",\"cursorType\":\"");
            json.push_str(t);
            json.push('"');
        }
        None => json.push_str(",\"cursorType\":null"),
    }
    json.push('}');
    json
}

pub fn format_gdi_leak_test_line(
    iterations: i32,
    gdi_before: u32,
    gdi_after: u32,
    user_before: u32,
    user_after: u32,
) -> String {
    let gdi_delta = i64::from(gdi_after) - i64::from(gdi_before);
    let user_delta = i64::from(user_after) - i64::from(user_before);
    format!(
        "{{\"type\":\"gdi-leak-test\",\"iterations\":{iterations},\"gdiBefore\":{gdi_before},\"gdiAfter\":{gdi_after},\"gdiDelta\":{gdi_delta},\"userBefore\":{user_before},\"userAfter\":{user_after},\"userDelta\":{user_delta}}}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_matches_cpp_shape() {
        assert_eq!(
            format_ready_line(1751900000123),
            "{\"type\":\"ready\",\"timestampMs\":1751900000123}"
        );
    }

    #[test]
    fn error_line_matches_cpp_shape() {
        assert_eq!(
            format_error_line(5, "GetCursorInfo failed"),
            "{\"type\":\"error\",\"timestampMs\":5,\"message\":\"GetCursorInfo failed\"}"
        );
    }

    #[test]
    fn sample_line_field_order_and_null_spelling() {
        let line = format_sample_line(&SampleFields {
            timestamp_ms: 42,
            x: -3,
            y: 7,
            visible: true,
            handle: Some("0x1A2B"),
            cursor_type: Some("arrow"),
            left_button_down: false,
            left_button_pressed: true,
            left_button_released: false,
            bounds_json: "null",
            asset_json: "null",
        });
        assert_eq!(
            line,
            "{\"type\":\"sample\",\"timestampMs\":42,\"x\":-3,\"y\":7,\"visible\":true,\"handle\":\"0x1A2B\",\"cursorType\":\"arrow\",\"leftButtonDown\":false,\"leftButtonPressed\":true,\"leftButtonReleased\":false,\"bounds\":null,\"asset\":null}"
        );
    }

    #[test]
    fn sample_line_null_handle_and_type() {
        let line = format_sample_line(&SampleFields {
            timestamp_ms: 1,
            x: 0,
            y: 0,
            visible: false,
            handle: None,
            cursor_type: None,
            left_button_down: false,
            left_button_pressed: false,
            left_button_released: false,
            bounds_json: "{\"x\":10,\"y\":20,\"width\":300,\"height\":200}",
            asset_json: "null",
        });
        assert_eq!(
            line,
            "{\"type\":\"sample\",\"timestampMs\":1,\"x\":0,\"y\":0,\"visible\":false,\"handle\":null,\"cursorType\":null,\"leftButtonDown\":false,\"leftButtonPressed\":false,\"leftButtonReleased\":false,\"bounds\":{\"x\":10,\"y\":20,\"width\":300,\"height\":200},\"asset\":null}"
        );
    }

    #[test]
    fn bounds_json_field_order() {
        assert_eq!(
            format_bounds_json(-1920, 0, 1920, 1080),
            "{\"x\":-1920,\"y\":0,\"width\":1920,\"height\":1080}"
        );
    }

    #[test]
    fn asset_json_field_order_with_and_without_type() {
        assert_eq!(
            format_asset_json(
                "0xAB",
                "data:image/png;base64,QUJD",
                32,
                32,
                8,
                9,
                Some("open-hand")
            ),
            "{\"id\":\"0xAB\",\"imageDataUrl\":\"data:image/png;base64,QUJD\",\"width\":32,\"height\":32,\"hotspotX\":8,\"hotspotY\":9,\"cursorType\":\"open-hand\"}"
        );
        assert_eq!(
            format_asset_json("0xAB", "data:image/png;base64,QUJD", 32, 32, 8, 9, None),
            "{\"id\":\"0xAB\",\"imageDataUrl\":\"data:image/png;base64,QUJD\",\"width\":32,\"height\":32,\"hotspotX\":8,\"hotspotY\":9,\"cursorType\":null}"
        );
    }

    #[test]
    fn gdi_leak_test_line_shape() {
        assert_eq!(
            format_gdi_leak_test_line(5000, 30, 32, 10, 10),
            "{\"type\":\"gdi-leak-test\",\"iterations\":5000,\"gdiBefore\":30,\"gdiAfter\":32,\"gdiDelta\":2,\"userBefore\":10,\"userAfter\":10,\"userDelta\":0}"
        );
    }
}
