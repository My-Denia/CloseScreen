//! DirectShow SampleGrabber webcam fallback — port of
//! DirectShowWebcamCapture (dshow_webcam_capture.cpp). Used for devices
//! Media Foundation can't enumerate (typically virtual cameras). The
//! ISampleGrabber interface and the SampleGrabber/NullRenderer CLSIDs come
//! from qedit.h, which is absent from the win32 metadata — declared locally
//! exactly like the C++ does.

use std::sync::Arc;

use windows::Win32::Media::DirectShow::{
    IBaseFilter, ICaptureGraphBuilder2, IGraphBuilder, IMediaControl,
};
use windows::Win32::Media::MediaFoundation::{
    AM_MEDIA_TYPE, CLSID_CaptureGraphBuilder2, CLSID_FilterGraph, FORMAT_VideoInfo,
    MEDIASUBTYPE_NV12, MEDIASUBTYPE_RGB32, MEDIASUBTYPE_YUY2, MEDIATYPE_Video,
    PIN_CATEGORY_CAPTURE, VIDEOINFOHEADER,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CLSIDFromString, CoCreateInstance, CoTaskMemFree,
};
use windows::core::{BOOL, GUID, IUnknown, Interface as _, w};

use super::FrameStore;
use super::convert::{PixelFormat, convert_frame};
use crate::eprint_hr;

// qedit.h CLSIDs, declared locally like the C++
// (dshow_webcam_capture.cpp:17-18).
const CLSID_SAMPLE_GRABBER: GUID = GUID::from_u128(0xc1f400a0_3f08_11d3_9f0b_006008039e37);
const CLSID_NULL_RENDERER: GUID = GUID::from_u128(0xc1f400a4_3f08_11d3_9f0b_006008039e37);

// Local ISampleGrabber declaration (qedit.h is not in the win32 metadata —
// the C++ declares the same MIDL interface locally). Vtable order MUST match
// dshow_webcam_capture.cpp:20-30. COM method names stay PascalCase, hence
// the non_snake_case allowance on the generated items.
mod sample_grabber {
    #![allow(non_snake_case)]

    use windows::Win32::Media::MediaFoundation::AM_MEDIA_TYPE;
    use windows::core::{BOOL, HRESULT};

    // Per-method `pub` is consumed by the macro to set the generated
    // wrapper methods' visibility (they'd be module-private otherwise).
    #[windows_core::interface("6B652FFF-11FE-4FCE-92AD-0266B5D7C78F")]
    pub unsafe trait ISampleGrabber: windows_core::IUnknown {
        pub fn SetOneShot(&self, one_shot: BOOL) -> HRESULT;
        pub fn SetMediaType(&self, media_type: *const AM_MEDIA_TYPE) -> HRESULT;
        pub fn GetConnectedMediaType(&self, media_type: *mut AM_MEDIA_TYPE) -> HRESULT;
        pub fn SetBufferSamples(&self, buffer_them: BOOL) -> HRESULT;
        pub fn GetCurrentBuffer(&self, buffer_size: *mut i32, buffer: *mut i32) -> HRESULT;
        pub fn GetCurrentSample(&self, sample: *mut *mut core::ffi::c_void) -> HRESULT;
        pub fn SetCallback(&self, callback: *mut core::ffi::c_void, which_method: i32) -> HRESULT;
    }
}

use sample_grabber::ISampleGrabber;

/// guidToString port (dshow_webcam_capture.cpp:42-68): named forms for the
/// supported subtypes, else {hex} with the C++ field grouping.
fn guid_to_string(guid: &GUID) -> String {
    if *guid == MEDIASUBTYPE_RGB32 {
        return "RGB32".to_string();
    }
    if *guid == MEDIASUBTYPE_YUY2 {
        return "YUY2".to_string();
    }
    if *guid == MEDIASUBTYPE_NV12 {
        return "NV12".to_string();
    }
    let mut out = format!(
        "{{{:08x}-{:04x}-{:04x}-",
        guid.data1, guid.data2, guid.data3
    );
    for byte in &guid.data4[..2] {
        out.push_str(&format!("{byte:02x}"));
    }
    out.push('-');
    for byte in &guid.data4[2..] {
        out.push_str(&format!("{byte:02x}"));
    }
    out.push('}');
    out
}

/// freeMediaType port: releases the format block and any pUnk.
fn free_media_type(media_type: &mut AM_MEDIA_TYPE) {
    // SAFETY: the format block was CoTaskMemAlloc'd by the connected filter;
    // pUnk is ManuallyDrop and released exactly once here.
    unsafe {
        if media_type.cbFormat != 0 && !media_type.pbFormat.is_null() {
            CoTaskMemFree(Some(media_type.pbFormat as *const core::ffi::c_void));
            media_type.cbFormat = 0;
            media_type.pbFormat = std::ptr::null_mut();
        }
        if (*media_type.pUnk).is_some() {
            core::mem::ManuallyDrop::drop(&mut media_type.pUnk);
            media_type.pUnk = core::mem::ManuallyDrop::new(None);
        }
    }
}

