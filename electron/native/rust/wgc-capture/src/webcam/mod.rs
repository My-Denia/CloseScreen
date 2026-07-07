//! Native webcam capture — port of WebcamCapture (webcam_capture.cpp):
//! Media Foundation source reader first, DirectShow SampleGrabber fallback
//! for devices MF can't see (virtual cameras). The capture thread publishes
//! the latest frame into a shared FrameStore that the video writer thread
//! polls; COM objects never cross into the writer.

pub mod convert;
mod dshow;
mod mf_reader;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// One copied-out frame (the C++ WebcamFrameSnapshot).
#[derive(Default)]
pub struct WebcamFrameSnapshot {
    pub data: Vec<u8>,
    pub width: i32,
    pub height: i32,
    pub sequence: u64,
}

struct StoredFrame {
    data: Vec<u8>,
    width: i32,
    height: i32,
    sequence: u64,
}

/// Latest-frame slot shared between the capture thread (writer) and the
/// warmup/video-writer consumers — the same latestFrame_+sequence pattern
/// both C++ capture classes use.
pub struct FrameStore {
    frame: Mutex<StoredFrame>,
    stop_requested: AtomicBool,
}

impl FrameStore {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            frame: Mutex::new(StoredFrame {
                data: Vec::new(),
                width: 0,
                height: 0,
                sequence: 0,
            }),
            stop_requested: AtomicBool::new(false),
        })
    }

    fn store(&self, data: Vec<u8>, width: i32, height: i32) {
        let mut frame = self.frame.lock().unwrap_or_else(|p| p.into_inner());
        frame.data = data;
        frame.width = width;
        frame.height = height;
        frame.sequence += 1;
    }

    fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }

    /// copyLatestFrame port: false while no frame has been stored.
    pub fn copy_latest(&self, destination: &mut WebcamFrameSnapshot) -> bool {
        let frame = self.frame.lock().unwrap_or_else(|p| p.into_inner());
        if frame.data.is_empty() || frame.width <= 0 || frame.height <= 0 {
            return false;
        }
        destination.data.clear();
        destination.data.extend_from_slice(&frame.data);
        destination.width = frame.width;
        destination.height = frame.height;
        destination.sequence = frame.sequence;
        true
    }
}

enum Backend {
    MediaFoundation(mf_reader::MfWebcam),
    DirectShow(dshow::DShowWebcam),
}

pub struct WebcamCapture {
    backend: Backend,
    store: Arc<FrameStore>,
}

impl WebcamCapture {
    /// WebcamCapture::initialize (webcam_capture.cpp:138-188): MF first;
    /// every MF failure leg falls through to the DirectShow fallback; a
    /// requested device that MF enumerated but scored 0 also falls through
    /// (with the MF objects torn down first). Returns None only when BOTH
    /// providers fail; main emits the webcam-format event on success.
    pub fn initialize(
        device_id: &str,
        device_name: &str,
        direct_show_clsid: &str,
        requested_width: i32,
        requested_height: i32,
        requested_fps: i32,
    ) -> Option<Self> {
        let fps = if requested_fps > 0 { requested_fps } else { 30 }.clamp(1, 60);
        let store = FrameStore::new();

        let try_dshow = |store: &Arc<FrameStore>| {
            dshow::DShowWebcam::initialize(
                device_name,
                direct_show_clsid,
                requested_width,
                requested_height,
                fps,
                Arc::clone(store),
            )
        };

        match mf_reader::MfWebcam::initialize(
            device_id,
            device_name,
            requested_width,
            requested_height,
            fps,
            Arc::clone(&store),
        ) {
            mf_reader::MfInit::Ready(mf) => Some(Self {
                backend: Backend::MediaFoundation(mf),
                store,
            }),
            mf_reader::MfInit::TryDirectShow { requested_missing } => {
                if let Some(ds) = try_dshow(&store) {
                    return Some(Self {
                        backend: Backend::DirectShow(ds),
                        store,
                    });
                }
                if requested_missing {
                    eprintln!(
                        "ERROR: Requested webcam device was not found by native Windows webcam providers"
                    );
                }
                None
            }
            mf_reader::MfInit::Failed => None,
        }
    }

    pub fn start(&mut self) -> bool {
        match &mut self.backend {
            Backend::MediaFoundation(mf) => mf.start(),
            Backend::DirectShow(ds) => ds.start(),
        }
    }

    pub fn stop(&mut self) {
        self.store.stop_requested.store(true, Ordering::SeqCst);
        match &mut self.backend {
            Backend::MediaFoundation(mf) => mf.stop(),
            Backend::DirectShow(ds) => ds.stop(),
        }
    }

    pub fn frame_store(&self) -> Arc<FrameStore> {
        Arc::clone(&self.store)
    }

    pub fn width(&self) -> i32 {
        match &self.backend {
            Backend::MediaFoundation(mf) => mf.width(),
            Backend::DirectShow(ds) => ds.width(),
        }
    }

    pub fn height(&self) -> i32 {
        match &self.backend {
            Backend::MediaFoundation(mf) => mf.height(),
            Backend::DirectShow(ds) => ds.height(),
        }
    }

    pub fn fps(&self) -> i32 {
        match &self.backend {
            Backend::MediaFoundation(mf) => mf.fps(),
            Backend::DirectShow(ds) => ds.fps(),
        }
    }

    pub fn selected_device_name(&self) -> &str {
        match &self.backend {
            Backend::MediaFoundation(mf) => mf.selected_device_name(),
            Backend::DirectShow(ds) => ds.selected_device_name(),
        }
    }
}

impl Drop for WebcamCapture {
    fn drop(&mut self) {
        self.stop();
    }
}
