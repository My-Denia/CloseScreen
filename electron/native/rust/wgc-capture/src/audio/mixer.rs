//! AudioMixer — port of audio_sample_utils.cpp:254-439. Pulls the system and
//! microphone byte-queues onto a common 10ms-chunk timeline whose timestamps
//! come purely from the emitted-frames counter, and paces emission against a
//! wall-clock deadline. Pausing clears the queues and drops pushes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::format::AudioFormat;
use super::samples::{convert_audio_with_gain, mix_audio_in_place};

pub type OutputCallback = Box<dyn Fn(&[u8], i64, i64) -> bool + Send + Sync>; // (data, timestampHns, durationHns)

const HNS_PER_SECOND: u64 = 10_000_000;

struct MixerQueues {
    system: Vec<u8>,
    microphone: Vec<u8>,
    timeline_started: bool,
    paused: bool,
    /// Set by begin_timeline: the loop zeroes its emitted-frames counter and
    /// pacing clock on next wake (the C++ writes emittedFrames_ directly).
    rebase_counter: bool,
}

struct Shared {
    queues: Mutex<MixerQueues>,
    cv: Condvar,
    stop_requested: AtomicBool,
}

pub struct AudioMixer {
    format: AudioFormat,
    system_format: AudioFormat,
    microphone_format: AudioFormat,
    include_system: bool,
    include_microphone: bool,
    microphone_gain: f64,
    output: Arc<OutputCallback>,
    shared: Arc<Shared>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl AudioMixer {
    pub fn new(
        format: AudioFormat,
        system_format: AudioFormat,
        microphone_format: AudioFormat,
        include_system: bool,
        include_microphone: bool,
        microphone_gain: f64,
        output: OutputCallback,
    ) -> Self {
        Self {
            format,
            system_format,
            microphone_format,
            include_system,
            include_microphone,
            microphone_gain,
            output: Arc::new(output),
            shared: Arc::new(Shared {
                queues: Mutex::new(MixerQueues {
                    system: Vec::new(),
                    microphone: Vec::new(),
                    timeline_started: false,
                    paused: false,
                    rebase_counter: false,
                }),
                cv: Condvar::new(),
                stop_requested: AtomicBool::new(false),
            }),
            thread: Mutex::new(None),
        }
    }

    pub fn start(&self) -> bool {
        if self.format.sample_rate == 0 || self.format.block_align == 0 {
            return false;
        }
        self.shared.stop_requested.store(false, Ordering::SeqCst);
        {
            let mut q = self.shared.queues.lock().unwrap_or_else(|p| p.into_inner());
            q.timeline_started = false;
            q.paused = false;
        }
        let shared = Arc::clone(&self.shared);
        let output = Arc::clone(&self.output);
        let format = self.format;
        let include_system = self.include_system;
        let include_microphone = self.include_microphone;
        let handle = std::thread::spawn(move || {
            mix_loop(
                &shared,
                &output,
                &format,
                include_system,
                include_microphone,
            );
        });
        *self.thread.lock().unwrap_or_else(|p| p.into_inner()) = Some(handle);
        true
    }

    /// Clears both queues and rebases the timeline counter; called after the
    /// first video frame lands, before the video writer starts.
    pub fn begin_timeline(&self) {
        {
            let mut q = self.shared.queues.lock().unwrap_or_else(|p| p.into_inner());
            q.system.clear();
            q.microphone.clear();
            q.timeline_started = true;
            q.rebase_counter = true;
        }
        self.shared.cv.notify_all();
    }

    pub fn set_paused(&self, paused: bool) {
        {
            let mut q = self.shared.queues.lock().unwrap_or_else(|p| p.into_inner());
            q.paused = paused;
            if paused {
                q.system.clear();
                q.microphone.clear();
            }
        }
        self.shared.cv.notify_all();
    }

    pub fn stop(&self) {
        self.shared.stop_requested.store(true, Ordering::SeqCst);
        self.shared.cv.notify_all();
        let handle = self.thread.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(thread) = handle {
            let _ = thread.join();
        }
    }

    pub fn push_system(&self, data: &[u8]) {
        if !self.include_system || self.shared.stop_requested.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut q = self.shared.queues.lock().unwrap_or_else(|p| p.into_inner());
            if q.paused {
                return;
            }
            let mut converted = Vec::new();
            convert_audio_with_gain(data, &self.system_format, &self.format, 1.0, &mut converted);
            q.system.extend_from_slice(&converted);
        }
        self.shared.cv.notify_all();
    }

    pub fn push_microphone(&self, data: &[u8]) {
        if !self.include_microphone || self.shared.stop_requested.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut q = self.shared.queues.lock().unwrap_or_else(|p| p.into_inner());
            if q.paused {
                return;
            }
            let mut converted = Vec::new();
            convert_audio_with_gain(
                data,
                &self.microphone_format,
                &self.format,
                self.microphone_gain,
                &mut converted,
            );
            q.microphone.extend_from_slice(&converted);
        }
        self.shared.cv.notify_all();
    }
}

impl Drop for AudioMixer {
    fn drop(&mut self) {
        AudioMixer::stop(self);
    }
}

/// pop (audio_sample_utils.cpp:364-375): zero-filled fixed-size chunk, drains
/// up to chunk size from the queue.
fn pop(queue: &mut Vec<u8>, chunk: &mut Vec<u8>, byte_count: usize) -> bool {
    chunk.clear();
    chunk.resize(byte_count, 0);
    if queue.is_empty() {
        return false;
    }
    let copied = byte_count.min(queue.len());
    chunk[..copied].copy_from_slice(&queue[..copied]);
    queue.drain(..copied);
    copied > 0
}