fn check(result: windows::core::Result<()>, label: &str) -> bool {
    match result {
        Ok(()) => true,
        Err(e) => {
            eprint_hr(label, e.code());
            false
        }
    }
}

/// The grabber handle the capture thread polls; stop() joins the thread
/// before the graph is stopped/released.
struct SendGrabber(ISampleGrabber);
// SAFETY: DirectShow graph objects live in the MTA (the whole process is
// MTA); the capture thread only calls ISampleGrabber::GetCurrentBuffer,
// which qedit's grabber serializes internally, and stop() joins the thread
// before IMediaControl::Stop / release — the same discipline the C++ uses
// with its shared ComPtr impl_.
unsafe impl Send for SendGrabber {}

pub struct DShowWebcam {
    graph: Option<IGraphBuilder>,
    capture_graph: Option<ICaptureGraphBuilder2>,
    capture_filter: Option<IBaseFilter>,
    sample_grabber_filter: Option<IBaseFilter>,
    sample_grabber: Option<ISampleGrabber>,
    null_renderer: Option<IBaseFilter>,
    media_control: Option<IMediaControl>,
    thread: Option<std::thread::JoinHandle<()>>,
    store: Arc<FrameStore>,
    running: bool,
    width: i32,
    height: i32,
    fps: i32,
    source_stride: i32,
    source_top_down: bool,
    pixel_format: PixelFormat,
    selected_device_name: String,
}

