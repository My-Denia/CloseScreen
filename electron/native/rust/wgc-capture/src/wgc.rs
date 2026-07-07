//! Windows.Graphics.Capture session — port of wgc_session.cpp, including the
//! shutdown-race hardening from #49: a `stopping` flag set before the event
//! revoke, and a callback mutex held across the whole FrameArrived body that
//! stop() acquires once as a teardown barrier.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
    IGraphicsCaptureSession2,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::core::Interface;

use crate::eprint_hr;

pub type FrameCallback = Box<dyn FnMut(&ID3D11Texture2D, i64) + Send>;

/// State shared with the free-threaded FrameArrived handler.
struct CallbackState {
    /// Set at the top of stop() BEFORE the event revoke so a handler that
    /// begins during teardown early-returns instead of touching state being
    /// freed (wgc_session.h:55-58).
    stopping: AtomicBool,
    callback: Mutex<Option<FrameCallback>>,
}

pub struct WgcSession {
    d3d_device: Option<ID3D11Device>,
    d3d_context: Option<ID3D11DeviceContext>,
    winrt_device: Option<IDirect3DDevice>,
    item: Option<GraphicsCaptureItem>,
    frame_pool: Option<Direct3D11CaptureFramePool>,
    session: Option<GraphicsCaptureSession>,
    frame_arrived_token: i64,
    state: Arc<CallbackState>,
    width: i32,
    height: i32,
    capture_cursor: bool,
}

pub enum CaptureTarget {
    Monitor(HMONITOR),
    Window(HWND),
}

impl WgcSession {
    pub fn new() -> Self {
        Self {
            d3d_device: None,
            d3d_context: None,
            winrt_device: None,
            item: None,
            frame_pool: None,
            session: None,
            frame_arrived_token: 0,
            state: Arc::new(CallbackState {
                stopping: AtomicBool::new(false),
                callback: Mutex::new(None),
            }),
            width: 0,
            height: 0,
            capture_cursor: false,
        }
    }

