//! WASAPI capture (system loopback + microphone) — port of
//! wasapi_loopback_capture.cpp. One struct serves both endpoints; failures
//! are classified into the four reason codes the system-audio-unavailable
//! event carries.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use closescreen_native_protocol::device_match::{AUDIO_STOP_WORDS, score_device_name};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_IN_USE,
    AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED, AUDCLNT_E_UNSUPPORTED_FORMAT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, IAudioCaptureClient, IAudioClient,
    IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, WAVE_FORMAT_PCM, WAVEFORMATEX,
    WAVEFORMATEXTENSIBLE, eCapture, eConsole, eRender,
};
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree, STGM_READ};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::core::PCWSTR;

use super::format::{AudioFormat, AudioSubtype};
use crate::eprint_hr;

const BUFFER_DURATION_HNS: i64 = 10_000_000;
const HNS_PER_SECOND: u64 = 10_000_000;
const MAX_SILENCE_CHUNK_FRAMES: u64 = 4800;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    SystemLoopback,
    Microphone,
}

/// classifyWasapiFailure (cpp:17-29).
fn classify_failure(hr: windows::core::HRESULT, endpoint: Endpoint, label: &str) -> &'static str {
    if endpoint == Endpoint::SystemLoopback && label == "GetDefaultAudioEndpoint" {
        return "no-render-endpoint";
    }
    if hr == AUDCLNT_E_DEVICE_IN_USE || hr == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
        return "device-in-use";
    }
    if hr == AUDCLNT_E_UNSUPPORTED_FORMAT {
        return "unsupported-format";
    }
    "init-failed"
}

