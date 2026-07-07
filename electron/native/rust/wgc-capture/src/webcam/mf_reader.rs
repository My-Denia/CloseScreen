//! Media Foundation webcam path — port of the MF half of WebcamCapture
//! (webcam_capture.cpp): MFEnumDeviceSources + fuzzy device scoring +
//! IMFSourceReader configured to RGB32, with a synchronous ReadSample
//! capture thread publishing into the shared FrameStore.

use std::sync::Arc;

use closescreen_native_protocol::device_match::score_webcam_device;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFMediaSource, IMFSourceReader, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_READWRITE_DISABLE_CONVERTERS, MF_SOURCE_READER_ALL_STREAMS,
    MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_VERSION, MFCreateAttributes, MFCreateMediaType,
    MFCreateSourceReaderFromMediaSource, MFEnumDeviceSources, MFMediaType_Video, MFSTARTUP_FULL,
    MFShutdown, MFStartup, MFVideoFormat_RGB32,
};
use windows::Win32::System::Com::CoTaskMemFree;

use super::FrameStore;
use crate::eprint_hr;

fn pack_u64(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// Outcome of the MF init attempt, mirroring the initialize() legs
/// (webcam_capture.cpp:148-188).
pub enum MfInit {
    Ready(MfWebcam),
    /// MFStartup failed, no devices / enumeration failed, or a requested
    /// device scored 0 — the caller tries DirectShow. `requested_missing`
    /// is true only for the scored-0 leg, whose DShow failure gets the
    /// extra "not found by native Windows webcam providers" error.
    TryDirectShow {
        requested_missing: bool,
    },
    /// Reader configuration failed — fatal, NO DirectShow fallback
    /// (webcam_capture.cpp:187 returns configureReader() directly).
    Failed,
}

pub struct MfWebcam {
    media_source: Option<IMFMediaSource>,
    source_reader: Option<IMFSourceReader>,
    thread: Option<std::thread::JoinHandle<()>>,
    store: Arc<FrameStore>,
    width: i32,
    height: i32,
    fps: i32,
    mf_started: bool,
    selected_device_name: String,
}

/// Single-owner handoff of the source reader into the capture thread.
struct SendReader(IMFSourceReader);
// SAFETY: the reader is created on the main thread but used EXCLUSIVELY by
// the capture thread after start(); stop() joins that thread before touching
// any MF object. The process is MTA everywhere, matching the C++ which calls
// ReadSample from its capture thread the same way.
unsafe impl Send for SendReader {}

/// readAllocatedString port: empty string when the attribute is missing.
fn read_allocated_string(activate: &IMFActivate, key: &windows::core::GUID) -> String {
    let mut value = windows::core::PWSTR::null();
    let mut length = 0u32;
    // SAFETY: documented GetAllocatedString contract; the buffer is copied
    // out and freed with CoTaskMemFree exactly like the C++.
    unsafe {
        if activate
            .GetAllocatedString(key, &mut value, &mut length)
            .is_err()
            || value.is_null()
        {
            return String::new();
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(value.0, length as usize));
        CoTaskMemFree(Some(value.0 as *const core::ffi::c_void));
        result
    }
}

impl MfWebcam {
    pub fn initialize(
        device_id: &str,
        device_name: &str,
        requested_width: i32,
        requested_height: i32,
        fps: i32,
        store: Arc<FrameStore>,
    ) -> MfInit {
        // SAFETY: MF startup; paired with MFShutdown on every failure leg
        // and in stop().
        if let Err(e) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) } {
            eprint_hr("MFStartup(webcam)", e.code());
            return MfInit::TryDirectShow {
                requested_missing: false,
            };
        }

        let shutdown_mf = || {
            // SAFETY: paired with the successful MFStartup above.
            let _ = unsafe { MFShutdown() };
        };

        let Some((media_source, best_score, selected_device_name)) =
            Self::select_device(device_id, device_name)
        else {
            shutdown_mf();
            return MfInit::TryDirectShow {
                requested_missing: false,
            };
        };

        if (!device_id.is_empty() || !device_name.is_empty()) && best_score <= 0 {
            // SAFETY: releasing the activated-but-unwanted source before the
            // DirectShow attempt (webcam_capture.cpp:168-177).
            unsafe {
                let _ = media_source.Shutdown();
            }
            drop(media_source);
            shutdown_mf();
            return MfInit::TryDirectShow {
                requested_missing: true,
            };
        }

        let Some((source_reader, width, height)) =
            Self::configure_reader(&media_source, requested_width, requested_height, fps)
        else {
            // Fatal: the C++ returns configureReader() with no DShow
            // fallback; tear the MF objects down before exiting.
            // SAFETY: source shutdown + MFShutdown pairing.
            unsafe {
                let _ = media_source.Shutdown();
            }
            drop(media_source);
            shutdown_mf();
            return MfInit::Failed;
        };

        MfInit::Ready(Self {
            media_source: Some(media_source),
            source_reader: Some(source_reader),
            thread: None,
            store,
            width,
            height,
            fps,
            mf_started: true,
            selected_device_name,
        })
    }

    /// selectDevice port (webcam_capture.cpp:190-241). Returns the activated
    /// source, the best score, and the selected friendly name.
    fn select_device(device_id: &str, device_name: &str) -> Option<(IMFMediaSource, i32, String)> {
        // SAFETY: attribute construction + device enumeration with the exact
        // C++ labels; the returned activate array is drained into owned
        // wrappers and freed with CoTaskMemFree.
        unsafe {
            let mut attributes = None;
            if let Err(e) = MFCreateAttributes(&mut attributes, 1) {
                eprint_hr("MFCreateAttributes(webcam enumeration)", e.code());
                return None;
            }
            let attributes = attributes.expect("MFCreateAttributes succeeded");
            if let Err(e) = attributes.SetGUID(
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
            ) {
                eprint_hr("SetGUID(webcam source type)", e.code());
                return None;
            }

            let mut devices: *mut Option<IMFActivate> = std::ptr::null_mut();
            let mut device_count = 0u32;
            let enum_result = MFEnumDeviceSources(&attributes, &mut devices, &mut device_count);
            if let Err(e) = &enum_result {
                eprint_hr("MFEnumDeviceSources", e.code());
            }
            if enum_result.is_err() || device_count == 0 {
                if !devices.is_null() {
                    CoTaskMemFree(Some(devices as *const core::ffi::c_void));
                }
                eprintln!("ERROR: No native Windows webcam devices were found");
                return None;
            }

            let activates: Vec<Option<IMFActivate>> = (0..device_count as usize)
                .map(|index| devices.add(index).read())
                .collect();
            CoTaskMemFree(Some(devices as *const core::ffi::c_void));

            let mut selected_index = 0usize;
            let mut best_score = 0i32;
            let mut names: Vec<String> = Vec::with_capacity(activates.len());
            for (index, activate) in activates.iter().enumerate() {
                let (name, symbolic_link) = match activate {
                    Some(activate) => (
                        read_allocated_string(activate, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME),
                        read_allocated_string(
                            activate,
                            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                        ),
                    ),
                    None => (String::new(), String::new()),
                };
                let score = score_webcam_device(&name, &symbolic_link, device_name, device_id);
                eprintln!("INFO: Native webcam candidate [{index}] name=\"{name}\" score={score}");
                if score > best_score {
                    selected_index = index;
                    best_score = score;
                }
                names.push(name);
            }

            if (!device_id.is_empty() || !device_name.is_empty()) && best_score <= 0 {
                eprintln!(
                    "WARNING: Requested webcam device was not found by Media Foundation; trying DirectShow"
                );
            }

            let selected_name = names[selected_index].clone();
            let media_source = match activates[selected_index]
                .as_ref()
                .map(|activate| activate.ActivateObject::<IMFMediaSource>())
            {
                Some(Ok(source)) => source,
                Some(Err(e)) => {
                    eprint_hr("ActivateObject(webcam)", e.code());
                    return None;
                }
                None => {
                    eprint_hr("ActivateObject(webcam)", windows::core::HRESULT(-1));
                    return None;
                }
            };

            Some((media_source, best_score, selected_name))
        }
    }

    /// configureReader port (webcam_capture.cpp:243-289). Returns the reader
    /// and the ACTUAL negotiated size.
    fn configure_reader(
        media_source: &IMFMediaSource,
        requested_width: i32,
        requested_height: i32,
        requested_fps: i32,
    ) -> Option<(IMFSourceReader, i32, i32)> {
        // SAFETY: reader attribute + media type negotiation identical to the
        // C++ (labels included); Set* results are deliberately ignored where
        // the C++ ignores them.
        unsafe {
            let mut attributes = None;
            if let Err(e) = MFCreateAttributes(&mut attributes, 2) {
                eprint_hr("MFCreateAttributes(webcam reader)", e.code());
                return None;
            }
            let attributes = attributes.expect("MFCreateAttributes succeeded");
            let _ = attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1);
            let _ = attributes.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 0);

            let source_reader = match MFCreateSourceReaderFromMediaSource(media_source, &attributes)
            {
                Ok(reader) => reader,
                Err(e) => {
                    eprint_hr("MFCreateSourceReaderFromMediaSource(webcam)", e.code());
                    return None;
                }
            };

            let media_type = match MFCreateMediaType() {
                Ok(t) => t,
                Err(e) => {
                    eprint_hr("MFCreateMediaType(webcam output)", e.code());
                    return None;
                }
            };
            let _ = media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video);
            let _ = media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32);
            if requested_width > 0 && requested_height > 0 {
                let _ = media_type.SetUINT64(
                    &MF_MT_FRAME_SIZE,
                    pack_u64(requested_width as u32, requested_height as u32),
                );
            }
            let _ =
                media_type.SetUINT64(&MF_MT_FRAME_RATE, pack_u64(requested_fps.max(1) as u32, 1));

            if let Err(e) = source_reader.SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                None,
                &media_type,
            ) {
                eprint_hr("SetCurrentMediaType(webcam RGB32)", e.code());
                return None;
            }
            let _ = source_reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
            let _ = source_reader
                .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true);

            let current_type = match source_reader
                .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
            {
                Ok(t) => t,
                Err(e) => {
                    eprint_hr("GetCurrentMediaType(webcam)", e.code());
                    return None;
                }
            };

            let (mut width, mut height) = match current_type.GetUINT64(&MF_MT_FRAME_SIZE) {
                Ok(packed) => ((packed >> 32) as u32, (packed & 0xFFFF_FFFF) as u32),
                Err(_) => (0, 0),
            };
            if width == 0 || height == 0 {
                width = if requested_width > 0 {
                    requested_width as u32
                } else {
                    1280
                };
                height = if requested_height > 0 {
                    requested_height as u32
                } else {
                    720
                };
            }

            Some((source_reader, width as i32, height as i32))
        }
    }

    pub fn start(&mut self) -> bool {
        let Some(reader) = self.source_reader.take() else {
            return false;
        };
        if self.thread.is_some() {
            return false;
        }

        let reader = SendReader(reader);
        let store = Arc::clone(&self.store);
        let width = self.width;
        let height = self.height;
        self.thread = Some(std::thread::spawn(move || {
            capture_loop(reader, store, width, height);
        }));
        true
    }

    pub fn stop(&mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Some(source) = self.media_source.take() {
            // SAFETY: capture thread joined above — sole remaining owner.
            unsafe {
                let _ = source.Shutdown();
            }
        }
        self.source_reader = None;
        if self.mf_started {
            // SAFETY: paired with the MFStartup in initialize().
            let _ = unsafe { MFShutdown() };
            self.mf_started = false;
        }
    }

    pub fn width(&self) -> i32 {
        self.width
    }
    pub fn height(&self) -> i32 {
        self.height
    }
    pub fn fps(&self) -> i32 {
        self.fps
    }
    pub fn selected_device_name(&self) -> &str {
        &self.selected_device_name
    }
}

