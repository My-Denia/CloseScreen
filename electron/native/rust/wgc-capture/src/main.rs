//! wgc-capture — protocol-compatible Rust port of the C++ helper
//! (electron/native/wgc-capture/src/main.cpp): video, audio, and webcam
//! capture paths.
//!
//! Invocation: wgc-capture.exe '<json-config>'. Commands on stdin
//! (pause/resume/stop), newline-delimited JSON events + legacy text lines on
//! stdout. See electron/native/README.md for the contract.

mod audio;
mod config;
mod encoder;
mod events;
mod monitor;
mod pip;
mod timing;
mod webcam;
mod wgc;

use std::io::BufRead as _;
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use closescreen_native_protocol::LineWriter;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{D3D11_TEXTURE2D_DESC, ID3D11Texture2D};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use windows::Win32::UI::WindowsAndMessaging::IsWindow;

use crate::audio::format::AudioFormat;
use crate::audio::mixer::AudioMixer;
use crate::audio::wasapi::WasapiCapture;
use crate::config::{
    CaptureConfig, bitrate_for, even_dimension, parse_config, parse_window_handle,
    write_separate_webcam,
};
use crate::encoder::MfEncoder;
use crate::pip::{BgraFrame, has_visible_bgra_content};
use crate::timing::{PauseTracker, WriterTiming};
use crate::webcam::{FrameStore, WebcamCapture, WebcamFrameSnapshot};
use crate::wgc::{CaptureTarget, WgcSession};

pub static WRITER: LineWriter = LineWriter::new();

/// stderr helper matching the C++ `succeeded()` format.
pub fn eprint_hr(label: &str, hr: windows::core::HRESULT) {
    eprintln!("ERROR: {label} failed (hr=0x{:x})", hr.0 as u32);
}

struct FrameSlot {
    texture: Option<ID3D11Texture2D>,
    timestamp_hns: i64,
}

// SAFETY: the texture is only touched under the surrounding `slot` mutex
// (frame callback CopyResource, writer-thread encode, finalize), and all
// threads run in the MTA — the same serialization discipline as the C++
// capture `mutex`.
unsafe impl Send for FrameSlot {}

/// Device+context pair handed to the frame callback.
struct CallbackGpu {
    device: windows::Win32::Graphics::Direct3D11::ID3D11Device,
    context: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
}

// SAFETY: the immediate context is not free-threaded, but every use of this
// pair happens while holding the `slot` mutex, which also guards the writer
// thread's staging-copy uses — one context user at a time, MTA process, the
// exact discipline main.cpp enforces with its capture mutex.
unsafe impl Send for CallbackGpu {}

/// Shared control state. The condvar pairs with the frame-slot mutex, exactly
/// like the C++ pairing of `control.cv` with the capture `mutex`.
struct Control {
    stop: AtomicBool,
    paused: AtomicBool,
    encode_failed: AtomicBool,
    first_frame_written: AtomicBool,
    pause: Mutex<PauseTracker>,
    slot: Mutex<FrameSlot>,
    cv: Condvar,
}

impl Control {
    fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            encode_failed: AtomicBool::new(false),
            first_frame_written: AtomicBool::new(false),
            pause: Mutex::new(PauseTracker::new()),
            slot: Mutex::new(FrameSlot {
                texture: None,
                timestamp_hns: 0,
            }),
            cv: Condvar::new(),
        }
    }

    fn set_paused(&self, next: bool) {
        let mut tracker = self.pause.lock().unwrap_or_else(|p| p.into_inner());
        tracker.set_paused(next);
        self.paused.store(next, Ordering::SeqCst);
    }

    fn paused_duration_hns(&self) -> i64 {
        self.pause
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .paused_duration_hns()
    }

    fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }

    fn fail_encode(&self) {
        self.encode_failed.store(true, Ordering::SeqCst);
        self.request_stop();
    }
}