impl DShowWebcam {
    /// initialize port (dshow_webcam_capture.cpp:115-252). The process is
    /// already MTA (RoInitialize on main), so the C++ CoInitializeEx/
    /// CoUninitialize refcount pair is a net no-op and is skipped.
    pub fn initialize(
        device_name: &str,
        direct_show_clsid: &str,
        requested_width: i32,
        requested_height: i32,
        fps: i32,
        store: Arc<FrameStore>,
    ) -> Option<Self> {
        if direct_show_clsid.is_empty() {
            eprintln!("ERROR: DirectShow webcam fallback requires a resolved filter CLSID");
            return None;
        }
        let wide_clsid: Vec<u16> = direct_show_clsid
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: CLSIDFromString on a NUL-terminated buffer.
        let selected_clsid =
            match unsafe { CLSIDFromString(windows::core::PCWSTR(wide_clsid.as_ptr())) } {
                Ok(clsid) => clsid,
                Err(_) => {
                    eprintln!("ERROR: DirectShow webcam fallback received an invalid filter CLSID");
                    return None;
                }
            };
        let selected_device_name = if device_name.is_empty() {
            direct_show_clsid.to_string()
        } else {
            device_name.to_string()
        };

        // SAFETY: COM object creation + graph wiring, mirroring the C++ call
        // sequence and labels one-for-one.
        unsafe {
            let capture_filter: IBaseFilter =
                match CoCreateInstance(&selected_clsid, None, CLSCTX_INPROC_SERVER) {
                    Ok(f) => f,
                    Err(e) => {
                        eprint_hr("CoCreateInstance(DirectShow webcam filter)", e.code());
                        return None;
                    }
                };
            let graph: IGraphBuilder =
                match CoCreateInstance(&CLSID_FilterGraph, None, CLSCTX_INPROC_SERVER) {
                    Ok(g) => g,
                    Err(e) => {
                        eprint_hr("CoCreateInstance(FilterGraph)", e.code());
                        return None;
                    }
                };
            let capture_graph: ICaptureGraphBuilder2 =
                match CoCreateInstance(&CLSID_CaptureGraphBuilder2, None, CLSCTX_INPROC_SERVER) {
                    Ok(g) => g,
                    Err(e) => {
                        eprint_hr("CoCreateInstance(CaptureGraphBuilder2)", e.code());
                        return None;
                    }
                };
            if !check(
                capture_graph.SetFiltergraph(&graph),
                "SetFiltergraph(DirectShow webcam)",
            ) {
                return None;
            }
            if !check(
                graph.AddFilter(&capture_filter, w!("CloseScreen Webcam Source")),
                "AddFilter(DirectShow webcam source)",
            ) {
                return None;
            }

            let sample_grabber_filter: IBaseFilter =
                match CoCreateInstance(&CLSID_SAMPLE_GRABBER, None, CLSCTX_INPROC_SERVER) {
                    Ok(f) => f,
                    Err(e) => {
                        eprint_hr("CoCreateInstance(SampleGrabber)", e.code());
                        return None;
                    }
                };
            let sample_grabber: ISampleGrabber = match sample_grabber_filter.cast() {
                Ok(g) => g,
                Err(e) => {
                    eprint_hr("QueryInterface(ISampleGrabber)", e.code());
                    return None;
                }
            };

            let requested_type = AM_MEDIA_TYPE {
                majortype: MEDIATYPE_Video,
                formattype: FORMAT_VideoInfo,
                ..Default::default()
            };
            if !check(
                sample_grabber.SetMediaType(&requested_type).ok(),
                "SetMediaType(DirectShow video)",
            ) {
                return None;
            }

            if !check(
                graph.AddFilter(
                    &sample_grabber_filter,
                    w!("CloseScreen Webcam Sample Grabber"),
                ),
                "AddFilter(SampleGrabber)",
            ) {
                return None;
            }
            let null_renderer: IBaseFilter =
                match CoCreateInstance(&CLSID_NULL_RENDERER, None, CLSCTX_INPROC_SERVER) {
                    Ok(f) => f,
                    Err(e) => {
                        eprint_hr("CoCreateInstance(NullRenderer)", e.code());
                        return None;
                    }
                };
            if !check(
                graph.AddFilter(&null_renderer, w!("CloseScreen Webcam Null Renderer")),
                "AddFilter(NullRenderer)",
            ) {
                return None;
            }

            if !check(
                capture_graph.RenderStream(
                    Some(&PIN_CATEGORY_CAPTURE),
                    &MEDIATYPE_Video,
                    &capture_filter
                        .cast::<IUnknown>()
                        .expect("IBaseFilter is IUnknown"),
                    &sample_grabber_filter,
                    &null_renderer,
                ),
                "RenderStream(DirectShow webcam)",
            ) {
                return None;
            }

            let mut connected_type = AM_MEDIA_TYPE::default();
            if !check(
                sample_grabber
                    .GetConnectedMediaType(&mut connected_type)
                    .ok(),
                "GetConnectedMediaType(DirectShow webcam)",
            ) {
                return None;
            }

            let pixel_format = if connected_type.subtype == MEDIASUBTYPE_YUY2 {
                PixelFormat::Yuy2
            } else if connected_type.subtype == MEDIASUBTYPE_NV12 {
                PixelFormat::Nv12
            } else if connected_type.subtype == MEDIASUBTYPE_RGB32 {
                PixelFormat::Bgra
            } else {
                eprintln!(
                    "ERROR: Unsupported DirectShow webcam media subtype {}",
                    guid_to_string(&connected_type.subtype)
                );
                free_media_type(&mut connected_type);
                return None;
            };

            let mut width = 0i32;
            let mut height = 0i32;
            let mut source_stride = 0i32;
            let mut source_top_down = false;
            if connected_type.formattype == FORMAT_VideoInfo && !connected_type.pbFormat.is_null() {
                // SAFETY: the connected filter allocated a VIDEOINFOHEADER
                // format block (formattype checked); read unaligned to be
                // safe against the raw allocation.
                let video_info =
                    (connected_type.pbFormat as *const VIDEOINFOHEADER).read_unaligned();
                width = video_info.bmiHeader.biWidth.abs();
                height = video_info.bmiHeader.biHeight.abs();
                let bits_per_pixel = if video_info.bmiHeader.biBitCount > 0 {
                    i32::from(video_info.bmiHeader.biBitCount)
                } else {
                    16
                };
                if pixel_format == PixelFormat::Nv12 {
                    source_stride = ((width + 3) / 4) * 4;
                } else {
                    source_stride = ((width * bits_per_pixel + 31) / 32) * 4;
                }
                source_top_down =
                    pixel_format != PixelFormat::Bgra || video_info.bmiHeader.biHeight < 0;
            }
            eprintln!(
                "INFO: DirectShow webcam connected subtype {} {}x{} stride={}",
                guid_to_string(&connected_type.subtype),
                width,
                height,
                source_stride
            );
            free_media_type(&mut connected_type);
            if width <= 0 || height <= 0 {
                width = if requested_width > 0 {
                    requested_width
                } else {
                    1280
                };
                height = if requested_height > 0 {
                    requested_height
                } else {
                    720
                };
            }
            if source_stride <= 0 {
                source_stride = if pixel_format == PixelFormat::Bgra {
                    width * 4
                } else {
                    ((width + 3) / 4) * 4
                };
            }

            let _ = sample_grabber.SetBufferSamples(BOOL::from(true));
            let _ = sample_grabber.SetOneShot(BOOL::from(false));
            let media_control: IMediaControl = match graph.cast() {
                Ok(c) => c,
                Err(e) => {
                    eprint_hr("QueryInterface(IMediaControl)", e.code());
                    return None;
                }
            };

            Some(Self {
                graph: Some(graph),
                capture_graph: Some(capture_graph),
                capture_filter: Some(capture_filter),
                sample_grabber_filter: Some(sample_grabber_filter),
                sample_grabber: Some(sample_grabber),
                null_renderer: Some(null_renderer),
                media_control: Some(media_control),
                thread: None,
                store,
                running: false,
                width,
                height,
                fps,
                source_stride,
                source_top_down,
                pixel_format,
                selected_device_name,
            })
        }
    }

