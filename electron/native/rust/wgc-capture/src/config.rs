//! Config parsing for the argv[1] JSON blob. The C++ helper used string
//! scanners that find keys at ANY depth, so `outputs.screenPath` and the
//! top-level `screenPath`/`outputPath` all work; the serde model mirrors the
//! effective lookups every real sender (handlers.ts, the test harnesses)
//! relies on, with strict-but-lenient defaults (`#[serde(default)]`
//! everywhere, unknown fields ignored).

use serde::Deserialize;

fn default_fps() -> f64 {
    60.0
}
fn default_gain() -> f64 {
    1.0
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawOutputs {
    pub screen_path: Option<String>,
}

/// Byte-exact port of the C++ findString scanner (main.cpp:243-293), used
/// for webcamPath: the FIRST textual occurrence of `"key"` at ANY depth
/// wins — including a present-but-empty value, and including an occurrence
/// inside `outputs` when that is serialized first. serde cannot observe key
/// order, and Codex round 2 (PR #81) showed the order matters for a config
/// carrying both locations. Same escape subset (\\ \" \/ \n \r \t, unknown
/// escapes pass through) and the same empty-on-shape-mismatch behavior.
/// The C++ quirk that the needle can match inside a string VALUE is
/// preserved deliberately.
fn find_string_first(json: &str, key: &str) -> String {
    let bytes = json.as_bytes();
    let needle = format!("\"{key}\"");
    let Some(pos) = json.find(&needle) else {
        return String::new();
    };
    let Some(colon) = json[pos..].find(':') else {
        return String::new();
    };
    let mut i = pos + colon + 1;
    // C-locale isspace set (0x09-0x0D + space) — is_ascii_whitespace would
    // miss \v (0x0B), which the C++ skips here (execution audit, PR #81).
    while i < bytes.len() && matches!(bytes[i], 0x09..=0x0D | 0x20) {
        i += 1;
    }
    if i >= bytes.len() || bytes[i] != b'"' {
        return String::new();
    }
    i += 1;

    let mut result: Vec<u8> = Vec::new();
    while i < bytes.len() {
        let c = bytes[i];
        i += 1;
        if c == b'"' {
            break;
        }
        if c == b'\\' && i < bytes.len() {
            let escaped = bytes[i];
            i += 1;
            match escaped {
                b'n' => result.push(b'\n'),
                b'r' => result.push(b'\r'),
                b't' => result.push(b'\t'),
                other => result.push(other),
            }
            continue;
        }
        result.push(c);
    }
    // '"' and '\\' are ASCII and cannot appear inside UTF-8 continuation
    // bytes, so the collected bytes are valid UTF-8 whenever the input was.
    String::from_utf8_lossy(&result).into_owned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawConfig {
    pub schema_version: i64,
    pub recording_id: i64,
    pub display_id: i64,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    pub window_handle: Option<String>,
    pub screen_path: Option<String>,
    pub output_path: Option<String>,
    pub outputs: RawOutputs,
    pub fps: f64,
    pub video_width: Option<i64>,
    pub width: Option<i64>,
    pub video_height: Option<i64>,
    pub height: Option<i64>,
    #[serde(rename = "displayX")]
    pub display_x: i32,
    #[serde(rename = "displayY")]
    pub display_y: i32,
    #[serde(rename = "displayW")]
    pub display_w: i32,
    #[serde(rename = "displayH")]
    pub display_h: i32,
    pub has_display_bounds: bool,
    pub capture_system_audio: bool,
    pub capture_mic: bool,
    pub capture_cursor: bool,
    pub webcam_enabled: bool,
    pub microphone_device_id: Option<String>,
    pub microphone_device_name: Option<String>,
    pub microphone_gain: f64,
    pub webcam_device_id: Option<String>,
    pub webcam_device_name: Option<String>,
    pub webcam_direct_show_clsid: Option<String>,
    pub webcam_width: i64,
    pub webcam_height: i64,
    pub webcam_fps: i64,
}

impl Default for RawConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            recording_id: 0,
            display_id: 0,
            source_type: None,
            source_id: None,
            window_handle: None,
            screen_path: None,
            output_path: None,
            outputs: RawOutputs::default(),
            fps: default_fps(),
            video_width: None,
            width: None,
            video_height: None,
            height: None,
            display_x: 0,
            display_y: 0,
            display_w: 0,
            display_h: 0,
            has_display_bounds: false,
            capture_system_audio: false,
            capture_mic: false,
            capture_cursor: false,
            webcam_enabled: false,
            microphone_device_id: None,
            microphone_device_name: None,
            microphone_gain: default_gain(),
            webcam_device_id: None,
            webcam_device_name: None,
            webcam_direct_show_clsid: None,
            webcam_width: 0,
            webcam_height: 0,
            webcam_fps: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug)]