/// Reads pause/resume/stop commands from stdin (readCaptureCommands port).
/// EOF requests stop, matching the C++. The mixer pause hook runs before the
/// event echo, like the C++ onPauseChanged callback.
fn stdin_command_loop(control: Arc<Control>, mixer: Option<Arc<AudioMixer>>) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        match line.as_str() {
            "stop" | "q" | "quit" => {
                control.request_stop();
                return;
            }
            "pause" => {
                control.set_paused(true);
                if let Some(mixer) = &mixer {
                    mixer.set_paused(true);
                }
                let _ = WRITER.write_line(events::recording_paused_line());
                control.cv.notify_all();
            }
            "resume" => {
                control.set_paused(false);
                if let Some(mixer) = &mixer {
                    mixer.set_paused(false);
                }
                let _ = WRITER.write_line(events::recording_resumed_line());
                control.cv.notify_all();
            }
            _ => {}
        }
    }
    control.request_stop();
}

/// Signals writer-thread completion on ANY exit path via Drop (the C++
/// DoneSignal RAII guard). A wedged write_frame never reaches the drop, which
/// is exactly what the bounded shutdown wait detects.
struct DoneSignal {
    pair: Arc<(Mutex<bool>, Condvar)>,
}

impl Drop for DoneSignal {
    fn drop(&mut self) {
        let (done, cv) = &*self.pair;
        {
            let mut guard = done.lock().unwrap_or_else(|p| p.into_inner());
            *guard = true;
        }
        cv.notify_all();
    }
}

/// The separate-webcam-file half of the writer state (main.cpp:637-638,
/// 685-696): its own encoder instance, pure-counter timestamps, one frame
/// per NEW webcam sequence.
struct SeparateWebcamWriter {
    encoder: Arc<MfEncoder>,
    fps: i32,
    last_written_sequence: u64,
    output_frame_index: u64,
}

/// Webcam state owned by the writer thread. Seeded with the warmup-adopted
/// snapshot so the warmup frame is written/composited on the first
/// iteration even if the camera never delivers another frame (the C++
/// shares the same locals between warmup and writer, main.cpp:569-573,
/// 823-836).
struct WebcamWriter {
    store: Arc<FrameStore>,
    frame: Vec<u8>,
    width: i32,
    height: i32,
    sequence: u64,
    has_visible: bool,
    separate: Option<SeparateWebcamWriter>,
}

impl WebcamWriter {
    /// The writer-loop refresh (main.cpp:652-663): adopt the newest frame
    /// only when the sequence advanced AND the frame has visible content.
    fn refresh(&mut self, scratch: &mut WebcamFrameSnapshot) {
        if self.store.copy_latest(scratch)
            && scratch.sequence != self.sequence
            && has_visible_bgra_content(&scratch.data)
        {
            std::mem::swap(&mut self.frame, &mut scratch.data);
            self.width = scratch.width;
            self.height = scratch.height;
            self.sequence = scratch.sequence;
            self.has_visible = true;
        }
    }

    fn visible(&self) -> bool {
        self.has_visible && !self.frame.is_empty()
    }
}