fn friendly_name(device: &IMMDevice) -> String {
    // SAFETY: read-only property-store access; the PROPVARIANT is cleared
    // with PropVariantClear on every path, mirroring the C++.
    unsafe {
        let Ok(store) = device.OpenPropertyStore(STGM_READ) else {
            return String::new();
        };
        let Ok(mut value) =
            store.GetValue(&windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName)
        else {
            return String::new();
        };
        let mut name = String::new();
        if value.Anonymous.Anonymous.vt == VT_LPWSTR {
            let pwsz = value.Anonymous.Anonymous.Anonymous.pwszVal;
            if !pwsz.is_null() {
                name = PCWSTR(pwsz.0).to_string().unwrap_or_default();
            }
        }
        let _ = PropVariantClear(&mut value);
        name
    }
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

pub type AudioCallback = Box<dyn Fn(&[u8], i64, i64) + Send + Sync>; // data, tsHns, durHns

struct CaptureShared {
    stop_requested: AtomicBool,
}

pub struct WasapiCapture {
    endpoint: Endpoint,
    device: Option<IMMDevice>,
    audio_client: Option<IAudioClient>,
    capture_client: Option<IAudioCaptureClient>,
    input_format: Option<AudioFormat>,
    selected_device_name: String,
    last_failure_reason: String,
    shared: Arc<CaptureShared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

// SAFETY: COM interfaces are created on the main thread and, after start(),
// the capture/audio clients are used exclusively by the capture thread until
// stop() joins it — the same single-owner handoff as the C++ (MTA process).
unsafe impl Send for WasapiCapture {}

impl WasapiCapture {
    pub fn new_system_loopback() -> (Self, bool) {
        let mut capture = Self::empty(Endpoint::SystemLoopback);
        let ok = capture.initialize(None, None);
        (capture, ok)
    }

    pub fn new_microphone(device_id: Option<&str>, device_name: Option<&str>) -> (Self, bool) {
        let mut capture = Self::empty(Endpoint::Microphone);
        let ok = capture.initialize(device_id, device_name);
        (capture, ok)
    }

    fn empty(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            device: None,
            audio_client: None,
            capture_client: None,
            input_format: None,
            selected_device_name: String::new(),
            last_failure_reason: String::new(),
            shared: Arc::new(CaptureShared {
                stop_requested: AtomicBool::new(false),
            }),
            thread: None,
        }
    }

    fn fail(&mut self, hr: windows::core::HRESULT, label: &str) -> bool {
        eprint_hr(label, hr);
        self.last_failure_reason = classify_failure(hr, self.endpoint, label).to_string();
        false
    }

    fn initialize(&mut self, device_id: Option<&str>, device_name: Option<&str>) -> bool {
        self.last_failure_reason.clear();
        // SAFETY: standard COM activation sequence, mirroring cpp:159-238;
        // every interface is stored on self and freed by wrapper Drops.
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                    Ok(e) => e,
                    Err(e) => return self.fail(e.code(), "CoCreateInstance(MMDeviceEnumerator)"),
                };

            if self.endpoint == Endpoint::Microphone {
                if let Some(id) = device_id
                    && !id.is_empty()
                    && id != "default"
                {
                    let wide = to_wide(id);
                    match enumerator.GetDevice(PCWSTR(wide.as_ptr())) {
                        Ok(d) => self.device = Some(d),
                        Err(_) => {
                            eprintln!("WARNING: Could not resolve microphone device id directly");
                        }
                    }
                }
                if self.device.is_none()
                    && let Some(name) = device_name
                    && !name.is_empty()
                    && !self.resolve_microphone_by_name(&enumerator, name)
                {
                    eprintln!(
                        "WARNING: Could not resolve microphone by name; using default capture endpoint"
                    );
                }
            }

            if self.device.is_none() {
                let flow = if self.endpoint == Endpoint::SystemLoopback {
                    eRender
                } else {
                    eCapture
                };
                match enumerator.GetDefaultAudioEndpoint(flow, eConsole) {
                    Ok(d) => self.device = Some(d),
                    Err(e) => return self.fail(e.code(), "GetDefaultAudioEndpoint"),
                }
            }

            let device = self.device.as_ref().unwrap();
            self.selected_device_name = friendly_name(device);

            let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
                Ok(c) => c,
                Err(e) => return self.fail(e.code(), "IMMDevice::Activate(IAudioClient)"),
            };

            let mix_format = match audio_client.GetMixFormat() {
                Ok(f) if !f.is_null() => f,
                Ok(_) | Err(_) => {
                    let hr = audio_client
                        .GetMixFormat()
                        .err()
                        .map(|e| e.code())
                        .unwrap_or(windows::core::HRESULT(-1));
                    return self.fail(hr, "IAudioClient::GetMixFormat");
                }
            };

            let resolved = resolve_input_format(&*mix_format);
            let Some(format) = resolved else {
                CoTaskMemFree(Some(mix_format.cast()));
                eprintln!("ERROR: Unsupported WASAPI loopback mix format");
                self.last_failure_reason = "unsupported-format".to_string();
                return false;
            };
            self.input_format = Some(format);

            let stream_flags = if self.endpoint == Endpoint::SystemLoopback {
                AUDCLNT_STREAMFLAGS_LOOPBACK
            } else {
                0
            };
            let init = audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                BUFFER_DURATION_HNS,
                0,
                mix_format,
                None,
            );
            CoTaskMemFree(Some(mix_format.cast()));
            if let Err(e) = init {
                return self.fail(e.code(), "IAudioClient::Initialize(loopback)");
            }

            let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                Ok(c) => c,
                Err(e) => {
                    return self.fail(e.code(), "IAudioClient::GetService(IAudioCaptureClient)");
                }
            };

            self.audio_client = Some(audio_client);
            self.capture_client = Some(capture_client);
            true
        }
    }

    /// verifyStartable (cpp:240-257) — loopback probe only.
    pub fn verify_startable(&mut self) -> bool {
        let Some(client) = self.audio_client.clone() else {
            self.last_failure_reason = "init-failed".to_string();
            return false;
        };
        // SAFETY: probe start/stop on the initialized client.
        unsafe {
            if let Err(e) = client.Start() {
                return self.fail(e.code(), "IAudioClient::Start(probe)");
            }
            let _ = client.Stop();
        }
        true
    }

    fn resolve_microphone_by_name(
        &mut self,
        enumerator: &IMMDeviceEnumerator,
        requested_name: &str,
    ) -> bool {
        // SAFETY: enumeration of active capture endpoints, read-only.
        unsafe {
            let Ok(devices) = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else {
                eprint_hr(
                    "IMMDeviceEnumerator::EnumAudioEndpoints(eCapture)",
                    windows::core::HRESULT(-1),
                );
                return false;
            };
            let Ok(count) = devices.GetCount() else {
                return false;
            };

            let mut best: Option<IMMDevice> = None;
            let mut best_id = String::new();
            let mut best_name = String::new();
            let mut best_score = 0;
            for i in 0..count {
                let Ok(candidate) = devices.Item(i) else {
                    continue;
                };
                let candidate_id = match candidate.GetId() {
                    Ok(raw) if !raw.is_null() => {
                        let id = PCWSTR(raw.0).to_string().unwrap_or_default();
                        CoTaskMemFree(Some(raw.0.cast()));
                        id
                    }
                    _ => String::new(),
                };
                let candidate_name = friendly_name(&candidate);
                let score = score_device_name(
                    &candidate_name,
                    &candidate_id,
                    requested_name,
                    AUDIO_STOP_WORDS,
                );
                eprintln!("Native microphone candidate: {candidate_name} score={score}");
                if score > best_score {
                    best_score = score;
                    best = Some(candidate);
                    best_id = candidate_id;
                    best_name = candidate_name;
                }
            }

            let Some(device) = best else {
                return false;
            };
            if best_score <= 0 {
                return false;
            }
            self.device = Some(device);
            eprintln!("Selected native microphone endpoint: {best_name} id={best_id}");
            true
        }
    }

    pub fn input_format(&self) -> Option<AudioFormat> {
        self.input_format
    }

    pub fn selected_device_name(&self) -> &str {
        &self.selected_device_name
    }

    pub fn last_failure_reason(&self) -> &str {
        &self.last_failure_reason
    }

    pub fn start(&mut self, callback: AudioCallback) -> bool {
        let (Some(audio_client), Some(capture_client), Some(format)) = (
            self.audio_client.clone(),
            self.capture_client.clone(),
            self.input_format,
        ) else {
            return false;
        };

        self.shared.stop_requested.store(false, Ordering::SeqCst);
        // SAFETY: starting the initialized client before spawning the reader.
        unsafe {
            if let Err(e) = audio_client.Start() {
                eprint_hr("IAudioClient::Start", e.code());
                self.last_failure_reason =
                    classify_failure(e.code(), Endpoint::SystemLoopback, "IAudioClient::Start")
                        .to_string();
                return false;
            }
        }

        let shared = Arc::clone(&self.shared);
        let client = SendCaptureClient(capture_client);
        self.thread = Some(std::thread::spawn(move || {
            // Bind the whole wrapper: edition-2024 disjoint capture would
            // otherwise capture only the !Send inner interface.
            let client = client;
            capture_loop(&shared, &client.0, &format, &callback);
        }));
        true
    }

    pub fn stop(&mut self) {
        self.shared.stop_requested.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Some(client) = &self.audio_client {
            // SAFETY: stop after the reader thread joined — single owner.
            unsafe {
                let _ = client.Stop();
            }
        }
    }
}

