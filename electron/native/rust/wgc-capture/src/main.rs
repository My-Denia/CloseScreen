//! wgc-capture — protocol-compatible Rust port of the C++ helper's VIDEO
//! path (electron/native/wgc-capture/src/main.cpp). Audio and webcam capture
//! land in later rounds; configs requesting them exit 1 after `ready`.
//!
//! Invocation: wgc-capture.exe '<json-config>'. Commands on stdin
//! (pause/resume/stop), newline-delimited JSON events + legacy text lines on
//! stdout. See electron/native/README.md for the contract.

mod config;
mod encoder;
mod events;
mod monitor;
mod timing;
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

use crate::config::{
    CaptureConfig, bitrate_for, even_dimension, parse_config, parse_window_handle,
};
use crate::encoder::MfEncoder;
use crate::timing::{PauseTracker, WriterTiming};
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
/// EOF requests stop, matching the C++.
fn stdin_command_loop(control: Arc<Control>) {
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
                let _ = WRITER.write_line(events::recording_paused_line());
                control.cv.notify_all();
            }
            "resume" => {
                control.set_paused(false);
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

/// The paced video writer loop (writeVideoFrames port, video-only). Holds the
/// frame-slot mutex ACROSS encoder.write_frame — that is the issue-#14 wedge
/// surface, and the frame callback's early-return protects the WGC teardown
/// barrier from it.
fn write_video_frames(
    control: Arc<Control>,
    encoder: Arc<MfEncoder>,
    fps: i32,
    done_pair: Arc<(Mutex<bool>, Condvar)>,
) {
    let _done = DoneSignal { pair: done_pair };
    let frame_duration = Duration::from_secs_f64(1.0 / f64::from(fps.max(1)));
    let mut timing = WriterTiming::new(fps);

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

            let ts = timing.frame_timestamp(slot.timestamp_hns, control.paused_duration_hns());
            let texture = slot.texture.as_ref().expect("predicate guarantees texture");
            if !encoder.write_frame(texture, ts) {
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

    // PR2 boundary: the Rust helper is opt-in (CLOSESCREEN_WGC_CAPTURE_EXE)
    // and only covers the video path so far. Refuse loudly rather than
    // recording something different from what was asked.
    if config.capture_system_audio || config.capture_mic || config.webcam_enabled {
        eprintln!("ERROR: Audio and webcam capture are not implemented in the Rust helper yet");
        std::process::exit(1);
    }

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

    let encoder = match MfEncoder::initialize(
        &config.output_path,
        width,
        height,
        config.fps,
        bitrate,
        &device,
        &context,
    ) {
        Some(e) => Arc::new(e),
        None => {
            eprintln!("ERROR: Failed to initialize Media Foundation encoder");
            std::process::exit(1);
        }
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

    if !session.start() {
        eprintln!("ERROR: Failed to start WGC session");
        std::process::exit(1);
    }

    // stdin command thread. Detached on exit paths like the C++ (dropping the
    // JoinHandle detaches).
    let stdin_thread = {
        let control = Arc::clone(&control);
        std::thread::spawn(move || stdin_command_loop(control))
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
            session.stop();
            eprintln!("ERROR: Timed out waiting for first WGC frame");
            std::process::exit(1);
        }
    }

    let done_pair = Arc::new((Mutex::new(false), Condvar::new()));
    let writer_thread = {
        let control = Arc::clone(&control);
        let encoder = Arc::clone(&encoder);
        let done_pair = Arc::clone(&done_pair);
        let fps = config.fps;
        std::thread::spawn(move || write_video_frames(control, encoder, fps, done_pair))
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
        // Force-exit without touching finalize()/session.stop(): both need
        // locks or a device the wedged thread still holds. The mp4 is left
        // non-finalized — a wedged recording is already lost (issue #14).
        eprintln!("ERROR: video writer wedged during shutdown; forcing exit");
        let _ = WRITER.write_line(events::recording_failed_wedged_line());
        let _ = std::io::stdout().flush();
        let _ = std::io::stderr().flush();
        std::process::exit(1);
    }

    session.stop();
    {
        let _slot = control.slot.lock().unwrap_or_else(|p| p.into_inner());
        encoder.finalize();
    }

    drop(stdin_thread);

    if control.encode_failed.load(Ordering::SeqCst) {
        eprintln!("ERROR: Failed to encode WGC frame");
        std::process::exit(1);
    }

    let _ = WRITER.write_line(&events::recording_stopped_line(&config.output_path, None));
    let _ = WRITER.write_line(&events::legacy_stopped_line(&config.output_path));
}
