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

/// normalizeSystemAudioUnavailableReason + emit (main.cpp:136-150).
pub fn system_audio_unavailable_line(reason: &str) -> String {
    let normalized = match reason {
        "no-render-endpoint" | "device-in-use" | "unsupported-format" | "init-failed" => reason,
        _ => "init-failed",
    };
    format!(
        "{{\"event\":\"system-audio-unavailable\",\"schemaVersion\":2,\"reason\":\"{normalized}\"}}"
    )
}

/// audio-format event (main.cpp:511-521); microphoneDeviceName present only
/// when the mic is captured.
pub fn audio_format_line(
    sample_rate: u32,
    channels: u32,
    bits_per_sample: u32,
    system: bool,
    microphone: bool,
    microphone_device_name: Option<&str>,
) -> String {
    let mut out = format!(
        "{{\"event\":\"audio-format\",\"schemaVersion\":2,\"sampleRate\":{sample_rate},\"channels\":{channels},\"bitsPerSample\":{bits_per_sample},\"system\":{system},\"microphone\":{microphone}"
    );
    if let Some(name) = microphone_device_name {
        out.push_str(",\"microphoneDeviceName\":\"");
        out.push_str(&json_escape(name));
        out.push('"');
    }
    out.push('}');
    out
}

pub fn encoder_audio_format_line(sample_rate: u32, channels: u32, bits_per_sample: u32) -> String {
    format!(
        "{{\"event\":\"encoder-audio-format\",\"schemaVersion\":2,\"sampleRate\":{sample_rate},\"channels\":{channels},\"bitsPerSample\":{bits_per_sample}}}"
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
    fn audio_event_lines_match_cpp() {
        assert_eq!(
            system_audio_unavailable_line("device-in-use"),
            "{\"event\":\"system-audio-unavailable\",\"schemaVersion\":2,\"reason\":\"device-in-use\"}"
        );
        // Unknown reasons normalize to init-failed at emit time.
        assert_eq!(
            system_audio_unavailable_line("weird"),
            "{\"event\":\"system-audio-unavailable\",\"schemaVersion\":2,\"reason\":\"init-failed\"}"
        );
        assert_eq!(
            audio_format_line(48000, 2, 32, true, false, None),
            "{\"event\":\"audio-format\",\"schemaVersion\":2,\"sampleRate\":48000,\"channels\":2,\"bitsPerSample\":32,\"system\":true,\"microphone\":false}"
        );
        assert_eq!(
            audio_format_line(44100, 1, 16, false, true, Some("USB \"Mic\"")),
            "{\"event\":\"audio-format\",\"schemaVersion\":2,\"sampleRate\":44100,\"channels\":1,\"bitsPerSample\":16,\"system\":false,\"microphone\":true,\"microphoneDeviceName\":\"USB \\\"Mic\\\"\"}"
        );
        assert_eq!(
            encoder_audio_format_line(48000, 2, 16),
            "{\"event\":\"encoder-audio-format\",\"schemaVersion\":2,\"sampleRate\":48000,\"channels\":2,\"bitsPerSample\":16}"
        );
    }

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