impl Drop for WasapiCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

struct SendCaptureClient(IAudioCaptureClient);
// SAFETY: the capture client is handed to exactly one thread (the capture
// loop) and not touched elsewhere until stop() joins that thread; MTA.
unsafe impl Send for SendCaptureClient {}

/// resolveInputFormat + audioSubtypeFromFormat (cpp:41-59, 314-327).
fn resolve_input_format(mix: &WAVEFORMATEX) -> Option<AudioFormat> {
    let tag = mix.wFormatTag as u32;
    let subtype = if tag == WAVE_FORMAT_IEEE_FLOAT {
        Some(AudioSubtype::Float)
    } else if tag == WAVE_FORMAT_PCM {
        Some(AudioSubtype::Pcm)
    } else if tag == WAVE_FORMAT_EXTENSIBLE
        && usize::from(mix.cbSize)
            >= std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - std::mem::size_of::<WAVEFORMATEX>()
    {
        // SAFETY: cbSize guarantees the extensible tail is present; the
        // struct is packed, so SubFormat is copied out unaligned.
        let sub_format = unsafe {
            let ext = std::ptr::from_ref(mix).cast::<WAVEFORMATEXTENSIBLE>();
            (&raw const (*ext).SubFormat).read_unaligned()
        };
        if sub_format == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
            Some(AudioSubtype::Float)
        } else if sub_format == KSDATAFORMAT_SUBTYPE_PCM {
            Some(AudioSubtype::Pcm)
        } else {
            None
        }
    } else {
        None
    };

    let format = AudioFormat {
        subtype: subtype?,
        sample_rate: mix.nSamplesPerSec,
        channels: u32::from(mix.nChannels),
        bits_per_sample: u32::from(mix.wBitsPerSample),
        block_align: u32::from(mix.nBlockAlign),
        avg_bytes_per_sec: mix.nAvgBytesPerSec,
    };
    (format.sample_rate > 0 && format.channels > 0 && format.block_align > 0).then_some(format)
}

/// Gap-fill decision (cpp:418-424), extracted pure for unit tests: fill only
/// on an explicit discontinuity flag or a gap larger than the packet itself.
pub fn should_fill_gap(gap_frames: u64, frames_available: u32, discontinuity: bool) -> bool {
    discontinuity || gap_frames > u64::from(frames_available)
}