impl Drop for MfWebcam {
    fn drop(&mut self) {
        self.stop();
    }
}

/// captureLoop port (webcam_capture.cpp:321-375): synchronous ReadSample,
/// latest-frame slot, 20ms backoff on read errors.
fn capture_loop(reader: SendReader, store: Arc<FrameStore>, width: i32, height: i32) {
    let reader = reader;
    let expected_length = (width.max(0) as usize) * (height.max(0) as usize) * 4;

    while !store.stop_requested() {
        let mut stream_index = 0u32;
        let mut flags = 0u32;
        let mut timestamp = 0i64;
        let mut sample = None;
        // SAFETY: synchronous ReadSample with out-params, identical to the
        // C++ loop; the sample/buffer are used only within this iteration.
        unsafe {
            if let Err(e) = reader.0.ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                0,
                Some(&mut stream_index),
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            ) {
                eprintln!(
                    "WARNING: Failed to read webcam sample (hr=0x{:x})",
                    e.code().0 as u32
                );
                std::thread::sleep(std::time::Duration::from_millis(20));
                continue;
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
            let Some(sample) = sample else {
                continue;
            };

            let Ok(buffer) = sample.ConvertToContiguousBuffer() else {
                continue;
            };
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut max_length = 0u32;
            let mut current_length = 0u32;
            if buffer
                .Lock(&mut data, Some(&mut max_length), Some(&mut current_length))
                .is_err()
                || data.is_null()
            {
                continue;
            }
            if current_length as usize >= expected_length && expected_length > 0 {
                let frame = std::slice::from_raw_parts(data, expected_length).to_vec();
                store.store(frame, width, height);
            }
            let _ = buffer.Unlock();
        }
    }
}
