//! Pure timestamp/pause math, split out of the writer loop so the exact C++
//! arithmetic stays under unit test.

use std::time::{Duration, Instant};

const HNS_PER_SECOND: i64 = 10_000_000;

/// Port of the writer-thread timestamp derivation (main.cpp:669-709). The
/// encoder applies its OWN first-timestamp latch and monotonic bump on top
/// (mf_encoder.cpp:318-327) — both layers are kept, matching the C++.
pub struct WriterTiming {
    fps: i64,
    frame_index: u64,
    first_frame_timestamp_hns: i64,  // -1 = unset
    last_encoded_timestamp_hns: i64, // -1 = unset
}

impl WriterTiming {
    pub fn new(fps: i32) -> Self {
        Self {
            fps: i64::from(fps.max(1)),
            frame_index: 0,
            first_frame_timestamp_hns: -1,
            last_encoded_timestamp_hns: -1,
        }
    }

    /// Computes the frame timestamp for this iteration. `latest_ts_hns` is the
    /// last WGC frame timestamp (0 = none yet → synthetic pacing).
    pub fn frame_timestamp(&mut self, latest_ts_hns: i64, paused_hns: i64) -> i64 {
        let synthetic = (self.frame_index as i64) * HNS_PER_SECOND / self.fps;
        let source = if latest_ts_hns > 0 {
            latest_ts_hns
        } else {
            synthetic
        };
        if self.first_frame_timestamp_hns < 0 {
            self.first_frame_timestamp_hns = source;
        }
        let mut ts = (source - self.first_frame_timestamp_hns - paused_hns).max(0);
        if self.last_encoded_timestamp_hns >= 0 && ts <= self.last_encoded_timestamp_hns {
            ts = self.last_encoded_timestamp_hns + HNS_PER_SECOND / self.fps;
        }
        ts
    }

    /// Records that the frame was actually encoded (main.cpp:707-709).
    pub fn mark_encoded(&mut self, ts: i64) {
        self.last_encoded_timestamp_hns = ts;
    }

    /// Advances the pacing index (main.cpp:712).
    pub fn advance_frame(&mut self) {
        self.frame_index += 1;
    }
}

/// The encoder-side timestamp latch (mf_encoder.cpp writeFrame): its own
/// first-timestamp rebase and monotonic bump, layered UNDER the writer-side
/// math above. Both sentinels start at -1 (mf_encoder.h), which is what lets
/// the first sample keep time 0 instead of being bumped.
pub struct EncoderTiming {
    fps: i64,
    first_timestamp_hns: i64, // -1 = unset
    last_timestamp_hns: i64,  // -1 = none written yet
}

impl EncoderTiming {
    pub fn new(fps: i32) -> Self {
        Self {
            fps: i64::from(fps.max(1)),
            first_timestamp_hns: -1,
            last_timestamp_hns: -1,
        }
    }

    pub fn sample_time(&mut self, timestamp_hns: i64) -> i64 {
        if self.first_timestamp_hns < 0 {
            self.first_timestamp_hns = timestamp_hns;
        }
        let mut t = timestamp_hns - self.first_timestamp_hns;
        if t <= self.last_timestamp_hns {
            t = self.last_timestamp_hns + HNS_PER_SECOND / self.fps;
        }
        self.last_timestamp_hns = t;
        t
    }

    pub fn sample_duration(&self) -> i64 {
        HNS_PER_SECOND / self.fps
    }
}

/// Port of `CaptureControl`'s pause bookkeeping (main.cpp:55-84): total paused
/// wall time in hns, including a live pause segment.
pub struct PauseTracker {
    paused: bool,
    pause_started_at: Instant,
    total_paused: Duration,
}

impl PauseTracker {
    pub fn new() -> Self {
        Self {
            paused: false,
            pause_started_at: Instant::now(),
            total_paused: Duration::ZERO,
        }
    }