/// Silence chunking (cpp:378-392), pure: returns (chunk_frames, ts) pairs.
pub fn silence_chunks(gap_frames: u64, start_ts_hns: i64, sample_rate: u32) -> Vec<(u64, i64)> {
    let mut chunks = Vec::new();
    let mut remaining = gap_frames;
    let mut ts = start_ts_hns;
    while remaining > 0 {
        let chunk = remaining.min(MAX_SILENCE_CHUNK_FRAMES);
        chunks.push((chunk, ts));
        let duration = ((chunk * HNS_PER_SECOND) / u64::from(sample_rate)) as i64;
        remaining -= chunk;
        ts += duration;
    }
    chunks
}

fn capture_loop(
    shared: &CaptureShared,
    capture_client: &IAudioCaptureClient,
    format: &AudioFormat,
    callback: &AudioCallback,
) {
    let mut silence_buffer: Vec<u8> = Vec::new();
    let mut last_device_position_end: u64 = 0;
    let mut has_last_device_position = false;

    while !shared.stop_requested.load(Ordering::SeqCst) {
        // SAFETY: standard capture-client polling sequence; buffers are only
        // read between GetBuffer and ReleaseBuffer.
        unsafe {
            let mut packet_frames = match capture_client.GetNextPacketSize() {
                Ok(n) => n,
                Err(e) => {
                    eprint_hr("IAudioCaptureClient::GetNextPacketSize", e.code());
                    break;
                }
            };

            while packet_frames > 0 && !shared.stop_requested.load(Ordering::SeqCst) {
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames_available = 0u32;
                let mut flags = 0u32;
                let mut device_position = 0u64;
                if let Err(e) = capture_client.GetBuffer(
                    &mut data,
                    &mut frames_available,
                    &mut flags,
                    Some(&mut device_position),
                    None,
                ) {
                    eprint_hr("IAudioCaptureClient::GetBuffer", e.code());
                    break;
                }

                if has_last_device_position && device_position > last_device_position_end {
                    let gap_frames = device_position - last_device_position_end;
                    let discontinuity =
                        (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32) != 0;
                    if should_fill_gap(gap_frames, frames_available, discontinuity) {
                        let gap_ts = ((last_device_position_end * HNS_PER_SECOND)
                            / u64::from(format.sample_rate))
                            as i64;
                        for (chunk_frames, ts) in
                            silence_chunks(gap_frames, gap_ts, format.sample_rate)
                        {
                            if shared.stop_requested.load(Ordering::SeqCst) {
                                break;
                            }
                            let chunk_bytes = (chunk_frames as usize) * format.block_align as usize;
                            silence_buffer.clear();
                            silence_buffer.resize(chunk_bytes, 0);
                            let duration = ((chunk_frames * HNS_PER_SECOND)
                                / u64::from(format.sample_rate))
                                as i64;
                            callback(&silence_buffer, ts, duration);
                        }
                    }
                }

                let byte_count = frames_available as usize * format.block_align as usize;
                let timestamp_hns =
                    ((device_position * HNS_PER_SECOND) / u64::from(format.sample_rate)) as i64;
                let duration_hns = ((u64::from(frames_available) * HNS_PER_SECOND)
                    / u64::from(format.sample_rate)) as i64;

                if byte_count > 0 {
                    let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                    if silent || data.is_null() {
                        silence_buffer.clear();
                        silence_buffer.resize(byte_count, 0);
                        callback(&silence_buffer, timestamp_hns, duration_hns);
                    } else {
                        let slice = std::slice::from_raw_parts(data, byte_count);
                        callback(slice, timestamp_hns, duration_hns);
                    }
                }

                last_device_position_end = device_position + u64::from(frames_available);
                has_last_device_position = true;
                let _ = capture_client.ReleaseBuffer(frames_available);

                packet_frames = match capture_client.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(e) => {
                        eprint_hr("IAudioCaptureClient::GetNextPacketSize", e.code());
                        break;
                    }
                };
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gap_fill_requires_flag_or_oversized_gap() {
        assert!(should_fill_gap(100, 480, true)); // discontinuity flag
        assert!(should_fill_gap(481, 480, false)); // gap larger than packet
        assert!(!should_fill_gap(480, 480, false)); // benign small gap
        assert!(!should_fill_gap(1, 480, false));
    }

    #[test]
    fn silence_chunking_caps_at_4800_and_advances_timestamps() {
        let chunks = silence_chunks(10_000, 0, 48000);
        assert_eq!(
            chunks.iter().map(|(f, _)| *f).collect::<Vec<_>>(),
            vec![4800, 4800, 400]
        );
        // Each 4800-frame chunk at 48k is exactly 0.1s = 1_000_000 hns.
        assert_eq!(
            chunks.iter().map(|(_, t)| *t).collect::<Vec<_>>(),
            vec![0, 1_000_000, 2_000_000]
        );
        assert!(silence_chunks(0, 5, 48000).is_empty());
    }
}
