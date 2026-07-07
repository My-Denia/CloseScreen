//! Shared protocol helpers for the CloseScreen native Windows helpers.
//!
//! Everything the Electron side parses is newline-delimited JSON on stdout.
//! The C++ helpers built these lines with hand-rolled formatting; the exact
//! byte shape (field order, escaping, null spelling) is load-bearing for the
//! TS parsers, so the formatters here reproduce it rather than delegating to
//! a general-purpose serializer.

use std::io::Write;
use std::sync::Mutex;

/// Serializes whole lines to stdout: one line per event, flushed immediately.
/// Mirrors the C++ helpers' mutex-guarded `std::cout << json << '\n' << flush`.
pub struct LineWriter {
    inner: Mutex<()>,
}

impl LineWriter {
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(()),
        }
    }

    /// Writes one line + flush. Returns Err when the pipe is gone (parent
    /// process died) — callers use that as their shutdown signal, matching
    /// the C++ `std::cout.fail()` check.
    pub fn write_line(&self, line: &str) -> std::io::Result<()> {
        let _guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        handle.write_all(line.as_bytes())?;
        handle.write_all(b"\n")?;
        handle.flush()
    }
}

impl Default for LineWriter {
    fn default() -> Self {
        Self::new()
    }
}

/// JSON string escaping identical to the C++ `jsonEscape`: only `"` `\` and
/// the three whitespace controls are escaped; all other bytes pass through.
/// The values this is applied to (paths come in as UTF-8, data URLs are
/// base64) never contain other control characters.
pub fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

/// C `atoi` semantics: optional leading whitespace, optional sign, then as
/// many digits as available; anything else (including no digits) yields 0.
/// The helpers clamp CLI numbers with `max(1, atoi(..))`, so garbage input
/// must become 0 here — not an error.
pub fn atoi(s: &str) -> i64 {
    let bytes = s.trim_start().as_bytes();
    let (sign, rest) = match bytes.first() {
        Some(b'-') => (-1i64, &bytes[1..]),
        Some(b'+') => (1i64, &bytes[1..]),
        _ => (1i64, bytes),
    };
    let mut value: i64 = 0;
    for &b in rest {
        if !b.is_ascii_digit() {
            break;
        }
        value = value.saturating_mul(10).saturating_add(i64::from(b - b'0'));
    }
    sign * value
}

/// C++ `std::stoull` semantics for the subset the helpers rely on: optional
/// leading whitespace and sign, then a non-empty digit run in the given base
/// (10 or 16, where base 16 accepts an optional 0x/0X prefix); trailing
/// garbage after the digits is ignored. Returns None where stoull would
/// throw (no digits at all).
pub fn stoull(s: &str, base: u32) -> Option<u64> {
    debug_assert!(base == 10 || base == 16);
    let bytes = s.trim_start().as_bytes();
    let rest = match bytes.first() {
        Some(b'+') => &bytes[1..],
        // stoull accepts a leading '-' and wraps; the helpers never pass
        // negative handles, but match the no-throw behavior.
        Some(b'-') => &bytes[1..],
        _ => bytes,
    };
    let negative = matches!(bytes.first(), Some(b'-'));
    let rest = if base == 16 && (rest.starts_with(b"0x") || rest.starts_with(b"0X")) {
        &rest[2..]
    } else {
        rest
    };
    let mut value: u64 = 0;
    let mut digits = 0usize;
    for &b in rest {
        let d = match (b as char).to_digit(base) {
            Some(d) => u64::from(d),
            None => break,
        };
        value = value.wrapping_mul(u64::from(base)).wrapping_add(d);
        digits += 1;
    }
    if digits == 0 {
        return None;
    }
    Some(if negative {
        value.wrapping_neg()
    } else {
        value
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_escape_matches_cpp_table() {
        assert_eq!(json_escape(r#"a"b\c"#), r#"a\"b\\c"#);
        assert_eq!(json_escape("x\ny\rz\t"), "x\\ny\\rz\\t");
        // Everything else passes through untouched, including non-ASCII.
        assert_eq!(
            json_escape("data:image/png;base64,AB+/="),
            "data:image/png;base64,AB+/="
        );
        assert_eq!(json_escape("鸣潮"), "鸣潮");
    }

    #[test]
    fn atoi_matches_c_semantics() {
        assert_eq!(atoi("25"), 25);
        assert_eq!(atoi("  42abc"), 42);
        assert_eq!(atoi("abc"), 0);
        assert_eq!(atoi(""), 0);
        assert_eq!(atoi("-7"), -7);
        assert_eq!(atoi("+8"), 8);
        // max(1, atoi(..)) is applied by callers; atoi itself may return <= 0.
        assert_eq!(atoi("0"), 0);
    }

    #[test]
    fn stoull_matches_cpp_semantics() {
        assert_eq!(stoull("123", 10), Some(123));
        assert_eq!(stoull("123abc", 10), Some(123));
        assert_eq!(stoull("0x1A2b", 16), Some(0x1A2B));
        assert_eq!(stoull("1A2b", 16), Some(0x1A2B));
        assert_eq!(stoull("abc", 10), None);
        assert_eq!(stoull("", 10), None);
        assert_eq!(stoull("  99", 10), Some(99));
        assert_eq!(stoull("0xzz", 16), None);
    }
}