fn mix_loop(
    shared: &Shared,
    output: &OutputCallback,
    format: &AudioFormat,
    include_system: bool,
    include_microphone: bool,
) {
    let chunk_frames = u64::from((format.sample_rate / 100).max(1));
    let chunk_bytes = (chunk_frames as usize) * format.block_align as usize;
    let mut mixed_chunk: Vec<u8> = Vec::new();
    let mut source_chunk: Vec<u8> = Vec::new();
    let mut emitted_frames: u64 = 0;
    let mut audio_clock_start: Option<Instant> = None;

    loop {
        {
            let guard = shared.queues.lock().unwrap_or_else(|p| p.into_inner());
            let (mut guard, _timeout) = shared
                .cv
                .wait_timeout_while(guard, Duration::from_millis(20), |q| {
                    let has_system = !include_system || q.system.len() >= chunk_bytes;
                    let has_microphone = !include_microphone || q.microphone.len() >= chunk_bytes;
                    let has_any = !q.system.is_empty() || !q.microphone.is_empty();
                    !(shared.stop_requested.load(Ordering::SeqCst)
                        || (q.timeline_started
                            && !q.paused
                            && (has_system || has_microphone)
                            && has_any))
                })
                .unwrap_or_else(|p| p.into_inner());

            if shared.stop_requested.load(Ordering::SeqCst) {
                break;
            }
            if !guard.timeline_started || guard.paused {
                continue;
            }
            if guard.rebase_counter {
                guard.rebase_counter = false;
                emitted_frames = 0;
                audio_clock_start = None;
            }
            if guard.system.is_empty() && guard.microphone.is_empty() {
                continue;
            }

            mixed_chunk.clear();
            mixed_chunk.resize(chunk_bytes, 0);
            if include_system {
                pop(&mut guard.system, &mut source_chunk, chunk_bytes);
                mix_audio_in_place(&mut mixed_chunk, &source_chunk, format);
            }
            if include_microphone {
                pop(&mut guard.microphone, &mut source_chunk, chunk_bytes);
                mix_audio_in_place(&mut mixed_chunk, &source_chunk, format);
            }
        }

        if audio_clock_start.is_none() {
            audio_clock_start = Some(Instant::now());
        }

        let timestamp_hns =
            ((emitted_frames * HNS_PER_SECOND) / u64::from(format.sample_rate)) as i64;
        let duration_hns = ((chunk_frames * HNS_PER_SECOND) / u64::from(format.sample_rate)) as i64;
        if !output(&mixed_chunk, timestamp_hns, duration_hns) {
            shared.stop_requested.store(true, Ordering::SeqCst);
            break;
        }
        emitted_frames += chunk_frames;

        let deadline = audio_clock_start.unwrap()
            + Duration::from_secs_f64(emitted_frames as f64 / f64::from(format.sample_rate));
        let now = Instant::now();
        if deadline > now {
            std::thread::sleep(deadline - now);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::audio::format::AudioSubtype;

    fn test_format() -> AudioFormat {
        AudioFormat {
            subtype: AudioSubtype::Pcm,
            sample_rate: 1_000,
            channels: 1,
            bits_per_sample: 16,
            block_align: 2,
            avg_bytes_per_sec: 2_000,
        }
    }

    fn system_mixer() -> (AudioMixer, mpsc::Receiver<(Vec<u8>, i64, i64)>) {
        let format = test_format();
        let (tx, rx) = mpsc::channel();
        let mixer = AudioMixer::new(
            format,
            format,
            format,
            true,
            false,
            1.0,
            Box::new(move |data, timestamp, duration| {
                tx.send((data.to_vec(), timestamp, duration)).is_ok()
            }),
        );
        (mixer, rx)
    }

    #[test]
    fn timeline_emits_ten_millisecond_chunks_and_rebases() {
        let (mixer, rx) = system_mixer();
        assert!(mixer.start());

        // Pre-roll must be discarded when the first video frame starts the
        // shared timeline.
        mixer.push_system(&[7; 20]);
        mixer.begin_timeline();
        mixer.push_system(&[1; 40]);

        let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let second = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!((first.1, first.2), (0, 100_000));
        assert_eq!((second.1, second.2), (100_000, 100_000));

        mixer.begin_timeline();
        mixer.push_system(&[2; 20]);
        let rebased = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!((rebased.1, rebased.2), (0, 100_000));
        mixer.stop();
    }

    #[test]
    fn pause_clears_partial_queues_drops_pushes_and_resume_keeps_timeline() {
        let (mixer, rx) = system_mixer();
        assert!(mixer.start());
        mixer.begin_timeline();
        mixer.push_system(&[1; 20]);
        let first = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first.1, 0);

        mixer.push_system(&[9; 10]);
        mixer.set_paused(true);
        mixer.push_system(&[8; 20]);
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());

        mixer.set_paused(false);
        mixer.push_system(&[2; 20]);
        let resumed = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(resumed.1, 100_000);
        assert_eq!(resumed.0, vec![2; 20]);

        let started = Instant::now();
        mixer.stop();
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn invalid_output_format_does_not_start() {
        let (mut mixer, _rx) = system_mixer();
        mixer.format.sample_rate = 0;
        assert!(!mixer.start());
    }
}