pub struct CaptureConfig {
    pub output_path: String,
    pub source_type: String,
    pub window_handle: String,
    pub display_id: i64,
    pub fps: i32,
    pub bounds: MonitorBounds,
    pub has_display_bounds: bool,
    pub capture_system_audio: bool,
    pub capture_mic: bool,
    pub capture_cursor: bool,
    pub webcam_enabled: bool,
    pub microphone_device_id: String,
    pub microphone_device_name: String,
    pub microphone_gain: f64,
    pub webcam_device_id: String,
    pub webcam_device_name: String,
    pub webcam_direct_show_clsid: String,
    /// Resolved separate-webcam output path. LOAD-BEARING gate semantics:
    /// production handlers.ts always sends a non-empty outputs.webcamPath
    /// even with webcam disabled, so a separate webcam file is written only
    /// when `webcam_enabled && !webcam_path.is_empty()` (main.cpp:456-474
    /// assigns writeSeparateWebcam only inside the webcamEnabled block).
    pub webcam_path: String,
    pub webcam_width: i32,
    pub webcam_height: i32,
    pub webcam_fps: i32,
}

/// Extracts `<handle>` from a `window:<handle>:...` sourceId, matching
/// parseWindowHandleFromSourceId (main.cpp:295-305).
pub fn window_handle_from_source_id(source_id: &str) -> String {
    let Some(rest) = source_id.strip_prefix("window:") else {
        return String::new();
    };
    match rest.find(':') {
        Some(end) => rest[..end].to_string(),
        None => rest.to_string(),
    }
}

/// Strict window-handle parse (main.cpp:307-323): the WHOLE string must be a
/// valid number (0x/0X hex, else decimal) and nonzero — unlike the lenient
/// cursor-sampler parse. Returns 0 for "no handle".
pub fn parse_window_handle(value: &str) -> u64 {
    if value.is_empty() {
        return 0;
    }
    let (digits, radix) = if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        (hex, 16)
    } else {
        (value, 10)
    };
    if digits.is_empty() {
        return 0;
    }
    u64::from_str_radix(digits, radix).unwrap_or(0)
}

pub enum ConfigError {
    /// `ERROR: Failed to parse config JSON`
    Parse,
}

pub fn parse_config(json: &str) -> Result<CaptureConfig, ConfigError> {
    let raw: RawConfig = serde_json::from_str(json).map_err(|_| ConfigError::Parse)?;

    // screenPath at any depth beats outputPath (main.cpp:327-333); the C++
    // treats an EMPTY screenPath as absent and falls through to outputPath,
    // so empty candidates must be skipped, not selected.
    let non_empty = |o: Option<String>| o.filter(|s| !s.is_empty());
    let output_path = non_empty(raw.screen_path)
        .or_else(|| non_empty(raw.outputs.screen_path))
        .or_else(|| non_empty(raw.output_path))
        .unwrap_or_default();
    if output_path.is_empty() {
        return Err(ConfigError::Parse);
    }

    let source_type = match raw.source_type {
        Some(s) if !s.is_empty() => s,
        _ => "display".to_string(),
    };
    let source_id = raw.source_id.unwrap_or_default();
    let window_handle = match raw.window_handle {
        Some(h) if !h.is_empty() => h,
        _ => window_handle_from_source_id(&source_id),
    };

    let fps = (raw.fps as i64).clamp(1, 120) as i32;

    // webcamPath: first-textual-occurrence scan, exactly the C++ findString
    // (see find_string_first) — key ORDER decides between a top-level
    // webcamPath and outputs.webcamPath, and a present-but-empty first
    // occurrence stays empty (PiP), with no falls-through.
    let webcam_path = find_string_first(json, "webcamPath");

    Ok(CaptureConfig {
        output_path,
        source_type,
        window_handle,
        display_id: raw.display_id,
        fps,
        bounds: MonitorBounds {
            x: raw.display_x,
            y: raw.display_y,
            width: raw.display_w,
            height: raw.display_h,
        },
        has_display_bounds: raw.has_display_bounds,
        capture_system_audio: raw.capture_system_audio,
        capture_mic: raw.capture_mic,
        capture_cursor: raw.capture_cursor,
        webcam_enabled: raw.webcam_enabled,
        microphone_device_id: raw.microphone_device_id.unwrap_or_default(),
        microphone_device_name: raw.microphone_device_name.unwrap_or_default(),
        microphone_gain: raw.microphone_gain,
        webcam_device_id: raw.webcam_device_id.unwrap_or_default(),
        webcam_device_name: raw.webcam_device_name.unwrap_or_default(),
        webcam_direct_show_clsid: raw.webcam_direct_show_clsid.unwrap_or_default(),
        webcam_path,
        webcam_width: raw.webcam_width as i32,
        webcam_height: raw.webcam_height as i32,
        webcam_fps: raw.webcam_fps as i32,
    })
}