/// The paced video writer loop (writeVideoFrames port). Holds the
/// frame-slot mutex ACROSS encoder.write_frame — that is the issue-#14 wedge
/// surface, and the frame callback's early-return protects the WGC teardown
/// barrier from it. Webcam refresh + the separate-file write happen under
/// that same lock, like the C++ block at main.cpp:642-710.
fn write_video_frames(
    control: Arc<Control>,
    encoder: Arc<MfEncoder>,
    fps: i32,
    mut webcam: Option<WebcamWriter>,
    done_pair: Arc<(Mutex<bool>, Condvar)>,
) {
    let _done = DoneSignal { pair: done_pair };
    let frame_duration = Duration::from_secs_f64(1.0 / f64::from(fps.max(1)));
    let mut timing = WriterTiming::new(fps);
    let mut scratch = WebcamFrameSnapshot::default();

    loop {
        {
            let mut slot = control.slot.lock().unwrap_or_else(|p| p.into_inner());
            loop {
                if control.stop.load(Ordering::SeqCst)
                    || control.encode_failed.load(Ordering::SeqCst)
                {
                    return;
                }
                if !control.paused.load(Ordering::SeqCst) && slot.texture.is_some() {
                    break;
                }
                slot = control.cv.wait(slot).unwrap_or_else(|p| p.into_inner());
            }

            if let Some(cam) = webcam.as_mut() {
                cam.refresh(&mut scratch);
            }

            let ts = timing.frame_timestamp(slot.timestamp_hns, control.paused_duration_hns());

            // Separate webcam file: one frame per new sequence, pure-counter
            // timestamps (main.cpp:685-696).
            if let Some(cam) = webcam.as_mut()
                && cam.visible()
            {
                let WebcamWriter {
                    frame,
                    width,
                    height,
                    sequence,
                    separate,
                    ..
                } = cam;
                if let Some(sep) = separate
                    && *sequence != sep.last_written_sequence
                {
                    let view = BgraFrame {
                        data: frame,
                        width: *width,
                        height: *height,
                    };
                    let webcam_ts =
                        ((sep.output_frame_index * 10_000_000) / sep.fps.max(1) as u64) as i64;
                    if !sep.encoder.write_bgra_frame(&view, webcam_ts) {
                        control.fail_encode();
                        return;
                    }
                    sep.last_written_sequence = *sequence;
                    sep.output_frame_index += 1;
                }
            }

            // PiP overlay only when NOT writing a separate file
            // (main.cpp:698-701).
            let overlay = webcam.as_ref().and_then(|cam| {
                (cam.separate.is_none() && cam.visible()).then_some(BgraFrame {
                    data: &cam.frame,
                    width: cam.width,
                    height: cam.height,
                })
            });
            let texture = slot.texture.as_ref().expect("predicate guarantees texture");
            if !encoder.write_frame(texture, ts, overlay.as_ref()) {
                control.fail_encode();
                return;
            }
            timing.mark_encoded(ts);
        }

        timing.advance_frame();
        std::thread::sleep(frame_duration);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("ERROR: Missing JSON config argument");
        std::process::exit(1);
    }

    // SAFETY: one-time MTA apartment init on the main thread, matching
    // winrt::init_apartment(multi_threaded).
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    let config = match parse_config(&args[1]) {
        Ok(c) => c,
        Err(_) => {
            eprintln!("ERROR: Failed to parse config JSON");
            std::process::exit(1);
        }
    };

    let _ = WRITER.write_line(events::ready_line());

    run(config);
}