    /// start port (dshow_webcam_capture.cpp:254-278): Run the graph, then
    /// spawn the poll thread; a spawn failure stops the graph again.
    pub fn start(&mut self) -> bool {
        if self.media_control.is_none() || self.running || self.thread.is_some() {
            return false;
        }
        let media_control = self.media_control.as_ref().unwrap();
        // SAFETY: graph state transition; the graph was fully built in
        // initialize().
        if !check(unsafe { media_control.Run() }, "Run(DirectShow webcam)") {
            return false;
        }

        let grabber = SendGrabber(
            self.sample_grabber
                .as_ref()
                .expect("grabber initialized")
                .clone(),
        );
        let store = Arc::clone(&self.store);
        let (width, height) = (self.width, self.height);
        let (fps, stride, top_down, format) = (
            self.fps,
            self.source_stride,
            self.source_top_down,
            self.pixel_format,
        );
        match std::thread::Builder::new().spawn(move || {
            capture_loop(grabber, store, format, width, height, stride, top_down, fps);
        }) {
            Ok(handle) => {
                self.thread = Some(handle);
                self.running = true;
                true
            }
            Err(_) => {
                // SAFETY: undo the Run above, mirroring the C++ catch.
                let _ = unsafe { media_control.Stop() };
                eprintln!("ERROR: Failed to start DirectShow webcam capture thread");
                false
            }
        }
    }

    pub fn stop(&mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Some(media_control) = &self.media_control
            && self.running
        {
            // SAFETY: poll thread joined above; sole user of the graph now.
            let _ = unsafe { media_control.Stop() };
        }
        self.running = false;
        self.media_control = None;
        self.null_renderer = None;
        self.sample_grabber = None;
        self.sample_grabber_filter = None;
        self.capture_filter = None;
        self.capture_graph = None;
        self.graph = None;
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

impl Drop for DShowWebcam {
    fn drop(&mut self) {
        self.stop();
    }
}

/// captureLoop port (dshow_webcam_capture.cpp:305-322): poll
/// GetCurrentBuffer at the frame cadence; size query first, then fill.
#[allow(clippy::too_many_arguments)]
fn capture_loop(
    grabber: SendGrabber,
    store: Arc<FrameStore>,
    format: PixelFormat,
    width: i32,
    height: i32,
    stride: i32,
    top_down: bool,
    fps: i32,
) {
    let grabber = grabber;
    let interval = std::time::Duration::from_millis(1000 / u64::from(fps.max(1) as u32));

    // SAFETY: per-thread COM init, matching the C++ captureLoop
    // (dshow_webcam_capture.cpp:306) instead of relying on implicit MTA. The
    // matching CoUninitialize below is guarded on this hr like the C++.
    let coinit_hr = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        )
    };

    while !store.stop_requested() {
        let mut buffer_size = 0i32;
        // SAFETY: qedit GetCurrentBuffer contract — null buffer queries the
        // size, second call fills a buffer of that size.
        unsafe {
            let hr = grabber
                .0
                .GetCurrentBuffer(&mut buffer_size, std::ptr::null_mut());
            if hr.is_ok() && buffer_size > 0 {
                let mut buffer = vec![0u8; buffer_size as usize];
                let hr = grabber
                    .0
                    .GetCurrentBuffer(&mut buffer_size, buffer.as_mut_ptr() as *mut i32);
                // The second call may report a DIFFERENT byte count; the C++
                // gates storeFrame on that updated length, so shrink the
                // buffer to what the grabber actually wrote before the
                // expected-length gate runs (Codex review, PR #81).
                if hr.is_ok() {
                    buffer.truncate(buffer_size.max(0) as usize);
                    if let Some(frame) =
                        convert_frame(&buffer, format, width, height, stride, top_down)
                    {
                        store.store(frame, width, height);
                    }
                }
            }
        }
        std::thread::sleep(interval);
    }

    if coinit_hr.is_ok() {
        // SAFETY: paired with the successful CoInitializeEx above
        // (dshow_webcam_capture.cpp:319-321).
        unsafe {
            windows::Win32::System::Com::CoUninitialize();
        }
    }
}