    pub fn set_paused_at(&mut self, next: bool, now: Instant) {
        if next == self.paused {
            return;
        }
        if next {
            self.pause_started_at = now;
        } else {
            self.total_paused += now - self.pause_started_at;
        }
        self.paused = next;
    }

    pub fn paused_duration_hns_at(&self, now: Instant) -> i64 {
        let mut total = self.total_paused;
        if self.paused {
            total += now - self.pause_started_at;
        }
        (total.as_nanos() / 100) as i64
    }

    pub fn set_paused(&mut self, next: bool) {
        self.set_paused_at(next, Instant::now());
    }

    pub fn paused_duration_hns(&self) -> i64 {
        self.paused_duration_hns_at(Instant::now())
    }
}

impl Default for PauseTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_timestamps_pace_at_fps() {
        let mut t = WriterTiming::new(60);
        let a = t.frame_timestamp(0, 0);
        t.mark_encoded(a);
        t.advance_frame();
        let b = t.frame_timestamp(0, 0);
        // First synthetic source latches as first timestamp → 0, second is
        // one frame later minus the latch → bumped monotonically.
        assert_eq!(a, 0);
        assert_eq!(b, HNS_PER_SECOND / 60);
    }

    #[test]
    fn real_timestamps_rebase_to_zero_and_subtract_pause() {
        let mut t = WriterTiming::new(30);
        let a = t.frame_timestamp(50_000_000, 0);
        assert_eq!(a, 0);
        t.mark_encoded(a);
        t.advance_frame();
        // 1s later with 0.5s spent paused → 0.5s of media time.
        let b = t.frame_timestamp(60_000_000, 5_000_000);
        assert_eq!(b, 5_000_000);
    }

    #[test]
    fn monotonic_bump_when_timestamp_stalls() {
        let mut t = WriterTiming::new(60);
        let a = t.frame_timestamp(1_000_000, 0);
        t.mark_encoded(a);
        t.advance_frame();
        // Same WGC timestamp again (no new frame) → bumped by one frame.
        let b = t.frame_timestamp(1_000_000, 0);
        assert_eq!(b, a + HNS_PER_SECOND / 60);
        t.mark_encoded(b);
        t.advance_frame();
        // Pause subtraction pushing ts below last → also bumped.
        let c = t.frame_timestamp(2_000_000, 3_000_000);
        assert_eq!(c, b + HNS_PER_SECOND / 60);
    }

    #[test]
    fn encoder_latch_keeps_first_sample_at_zero() {
        let mut e = EncoderTiming::new(60);
        // First sample rebases to 0 and must NOT be bumped (last sentinel -1).
        assert_eq!(e.sample_time(5_000_000), 0);
        // Strictly increasing input passes through rebased.
        assert_eq!(e.sample_time(5_166_667), 166_667);
        // Stalled input gets the monotonic bump.
        assert_eq!(e.sample_time(5_166_667), 166_667 + HNS_PER_SECOND / 60);
        assert_eq!(e.sample_duration(), HNS_PER_SECOND / 60);
    }

    #[test]
    fn pause_tracker_accumulates_segments_and_live_pause() {
        let start = Instant::now();
        let mut p = PauseTracker::new();
        assert_eq!(p.paused_duration_hns_at(start), 0);
        p.set_paused_at(true, start);
        // Idempotent re-pause keeps the original segment start.
        p.set_paused_at(true, start + Duration::from_millis(100));
        let live = p.paused_duration_hns_at(start + Duration::from_millis(250));
        assert_eq!(live, 2_500_000); // 250ms live segment
        p.set_paused_at(false, start + Duration::from_millis(300));
        // Settled: 300ms total, no live segment growth afterwards.
        assert_eq!(
            p.paused_duration_hns_at(start + Duration::from_secs(5)),
            3_000_000
        );
        // Second segment adds on top.
        p.set_paused_at(true, start + Duration::from_secs(6));
        assert_eq!(
            p.paused_duration_hns_at(start + Duration::from_secs(7)),
            3_000_000 + 10_000_000
        );
    }
}