fn run(config: CaptureConfig) {
    let mut session = WgcSession::new();
    match config.source_type.as_str() {
        "display" => {
            let monitor = monitor::find_monitor_for_capture(
                config.display_id,
                config.has_display_bounds.then_some(&config.bounds),
            );
            if monitor.is_invalid() {
                eprintln!("ERROR: Could not resolve monitor");
                std::process::exit(1);
            }
            if !session.initialize(CaptureTarget::Monitor(monitor), config.capture_cursor) {
                eprintln!("ERROR: Failed to initialize WGC display session");
                std::process::exit(1);
            }
        }
        "window" => {
            let handle = parse_window_handle(&config.window_handle);
            let hwnd = HWND(handle as usize as *mut core::ffi::c_void);
            // SAFETY: plain validity check of a parsed handle value.
            let valid = handle != 0 && unsafe { IsWindow(Some(hwnd)) }.as_bool();
            if !valid {
                eprintln!("ERROR: Native window capture requires a valid HWND");
                std::process::exit(1);
            }
            if !session.initialize(CaptureTarget::Window(hwnd), config.capture_cursor) {
                eprintln!("ERROR: Failed to initialize WGC window session");
                std::process::exit(1);
            }
        }
        other => {
            eprintln!("ERROR: Unsupported native capture source type: {other}");
            std::process::exit(1);
        }
    }

    // WGC owns the captured texture size; encode at that size rounded to even
    // (CopyResource requires matching dimensions — no scaling pass yet).
    let width = even_dimension(session.capture_width());
    let height = even_dimension(session.capture_height());
    let bitrate = bitrate_for(width, height);

    let (device, context) = match (session.device(), session.context()) {
        (Some(d), Some(c)) => (d.clone(), c.clone()),
        _ => {
            eprintln!("ERROR: Failed to initialize WGC display session");
            std::process::exit(1);
        }
    };

    // Webcam init + format event BEFORE audio init (main.cpp:455-475).
    // Init failure is fatal; the separate-file decision needs BOTH the
    // enabled flag and a path (see write_separate_webcam).
    let mut webcam: Option<WebcamCapture> = None;
    let write_separate = write_separate_webcam(&config);
    if config.webcam_enabled {
        let requested_fps = if config.webcam_fps > 0 {
            config.webcam_fps
        } else {
            config.fps
        };
        match WebcamCapture::initialize(
            &config.webcam_device_id,
            &config.webcam_device_name,
            &config.webcam_direct_show_clsid,
            config.webcam_width,
            config.webcam_height,
            requested_fps,
        ) {
            Some(capture) => {
                let _ = WRITER.write_line(&events::webcam_format_line(
                    capture.width(),
                    capture.height(),
                    capture.fps(),
                    capture.selected_device_name(),
                ));
                webcam = Some(capture);
            }
            None => {
                eprintln!("ERROR: Failed to initialize native webcam capture");
                std::process::exit(1);
            }
        }
    }

    // Audio endpoint init + format events, before encoder init (main.cpp
    // ordering). Degradation asymmetry: loopback failure emits
    // system-audio-unavailable and continues; microphone failure is fatal.
    let mut capture_system_audio = config.capture_system_audio;
    let mut loopback: Option<WasapiCapture> = None;
    let mut microphone: Option<WasapiCapture> = None;
    let mut system_format: Option<AudioFormat> = None;
    let mut microphone_format: Option<AudioFormat> = None;
    let mut audio_format: Option<AudioFormat> = None;

    if config.capture_system_audio {
        let (mut capture, ok) = WasapiCapture::new_system_loopback();
        if !ok {
            eprintln!("ERROR: Failed to initialize WASAPI loopback capture");
            let _ = WRITER.write_line(&events::system_audio_unavailable_line(
                capture.last_failure_reason(),
            ));
            capture_system_audio = false;
        } else if !capture.verify_startable() {
            eprintln!("ERROR: Failed to start WASAPI loopback capture probe");
            let _ = WRITER.write_line(&events::system_audio_unavailable_line(
                capture.last_failure_reason(),
            ));
            capture_system_audio = false;
        }
        if capture_system_audio {
            system_format = capture.input_format();
            audio_format = system_format;
            loopback = Some(capture);
        }
    }
    if config.capture_mic {
        let (capture, ok) = WasapiCapture::new_microphone(
            Some(&config.microphone_device_id),
            Some(&config.microphone_device_name),
        );
        if !ok {
            eprintln!("ERROR: Failed to initialize WASAPI microphone capture");
            std::process::exit(1);
        }
        microphone_format = capture.input_format();
        if audio_format.is_none() {
            audio_format = microphone_format;
        }
        microphone = Some(capture);
    }

    let encoder_audio_format = audio_format.map(|f| audio::format::make_aac_compatible(&f));
    if let Some(format) = audio_format {
        let mic_name = if config.capture_mic {
            microphone
                .as_ref()
                .map(|m| m.selected_device_name().to_string())
        } else {
            None
        };
        let _ = WRITER.write_line(&events::audio_format_line(
            format.sample_rate,
            format.channels,
            format.bits_per_sample,
            capture_system_audio,
            config.capture_mic,
            mic_name.as_deref(),
        ));
        let enc = encoder_audio_format.as_ref().unwrap();
        let _ = WRITER.write_line(&events::encoder_audio_format_line(
            enc.sample_rate,
            enc.channels,
            enc.bits_per_sample,
        ));
    }

    let encoder = match MfEncoder::initialize(
        &config.output_path,
        width,
        height,
        config.fps,
        bitrate,
        &device,
        &context,
        encoder_audio_format.as_ref(),
    ) {
        Some(e) => Arc::new(e),
        None => {
            eprintln!("ERROR: Failed to initialize Media Foundation encoder");
            std::process::exit(1);
        }
    };

    // Separate webcam encoder (main.cpp:544-560): webcam-sized, bitrate
    // 8M at >=720p else 4M, no audio stream.
    let webcam_encoder: Option<Arc<MfEncoder>> = if write_separate {
        let cam = webcam.as_ref().expect("webcam initialized above");
        let pixels = cam.width().max(1) * cam.height().max(1);
        let webcam_bitrate = if pixels >= 1280 * 720 {
            8_000_000
        } else {
            4_000_000
        };
        match MfEncoder::initialize(
            &config.webcam_path,
            cam.width(),
            cam.height(),
            cam.fps(),
            webcam_bitrate,
            &device,
            &context,
            None,
        ) {
            Some(e) => Some(Arc::new(e)),
            None => {
                eprintln!("ERROR: Failed to initialize native webcam encoder");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    let control = Arc::new(Control::new());

    // Frame callback: runs on WGC's free-threaded pool threads under the
    // session's callback barrier. The stop/paused early-return must stay
    // ABOVE the slot lock (LOAD-BEARING for shutdown, main.cpp:585-590).
    {
        let control = Arc::clone(&control);
        let gpu = CallbackGpu {
            device: device.clone(),
            context: context.clone(),
        };
        session.set_frame_callback(Box::new(move |texture, timestamp_hns| {
            if control.stop.load(Ordering::SeqCst) || control.paused.load(Ordering::SeqCst) {
                return;
            }
            let mut slot = control.slot.lock().unwrap_or_else(|p| p.into_inner());
            if slot.texture.is_none() {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                // SAFETY: reading the incoming texture's description and
                // creating the reusable copy target from it.
                unsafe {
                    texture.GetDesc(&mut desc);
                    desc.BindFlags = 0;
                    desc.CPUAccessFlags = 0;
                    desc.MiscFlags = 0;
                    let mut copy: Option<ID3D11Texture2D> = None;
                    if gpu
                        .device
                        .CreateTexture2D(&desc, None, Some(&mut copy))
                        .is_err()
                        || copy.is_none()
                    {
                        control.fail_encode();
                        return;
                    }
                    slot.texture = copy;
                }
            }
            // SAFETY: GPU-side copy between same-description textures, under
            // the slot mutex that also serializes the writer's context use.
            unsafe {
                gpu.context
                    .CopyResource(slot.texture.as_ref().unwrap(), texture);
            }
            slot.timestamp_hns = timestamp_hns;
            if !control.first_frame_written.swap(true, Ordering::SeqCst) {
                control.cv.notify_all();
            }
        }));
    }

    // startAudioCaptures port (main.cpp:743-811): mixer first, then mic
    // (fatal on failure), then loopback (degrades on failure).
    let audio_mixer: Option<Arc<AudioMixer>> = if let Some(enc_format) = encoder_audio_format {
        let mixer_output: audio::mixer::OutputCallback = {
            let control = Arc::clone(&control);
            let encoder = Arc::clone(&encoder);
            Box::new(move |data, timestamp_hns, duration_hns| {
                if !encoder.write_audio(data, timestamp_hns, duration_hns) {
                    control.fail_encode();
                    return false;
                }
                true
            })
        };
        let mixer = Arc::new(AudioMixer::new(
            enc_format,
            if capture_system_audio {
                system_format.unwrap()
            } else {
                enc_format
            },
            if config.capture_mic {
                microphone_format.unwrap()
            } else {
                enc_format
            },
            capture_system_audio,
            config.capture_mic,
            config.microphone_gain,
            mixer_output,
        ));
        if !mixer.start() {
            eprintln!("ERROR: Failed to start native audio mixer");
            std::process::exit(1);
        }

        if config.capture_mic {
            let callback: audio::wasapi::AudioCallback = {
                let control = Arc::clone(&control);
                let mixer = Arc::clone(&mixer);
                Box::new(move |data, _ts, _dur| {
                    if control.stop.load(Ordering::SeqCst) {
                        return;
                    }
                    mixer.push_microphone(data);
                })
            };
            if !microphone
                .as_mut()
                .expect("mic initialized above")
                .start(callback)
            {
                eprintln!("ERROR: Failed to start WASAPI microphone capture");
                mixer.stop();
                std::process::exit(1);
            }
        }

        if capture_system_audio {
            let callback: audio::wasapi::AudioCallback = {
                let control = Arc::clone(&control);
                let mixer = Arc::clone(&mixer);
                Box::new(move |data, _ts, _dur| {
                    if control.stop.load(Ordering::SeqCst) {
                        return;
                    }
                    mixer.push_system(data);
                })
            };
            let capture = loopback.as_mut().expect("loopback initialized above");
            if !capture.start(callback) {
                eprintln!("ERROR: Failed to start WASAPI loopback capture");
                let _ = WRITER.write_line(&events::system_audio_unavailable_line(
                    capture.last_failure_reason(),
                ));
                if !config.capture_mic {
                    // No audio source remains: stop the mixer; the AAC stream
                    // simply receives no samples (main.cpp:797-803).
                    mixer.stop();
                }
            }
        }

        Some(mixer)
    } else {
        None
    };

    // Webcam start + 3s visible-frame warmup, after audio start and before
    // session.start (main.cpp:812-841). The adopted snapshot seeds the
    // writer thread's webcam state.
    let mut warmup = WebcamFrameSnapshot::default();
    let mut warmup_visible = false;
    if let Some(cam) = webcam.as_mut() {
        if !cam.start() {
            if let Some(capture) = microphone.as_mut() {
                capture.stop();
            }
            if let Some(capture) = loopback.as_mut() {
                capture.stop();
            }
            if let Some(mixer) = &audio_mixer {
                mixer.stop();
            }
            eprintln!("ERROR: Failed to start native webcam capture");
            std::process::exit(1);
        }
        let store = cam.frame_store();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut candidate = WebcamFrameSnapshot::default();
        while std::time::Instant::now() < deadline {
            if store.copy_latest(&mut candidate) && has_visible_bgra_content(&candidate.data) {
                warmup = candidate;
                warmup_visible = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !warmup_visible {
            eprintln!(
                "WARNING: Native webcam started but no visible frame was available before screen capture"
            );
        }
    }

    if !session.start() {
        // Stop the captures before exiting, matching main.cpp:843-852
        // (webcam first, then audio).
        if let Some(cam) = webcam.as_mut() {
            cam.stop();
        }
        if let Some(capture) = microphone.as_mut() {
            capture.stop();
        }
        if let Some(capture) = loopback.as_mut() {
            capture.stop();
        }
        if let Some(mixer) = &audio_mixer {
            mixer.stop();
        }
        eprintln!("ERROR: Failed to start WGC session");
        std::process::exit(1);
    }

    // stdin command thread. Detached on exit paths like the C++ (dropping the
    // JoinHandle detaches). Pause/resume reach the mixer BEFORE the event
    // echo (the C++ onPauseChanged hook).
    let stdin_thread = {
        let control = Arc::clone(&control);
        let mixer = audio_mixer.clone();
        std::thread::spawn(move || stdin_command_loop(control, mixer))
    };

    // First-frame gate: 10s. An early stop (stdin `stop`/EOF) before the
    // first frame takes this SAME error path and exit code — not a clean stop
    // (main.cpp:860-886).
    {
        let slot = control.slot.lock().unwrap_or_else(|p| p.into_inner());
        let (slot, _timeout) = control
            .cv
            .wait_timeout_while(slot, Duration::from_secs(10), |_| {
                !control.first_frame_written.load(Ordering::SeqCst)
                    && !control.stop.load(Ordering::SeqCst)
            })
            .unwrap_or_else(|p| p.into_inner());
        if !control.first_frame_written.load(Ordering::SeqCst) {
            control.request_stop();
            // Release the slot mutex BEFORE session.stop(): its teardown
            // barrier takes the callback mutex while an in-flight callback may
            // be waiting on the slot mutex — holding it here could deadlock
            // (WGC shutdown race, main.cpp:866-872).
            drop(slot);
            drop(stdin_thread);
            if let Some(capture) = microphone.as_mut() {
                capture.stop();
            }
            if let Some(capture) = loopback.as_mut() {
                capture.stop();
            }
            if let Some(cam) = webcam.as_mut() {
                cam.stop();
            }
            if let Some(mixer) = &audio_mixer {
                mixer.stop();
            }
            session.stop();
            eprintln!("ERROR: Timed out waiting for first WGC frame");
            std::process::exit(1);
        }
    }

    if let Some(mixer) = &audio_mixer {
        mixer.begin_timeline();
    }

    let done_pair = Arc::new((Mutex::new(false), Condvar::new()));
    let writer_thread = {
        let control = Arc::clone(&control);
        let encoder = Arc::clone(&encoder);
        let done_pair = Arc::clone(&done_pair);
        let fps = config.fps;
        let webcam_writer = webcam.as_ref().map(|cam| WebcamWriter {
            store: cam.frame_store(),
            frame: warmup.data,
            width: warmup.width,
            height: warmup.height,
            sequence: warmup.sequence,
            has_visible: warmup_visible,
            separate: webcam_encoder.as_ref().map(|enc| SeparateWebcamWriter {
                encoder: Arc::clone(enc),
                fps: cam.fps(),
                last_written_sequence: 0,
                output_frame_index: 0,
            }),
        });
        std::thread::spawn(move || {
            write_video_frames(control, encoder, fps, webcam_writer, done_pair)
        })
    };

    let _ = WRITER.write_line(events::recording_started_line());
    let _ = WRITER.write_line(events::LEGACY_STARTED_LINE);

    // Wait for stop WITHOUT touching the slot mutex: the writer holds it
    // across write_frame, and a wedged write_frame (issue #14) would deadlock
    // shutdown before the bounded wait below could detach the thread.
    while !control.stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(20));
    }

    // Bounded writer shutdown (stopVideoWriter port): 5s on the done signal,
    // else the writer is wedged inside a blocking encoder call.
    let wedged = {
        let (done, cv) = &*done_pair;
        let guard = done.lock().unwrap_or_else(|p| p.into_inner());
        let (guard, timeout) = cv
            .wait_timeout_while(guard, Duration::from_secs(5), |done| !*done)
            .unwrap_or_else(|p| p.into_inner());
        drop(guard);
        if timeout.timed_out() {
            true // detach: dropping the JoinHandle below never joins it
        } else {
            let _ = writer_thread.join();
            false
        }
    };

    if wedged {
        // Force-exit without touching finalize()/session.stop() OR any audio
        // stop: mixer.stop() joins a thread calling write_audio on the same
        // writer mutex the wedged write_frame holds forever (issue #14 —
        // the wedge check MUST run before the audio stops below).
        eprintln!("ERROR: video writer wedged during shutdown; forcing exit");
        let _ = WRITER.write_line(events::recording_failed_wedged_line());
        let _ = std::io::stdout().flush();
        let _ = std::io::stderr().flush();
        std::process::exit(1);
    }

    if let Some(capture) = microphone.as_mut() {
        capture.stop();
    }
    if let Some(capture) = loopback.as_mut() {
        capture.stop();
    }
    if let Some(cam) = webcam.as_mut() {
        cam.stop();
    }
    if let Some(mixer) = &audio_mixer {
        mixer.stop();
    }
    session.stop();
    {
        let _slot = control.slot.lock().unwrap_or_else(|p| p.into_inner());
        encoder.finalize();
        if let Some(webcam_encoder) = &webcam_encoder {
            webcam_encoder.finalize();
        }
    }

    drop(stdin_thread);

    if control.encode_failed.load(Ordering::SeqCst) {
        eprintln!("ERROR: Failed to encode WGC frame");
        std::process::exit(1);
    }

    let webcam_path = write_separate.then_some(config.webcam_path.as_str());
    let _ = WRITER.write_line(&events::recording_stopped_line(
        &config.output_path,
        webcam_path,
    ));
    let _ = WRITER.write_line(&events::legacy_stopped_line(&config.output_path));
}