    fn create_d3d_device(&mut self) -> bool {
        let feature_levels = [
            D3D_FEATURE_LEVEL_11_1,
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0,
        ];
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let mut level = D3D_FEATURE_LEVEL::default();
        // SAFETY: standard device creation with out-params; release semantics
        // of the C++ (single HARDWARE attempt, BGRA support flag).
        let hr = unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                windows::Win32::Foundation::HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&feature_levels),
                D3D11_SDK_VERSION,
                Some(&raw mut device),
                Some(&raw mut level),
                Some(&raw mut context),
            )
        };
        if let Err(e) = hr {
            eprint_hr("D3D11CreateDevice", e.code());
            return false;
        }
        let (Some(device), Some(context)) = (device, context) else {
            eprint_hr("D3D11CreateDevice", windows::core::HRESULT(-1));
            return false;
        };

        let dxgi: IDXGIDevice = match device.cast() {
            Ok(d) => d,
            Err(e) => {
                eprint_hr("Query IDXGIDevice", e.code());
                return false;
            }
        };
        // SAFETY: documented interop call producing an IInspectable device wrapper.
        let inspectable = match unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) } {
            Ok(i) => i,
            Err(e) => {
                eprint_hr("CreateDirect3D11DeviceFromDXGIDevice", e.code());
                return false;
            }
        };
        let winrt_device: IDirect3DDevice = match inspectable.cast() {
            Ok(d) => d,
            Err(e) => {
                eprint_hr("CreateDirect3D11DeviceFromDXGIDevice", e.code());
                return false;
            }
        };

        self.d3d_device = Some(device);
        self.d3d_context = Some(context);
        self.winrt_device = Some(winrt_device);
        true
    }

    fn create_capture_item(&mut self, target: &CaptureTarget) -> bool {
        let interop: IGraphicsCaptureItemInterop =
            match windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>() {
                Ok(f) => f,
                Err(e) => {
                    eprint_hr("GraphicsCaptureItem factory", e.code());
                    return false;
                }
            };
        // SAFETY: interop creation from a live HMONITOR/HWND, as in the C++.
        let item: Result<GraphicsCaptureItem, _> = unsafe {
            match target {
                CaptureTarget::Monitor(m) => interop.CreateForMonitor(*m),
                CaptureTarget::Window(w) => interop.CreateForWindow(*w),
            }
        };
        let item = match item {
            Ok(i) => i,
            Err(e) => {
                let label = match target {
                    CaptureTarget::Monitor(_) => "CreateForMonitor",
                    CaptureTarget::Window(_) => "CreateForWindow",
                };
                eprint_hr(label, e.code());
                return false;
            }
        };
        let size = match item.Size() {
            Ok(s) => s,
            Err(_) => return false,
        };
        self.width = size.Width;
        self.height = size.Height;
        self.item = Some(item);
        self.width > 0 && self.height > 0
    }

    /// Applies cursor + border options and emits the cursor-capture event.
    /// Runs during initialize() AND start(), so the event is emitted twice —
    /// that duplication is part of the observed protocol.
    fn apply_session_options(&mut self, capture_cursor: bool) -> bool {
        self.capture_cursor = capture_cursor;
        let Some(session) = &self.session else {
            return false;
        };

        // The projected methods QI IGraphicsCaptureSession2 internally; the
        // explicit cast mirrors the C++ try_as availability probe so the
        // "runtime lacks session2" and "setting failed" paths stay distinct.
        match session.cast::<IGraphicsCaptureSession2>() {
            Ok(_session2) => {
                let applied = session
                    .SetIsCursorCaptureEnabled(capture_cursor)
                    .and_then(|()| session.IsCursorCaptureEnabled());
                match applied {
                    Ok(applied) => {
                        crate::WRITER
                            .write_line(&crate::events::cursor_capture_line(
                                capture_cursor,
                                applied,
                            ))
                            .ok();
                        if applied != capture_cursor {
                            eprintln!("ERROR: WGC cursor capture setting did not apply");
                            return false;
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "ERROR: Failed to configure WGC cursor capture (hr=0x{:x})",
                            e.code().0 as u32
                        );
                        if !capture_cursor {
                            return false;
                        }
                    }
                }
            }
            Err(_) => {
                if !capture_cursor {
                    eprintln!(
                        "ERROR: WGC cursor suppression is not supported by this Windows runtime"
                    );
                    return false;
                }
            }
        }

        // IsBorderRequired is Windows 11-only; ignore failures on older builds.
        let _ = session.SetIsBorderRequired(false);

        true
    }

    pub fn initialize(&mut self, target: CaptureTarget, capture_cursor: bool) -> bool {
        self.state.stopping.store(false, Ordering::SeqCst);
        if !self.create_d3d_device() {
            return false;
        }
        if !self.create_capture_item(&target) {
            return false;
        }

        let (Some(winrt_device), Some(item)) = (&self.winrt_device, &self.item) else {
            return false;
        };
        let size = match item.Size() {
            Ok(s) => s,
            Err(_) => return false,
        };
        let frame_pool = match Direct3D11CaptureFramePool::CreateFreeThreaded(
            winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        ) {
            Ok(p) => p,
            Err(e) => {
                eprint_hr("CreateFreeThreaded", e.code());
                return false;
            }
        };
        let session = match frame_pool.CreateCaptureSession(item) {
            Ok(s) => s,
            Err(e) => {
                eprint_hr("CreateCaptureSession", e.code());
                return false;
            }
        };
        self.frame_pool = Some(frame_pool);
        self.session = Some(session);

        if !self.apply_session_options(capture_cursor) {
            return false;
        }

        // FrameArrived handler: hold the callback mutex across the whole body
        // so stop() can use it as a teardown barrier; check `stopping` under
        // the lock and bail before touching the pool (wgc_session.cpp:291-323).
        let state = Arc::clone(&self.state);
        let handler = TypedEventHandler::new(
            move |sender: windows::core::Ref<'_, Direct3D11CaptureFramePool>,
                  _args: windows::core::Ref<'_, windows::core::IInspectable>| {
                let mut cb_guard = state
                    .callback
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if state.stopping.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let Some(sender) = sender.as_ref() else {
                    return Ok(());
                };
                let Ok(frame) = sender.TryGetNextFrame() else {
                    return Ok(());
                };
                let (Ok(surface), Ok(time)) = (frame.Surface(), frame.SystemRelativeTime()) else {
                    return Ok(());
                };
                let access: windows::core::Result<
                    windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess,
                > = surface.cast();
                if let Ok(access) = access {
                    // SAFETY: GetInterface yields the backing ID3D11Texture2D
                    // of the frame surface, valid until frame.Close().
                    let texture: windows::core::Result<ID3D11Texture2D> =
                        unsafe { access.GetInterface() };
                    if let Ok(texture) = texture
                        && let Some(cb) = cb_guard.as_mut()
                    {
                        cb(&texture, time.Duration);
                    }
                }
                let _ = frame.Close();
                Ok(())
            },
        );
        let token = match self.frame_pool.as_ref().unwrap().FrameArrived(&handler) {
            Ok(t) => t,
            Err(e) => {
                eprint_hr("FrameArrived", e.code());
                return false;
            }
        };
        self.frame_arrived_token = token;
        true
    }

    pub fn set_frame_callback(&mut self, callback: FrameCallback) {
        let mut guard = self
            .state
            .callback
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(callback);
    }

    pub fn start(&mut self) -> bool {
        if self.session.is_none() {
            return false;
        }
        if !self.apply_session_options(self.capture_cursor) {
            return false;
        }
        match self.session.as_ref().unwrap().StartCapture() {
            Ok(()) => true,
            Err(e) => {
                eprint_hr("StartCapture", e.code());
                false
            }
        }
    }

    pub fn stop(&mut self) {
        // Signal teardown BEFORE revoking the event so a handler that starts
        // during the revoke sees `stopping` and no-ops.
        self.state.stopping.store(true, Ordering::SeqCst);

        if let Some(pool) = &self.frame_pool {
            let _ = pool.RemoveFrameArrived(self.frame_arrived_token);
        }

        // Barrier: the handler holds the callback mutex for its whole body, so
        // acquiring it here waits out any in-flight handler. Drop the user
        // callback under the lock, and release it BEFORE the Close() calls —
        // those can join the frame-pool thread and would deadlock a handler
        // blocked on this lock (wgc_session.cpp:265-274).
        {
            let mut guard = self
                .state
                .callback
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = None;
        }

        if let Some(session) = self.session.take() {
            let _ = session.Close();
        }
        if let Some(pool) = self.frame_pool.take() {
            let _ = pool.Close();
        }
        self.item = None;
        self.winrt_device = None;
        self.d3d_context = None;
        self.d3d_device = None;
    }

    pub fn capture_width(&self) -> i32 {
        self.width
    }

    pub fn capture_height(&self) -> i32 {
        self.height
    }

    pub fn device(&self) -> Option<&ID3D11Device> {
        self.d3d_device.as_ref()
    }

    pub fn context(&self) -> Option<&ID3D11DeviceContext> {
        self.d3d_context.as_ref()
    }
}

impl Drop for WgcSession {
    fn drop(&mut self) {
        self.stop();
    }
}