/// The separate-webcam-file gate (main.cpp:456-474): webcam must be ENABLED
/// and a path present. handlers.ts always sends a non-empty webcamPath, so
/// path-only gating would orphan a -webcam.mp4 on every plain recording.
pub fn write_separate_webcam(config: &CaptureConfig) -> bool {
    config.webcam_enabled && !config.webcam_path.is_empty()
}

/// Encode size derivation (main.cpp:449-450): the WGC item size rounded down
/// to even, min 2. Config width/height are advisory and ignored.
pub fn even_dimension(value: i32) -> i32 {
    (value.max(2) / 2) * 2
}

/// Bitrate ladder (main.cpp:453).
pub fn bitrate_for(width: i32, height: i32) -> i32 {
    let pixels = width * height;
    if pixels >= 3840 * 2160 {
        45_000_000
    } else if pixels >= 2560 * 1440 {
        28_000_000
    } else {
        18_000_000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_path_beats_output_path_and_nested_outputs_work() {
        let c = parse_config(r#"{"screenPath":"a.mp4","outputPath":"b.mp4"}"#)
            .ok()
            .unwrap();
        assert_eq!(c.output_path, "a.mp4");
        let c = parse_config(r#"{"outputs":{"screenPath":"n.mp4"},"outputPath":"b.mp4"}"#)
            .ok()
            .unwrap();
        assert_eq!(c.output_path, "n.mp4");
        let c = parse_config(r#"{"outputPath":"b.mp4"}"#).ok().unwrap();
        assert_eq!(c.output_path, "b.mp4");
        // Empty screenPath candidates fall through to outputPath, like the
        // C++ scanner treating "" as absent (handlers.ts can send empty
        // outputs entries).
        let c =
            parse_config(r#"{"screenPath":"","outputs":{"screenPath":""},"outputPath":"b.mp4"}"#)
                .ok()
                .unwrap();
        assert_eq!(c.output_path, "b.mp4");
        assert!(parse_config(r#"{"fps":30}"#).is_err());
        assert!(parse_config("not json").is_err());
    }

    #[test]
    fn handlers_ts_shape_parses() {
        // Mirror of the config electron/ipc/handlers.ts builds (schemaVersion 2).
        let json = r#"{
            "schemaVersion":2,"recordingId":3,"outputPath":"C:\\t\\v.mp4",
            "sourceType":"display","sourceId":"screen:0:0","displayId":123,
            "fps":60,"videoWidth":2560,"videoHeight":1440,
            "displayX":0,"displayY":0,"displayW":2560,"displayH":1440,
            "hasDisplayBounds":true,"captureSystemAudio":false,"captureMic":false,
            "microphoneDeviceId":"","microphoneDeviceName":"","microphoneGain":1,
            "webcamEnabled":false,"webcamDeviceId":"","webcamDeviceName":"",
            "webcamDirectShowClsid":"","webcamWidth":0,"webcamHeight":0,"webcamFps":0,
            "captureCursor":true,"cursorCaptureMode":"native",
            "outputs":{"screenPath":"C:\\t\\v.mp4","webcamPath":""}
        }"#;
        let c = parse_config(json).ok().unwrap();
        assert_eq!(c.output_path, "C:\\t\\v.mp4");
        assert_eq!(c.source_type, "display");
        assert_eq!(c.fps, 60);
        assert!(c.has_display_bounds);
        assert!(c.capture_cursor);
        assert!(!c.capture_system_audio && !c.capture_mic && !c.webcam_enabled);
        assert_eq!(
            c.bounds,
            MonitorBounds {
                x: 0,
                y: 0,
                width: 2560,
                height: 1440
            }
        );
    }

    #[test]
    fn fps_clamps_and_defaults() {
        assert_eq!(
            parse_config(r#"{"outputPath":"a","fps":0}"#)
                .ok()
                .unwrap()
                .fps,
            1
        );
        assert_eq!(
            parse_config(r#"{"outputPath":"a","fps":500}"#)
                .ok()
                .unwrap()
                .fps,
            120
        );
        assert_eq!(parse_config(r#"{"outputPath":"a"}"#).ok().unwrap().fps, 60);
    }

    #[test]
    fn window_handle_fallback_and_strict_parse() {
        let c =
            parse_config(r#"{"outputPath":"a","sourceType":"window","sourceId":"window:12345:0"}"#)
                .ok()
                .unwrap();
        assert_eq!(c.window_handle, "12345");
        let c = parse_config(
            r#"{"outputPath":"a","sourceType":"window","windowHandle":"0xAB","sourceId":"window:1:0"}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(c.window_handle, "0xAB");

        assert_eq!(parse_window_handle("12345"), 12345);
        assert_eq!(parse_window_handle("0xAB"), 0xAB);
        assert_eq!(parse_window_handle("0XaB"), 0xAB);
        // STRICT: trailing garbage rejects the whole value (unlike cursor-sampler).
        assert_eq!(parse_window_handle("123abc"), 0);
        assert_eq!(parse_window_handle("0"), 0);
        assert_eq!(parse_window_handle(""), 0);
        assert_eq!(parse_window_handle("abc"), 0);

        assert_eq!(window_handle_from_source_id("window:777:0"), "777");
        assert_eq!(window_handle_from_source_id("window:777"), "777");
        assert_eq!(window_handle_from_source_id("screen:0:0"), "");
    }

    #[test]
    fn webcam_fields_and_separate_gate() {
        // handlers.ts sends a non-empty outputs.webcamPath even with webcam
        // DISABLED — the separate-file gate must stay closed (plan-audit
        // MAJOR: path-only gating orphans a -webcam.mp4 on every recording).
        let c = parse_config(
            r#"{"outputPath":"a.mp4","webcamEnabled":false,
                "outputs":{"screenPath":"a.mp4","webcamPath":"a-webcam.mp4"}}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(c.webcam_path, "a-webcam.mp4");
        assert!(!write_separate_webcam(&c));

        // Enabled + path → separate file; top-level webcamPath wins over
        // nested, empty candidates fall through.
        let c = parse_config(
            r#"{"outputPath":"a.mp4","webcamEnabled":true,"webcamPath":"top.mp4",
                "outputs":{"webcamPath":"nested.mp4"},
                "webcamDeviceId":"id0","webcamDeviceName":"Cam",
                "webcamDirectShowClsid":"{00000000-0000-0000-0000-000000000000}",
                "webcamWidth":640,"webcamHeight":360,"webcamFps":30}"#,
        )
        .ok()
        .unwrap();
        assert!(write_separate_webcam(&c));
        assert_eq!(c.webcam_path, "top.mp4");
        assert_eq!(c.webcam_device_id, "id0");
        assert_eq!(c.webcam_device_name, "Cam");
        assert_eq!(
            c.webcam_direct_show_clsid,
            "{00000000-0000-0000-0000-000000000000}"
        );
        assert_eq!(
            (c.webcam_width, c.webcam_height, c.webcam_fps),
            (640, 360, 30)
        );

        // TEXTUAL order decides, exactly like the C++ findString: an empty
        // first occurrence STICKS (PiP), it must not fall through.
        let c = parse_config(
            r#"{"outputPath":"a.mp4","webcamEnabled":true,"webcamPath":"",
                "outputs":{"webcamPath":"nested.mp4"}}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(c.webcam_path, "");
        assert!(!write_separate_webcam(&c));
        // outputs serialized FIRST → its value wins over a later top-level
        // key (Codex round 2, PR #81).
        let c = parse_config(
            r#"{"outputPath":"a.mp4","webcamEnabled":true,
                "outputs":{"webcamPath":"nested.mp4"},"webcamPath":"top.mp4"}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(c.webcam_path, "nested.mp4");
        // Absent top-level key → outputs.webcamPath (the handlers.ts shape).
        let c = parse_config(
            r#"{"outputPath":"a.mp4","webcamEnabled":true,
                "outputs":{"webcamPath":"nested.mp4"}}"#,
        )
        .ok()
        .unwrap();
        assert_eq!(c.webcam_path, "nested.mp4");
        assert!(write_separate_webcam(&c));
        // Escaped Windows paths round-trip through the scanner's escape
        // subset (same as the C++).
        let c = parse_config(r#"{"outputPath":"a.mp4","webcamPath":"C:\\out\\w id.mp4"}"#)
            .ok()
            .unwrap();
        assert_eq!(c.webcam_path, "C:\\out\\w id.mp4");

        // Enabled + NO path → PiP mode (composited into the screen file).
        let c = parse_config(r#"{"outputPath":"a.mp4","webcamEnabled":true}"#)
            .ok()
            .unwrap();
        assert!(!write_separate_webcam(&c));
        assert_eq!(c.webcam_path, "");
    }

    #[test]
    fn even_dimensions_and_bitrate_ladder() {
        assert_eq!(even_dimension(2559), 2558);
        assert_eq!(even_dimension(2560), 2560);
        assert_eq!(even_dimension(1), 2);
        assert_eq!(even_dimension(0), 2);
        assert_eq!(bitrate_for(3840, 2160), 45_000_000);
        assert_eq!(bitrate_for(2560, 1440), 28_000_000);
        assert_eq!(bitrate_for(2558, 1440), 18_000_000);
        assert_eq!(bitrate_for(1920, 1080), 18_000_000);
    }
}
