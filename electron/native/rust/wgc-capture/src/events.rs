//! stdout event lines. Byte parity with the C++ emitter is protocol:
//! handlers.ts gates start/stop on the LEGACY text lines, and
//! nativeWindowsCaptureOutput.ts parses the JSON events.

use closescreen_native_protocol::json_escape;

pub fn ready_line() -> &'static str {
    "{\"event\":\"ready\",\"schemaVersion\":2}"
}

pub fn cursor_capture_line(requested: bool, applied: bool) -> String {
    format!(
        "{{\"event\":\"cursor-capture\",\"schemaVersion\":2,\"requested\":{requested},\"applied\":{applied}}}"
    )
}

pub fn recording_started_line() -> &'static str {
    "{\"event\":\"recording-started\",\"schemaVersion\":2}"
}

pub const LEGACY_STARTED_LINE: &str = "Recording started";

pub fn recording_paused_line() -> &'static str {
    "{\"event\":\"recording-paused\",\"schemaVersion\":2}"
}

pub fn recording_resumed_line() -> &'static str {
    "{\"event\":\"recording-resumed\",\"schemaVersion\":2}"
}

pub fn recording_failed_wedged_line() -> &'static str {
    "{\"event\":\"recording-failed\",\"schemaVersion\":2,\"reason\":\"video-writer-wedged\"}"
}

pub fn recording_stopped_line(screen_path: &str, webcam_path: Option<&str>) -> String {
    let mut out = format!(
        "{{\"event\":\"recording-stopped\",\"schemaVersion\":2,\"screenPath\":\"{}\"",
        json_escape(screen_path)
    );
    if let Some(webcam) = webcam_path {
        out.push_str(",\"webcamPath\":\"");
        out.push_str(&json_escape(webcam));
        out.push('"');
    }
    out.push('}');
    out
}

pub fn legacy_stopped_line(output_path: &str) -> String {
    format!("Recording stopped. Output path: {output_path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_lines_match_cpp() {
        assert_eq!(ready_line(), "{\"event\":\"ready\",\"schemaVersion\":2}");
        assert_eq!(
            cursor_capture_line(true, false),
            "{\"event\":\"cursor-capture\",\"schemaVersion\":2,\"requested\":true,\"applied\":false}"
        );
        assert_eq!(
            recording_started_line(),
            "{\"event\":\"recording-started\",\"schemaVersion\":2}"
        );
        assert_eq!(
            recording_paused_line(),
            "{\"event\":\"recording-paused\",\"schemaVersion\":2}"
        );
        assert_eq!(
            recording_resumed_line(),
            "{\"event\":\"recording-resumed\",\"schemaVersion\":2}"
        );
        assert_eq!(
            recording_failed_wedged_line(),
            "{\"event\":\"recording-failed\",\"schemaVersion\":2,\"reason\":\"video-writer-wedged\"}"
        );
        assert_eq!(
            recording_stopped_line("C:\\out\\v id.mp4", None),
            "{\"event\":\"recording-stopped\",\"schemaVersion\":2,\"screenPath\":\"C:\\\\out\\\\v id.mp4\"}"
        );
        assert_eq!(
            recording_stopped_line("a.mp4", Some("w.mp4")),
            "{\"event\":\"recording-stopped\",\"schemaVersion\":2,\"screenPath\":\"a.mp4\",\"webcamPath\":\"w.mp4\"}"
        );
        assert_eq!(
            legacy_stopped_line("C:\\out\\v.mp4"),
            "Recording stopped. Output path: C:\\out\\v.mp4"
        );
        assert_eq!(LEGACY_STARTED_LINE, "Recording started");
    }
}
