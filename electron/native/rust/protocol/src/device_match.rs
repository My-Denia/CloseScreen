//! Device-name fuzzy matching, shared by the audio (PR3) and webcam (PR4)
//! selectors. Port of the scoring the C++ helpers duplicate in
//! wasapi_loopback_capture.cpp and webcam_capture.cpp — browser deviceIds
//! don't map to WASAPI endpoint ids / MF symbolic links, so the renderer
//! passes human-readable names and the native side scores candidates.

/// Normalization: ASCII alphanumerics lowercased, every run of anything else
/// collapsed to a single space, trimmed. ASCII-only is deliberate: the C++
/// uses iswalnum under the default C locale, which strips CJK device-name
/// characters as separators — matching then keys on the ASCII remnants, and
/// the port must select the same devices.
pub fn normalize_device_name(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut last_was_space = true;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() {
            result.push(c.to_ascii_lowercase());
            last_was_space = false;
        } else if !last_was_space {
            result.push(' ');
            last_was_space = true;
        }
    }
    if result.ends_with(' ') {
        result.pop();
    }
    result
}

/// Scoring tiers: exact name 1000, name-substring either way 900,
/// id-substring either way 800, else per-word: name hit +100, id hit +50,
/// skipping 1-char words and the domain stop-words.
pub fn score_device_name(
    candidate_name: &str,
    candidate_id: &str,
    requested_name: &str,
    stop_words: &[&str],
) -> i32 {
    let candidate = normalize_device_name(candidate_name);
    let id = normalize_device_name(candidate_id);
    let requested = normalize_device_name(requested_name);
    if requested.is_empty() {
        return 0;
    }
    if candidate == requested {
        return 1000;
    }
    if !candidate.is_empty() && (candidate.contains(&requested) || requested.contains(&candidate)) {
        return 900;
    }
    if !id.is_empty() && (id.contains(&requested) || requested.contains(&id)) {
        return 800;
    }

    let mut score = 0;
    for word in requested.split(' ') {
        if word.chars().count() > 1 && !stop_words.contains(&word) {
            if candidate.contains(word) {
                score += 100;
            } else if id.contains(word) {
                score += 50;
            }
        }
    }
    score
}

/// Stop-words for audio-capture matching (wasapi_loopback_capture.cpp:104).
pub const AUDIO_STOP_WORDS: &[&str] = &["microphone", "mic", "audio", "input"];

/// Stop-words for webcam matching (webcam selectors + test harness).
pub const WEBCAM_STOP_WORDS: &[&str] = &["camera", "webcam", "video", "input"];

/// Webcam device scoring — port of deviceMatchScore
/// (webcam_capture.cpp:87-130). DIFFERENT semantics from the audio
/// waterfall above: every tier is aggregated with max(), the requested
/// DEVICE ID gets its own 700/600 tiers, and the symbolic link participates
/// in the name tiers. `contains_insensitive` in the C++ is bidirectional
/// substring over already-normalized strings and returns false when either
/// side is empty.
pub fn score_webcam_device(
    candidate_name: &str,
    candidate_link: &str,
    requested_name: &str,
    requested_id: &str,
) -> i32 {
    fn contains_either(a: &str, b: &str) -> bool {
        !a.is_empty() && !b.is_empty() && (a.contains(b) || b.contains(a))
    }

    let name = normalize_device_name(candidate_name);
    let link = normalize_device_name(candidate_link);
    let req_name = normalize_device_name(requested_name);
    let req_id = normalize_device_name(requested_id);

    let mut score = 0;
    if !req_name.is_empty() {
        if name == req_name {
            score = score.max(1000);
        }
        if contains_either(&name, &req_name) {
            score = score.max(900);
        }
        if contains_either(&link, &req_name) {
            score = score.max(800);
        }

        let mut word_score = 0;
        for word in req_name.split(' ') {
            if word.chars().count() > 1 && !WEBCAM_STOP_WORDS.contains(&word) {
                if name.contains(word) {
                    word_score += 100;
                } else if link.contains(word) {
                    word_score += 50;
                }
            }
        }
        score = score.max(word_score);
    }

    if !req_id.is_empty() {
        if contains_either(&link, &req_id) {
            score = score.max(700);
        }
        if contains_either(&name, &req_id) {
            score = score.max(600);
        }
    }

    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_collapses_and_lowercases() {
        assert_eq!(
            normalize_device_name("USB  Audio-Device (2)"),
            "usb audio device 2"
        );
        assert_eq!(normalize_device_name("--Mic--"), "mic");
        assert_eq!(normalize_device_name(""), "");
        // CJK strips to the ASCII remnants, matching the C++ C-locale iswalnum.
        assert_eq!(normalize_device_name("麦克风阵列 (Realtek)"), "realtek");
    }

    #[test]
    fn score_tiers_match_cpp() {
        let sw = AUDIO_STOP_WORDS;
        assert_eq!(score_device_name("USB Mic", "id0", "usb mic", sw), 1000);
        assert_eq!(
            score_device_name("Blue Yeti USB Mic", "id0", "Blue Yeti", sw),
            900
        );
        assert_eq!(
            score_device_name("Something", "endpoint blue yeti 7", "blue yeti 7", sw),
            800
        );
        // Word tier: "blue" +100 (name), "yeti" +50 (id only); stop-word
        // "microphone" and 1-char words skipped.
        assert_eq!(
            score_device_name(
                "blue thing",
                "has yeti inside",
                "blue yeti microphone x",
                sw
            ),
            150
        );
        assert_eq!(score_device_name("anything", "id", "", sw), 0);
        assert_eq!(score_device_name("", "", "microphone", sw), 0);
    }

    #[test]
    fn webcam_score_tiers_match_cpp() {
        // Exact normalized name.
        assert_eq!(
            score_webcam_device("HD Pro Webcam C920", "", "hd pro webcam c920", ""),
            1000
        );
        // Bidirectional name containment.
        assert_eq!(
            score_webcam_device("Logi HD Pro Webcam C920", "", "HD Pro Webcam", ""),
            900
        );
        assert_eq!(
            score_webcam_device("C920", "", "Logi C920 Stream Edition", ""),
            900
        );
        // Link contains requested name → 800 (name itself misses).
        assert_eq!(
            score_webcam_device("Integrated Camera", "usb vid 046d c920", "c920", ""),
            800
        );
        // Requested id vs link → 700, vs name → 600.
        assert_eq!(
            score_webcam_device("Foo", "usb vid 1bcf 2c99", "", "vid 1bcf"),
            700
        );
        assert_eq!(score_webcam_device("Device 2C99", "other", "", "2c99"), 600);
        // Word tier sums then maxes: "logi" name +100, "c920" link +50;
        // stop words camera/webcam/video/input and 1-char words skipped.
        assert_eq!(
            score_webcam_device("logi thing", "path c920 x", "logi c920 camera webcam a", ""),
            150
        );
        // Word tier LOSES to a higher id tier via max, never adds: name
        // word-hit alone is 100, but the id-in-link tier lifts to 700.
        assert_eq!(
            score_webcam_device("has alpha only", "usb 2c99", "alpha beta", "2c99"),
            700
        );
        // Bidirectional containment beats the id tier when both fire.
        assert_eq!(
            score_webcam_device("logi thing", "usb 2c99", "logi", "2c99"),
            900
        );
        // Nothing requested → 0 (caller selects first device).
        assert_eq!(score_webcam_device("Any Cam", "any link", "", ""), 0);
        // CJK-only requested name strips to empty → name tiers skipped.
        assert_eq!(score_webcam_device("Any Cam", "link", "摄像头", ""), 0);
    }
}
