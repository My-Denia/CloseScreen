//! Media Foundation H.264/MP4 encoder — port of mf_encoder.cpp (video path).
//! One writer mutex serializes every sink-writer touch; the issue-#14 fault
//! injection lives inside write_frame AFTER that mutex is taken, so the
//! synthetic wedge holds the lock exactly like a hung WriteSample.

use std::sync::Mutex;

use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Media::MediaFoundation::{
    IMFSinkWriter, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_VERSION,
    MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL,
    MFMediaType_Video, MFSTARTUP_FULL, MFShutdown, MFStartup, MFVideoFormat_H264,
    MFVideoFormat_RGB32, MFVideoInterlace_Progressive,
};
use windows::core::{HRESULT, PCWSTR};

use crate::eprint_hr;

fn pack_u64(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

struct WriterState {
    sink_writer: Option<IMFSinkWriter>,
    video_stream_index: u32,
    audio_stream_index: Option<u32>,
    staging_texture: Option<ID3D11Texture2D>,
    device: Option<ID3D11Device>,
    context: Option<ID3D11DeviceContext>,
    timing: crate::timing::EncoderTiming,
    finalized: bool,
}

pub struct MfEncoder {
    width: i32,
    height: i32,
    state: Mutex<WriterState>,
}

// SAFETY: windows-core COM wrappers are !Send/!Sync by default because
// apartment affinity is the caller's responsibility. This process runs
// every thread in the MTA (RoInitialize(MULTITHREADED) on main;
// std::thread workers inherit MTA-implicit access for these agile-usage
// patterns exactly as the C++ did), and every interface inside WriterState
// is only ever touched while holding the `state` mutex — the same
// writerMutex_ serialization the C++ encoder relies on.
unsafe impl Send for MfEncoder {}
// SAFETY: see Send above — all interior access is behind the state mutex.
unsafe impl Sync for MfEncoder {}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// configureAudioStream (mf_encoder.cpp:155-199): AAC output at 24000 avg
/// bytes/sec, payload 0; PCM input from the AAC-compatible encoder format
/// with ALL_SAMPLES_INDEPENDENT. Returns the audio stream index.
fn configure_audio_stream(
    sink_writer: &IMFSinkWriter,
    audio_format: &crate::audio::format::AudioFormat,
) -> Option<u32> {
    use windows::Win32::Media::MediaFoundation::{
        MF_MT_AAC_PAYLOAD_TYPE, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
        MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
        MF_MT_AUDIO_SAMPLES_PER_SECOND, MFAudioFormat_AAC, MFMediaType_Audio,
    };

    if audio_format.sample_rate == 0 || audio_format.channels == 0 || audio_format.block_align == 0
    {
        eprintln!("ERROR: Invalid audio input format");
        return None;
    }
    let encoder_format = crate::audio::format::make_aac_compatible(audio_format);
    const AAC_BYTES_PER_SECOND: u32 = 24_000;

    // SAFETY: media-type construction with the exact C++ attribute set.
    unsafe {
        let output_type = match MFCreateMediaType() {
            Ok(t) => t,
            Err(e) => {
                eprint_hr("MFCreateMediaType(audio output)", e.code());
                return None;
            }
        };
        let _ = output_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio);
        let _ = output_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC);
        let _ = output_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, encoder_format.channels);
        let _ = output_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, encoder_format.sample_rate);
        let _ = output_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
        let _ = output_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND);
        let _ = output_type.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0);

        let audio_stream_index = match sink_writer.AddStream(&output_type) {
            Ok(i) => i,
            Err(e) => {
                eprint_hr("AddStream(audio)", e.code());
                return None;
            }
        };

        let input_type = match MFCreateMediaType() {
            Ok(t) => t,
            Err(e) => {
                eprint_hr("MFCreateMediaType(audio input)", e.code());
                return None;
            }
        };
        let _ = input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio);
        let _ = input_type.SetGUID(&MF_MT_SUBTYPE, &encoder_format.subtype.to_guid());
        let _ = input_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, encoder_format.channels);
        let _ = input_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, encoder_format.sample_rate);
        let _ = input_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, encoder_format.bits_per_sample);
        let _ = input_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, encoder_format.block_align);
        let _ = input_type.SetUINT32(
            &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
            encoder_format.avg_bytes_per_sec,
        );
        let _ = input_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1);

        if !check(
            sink_writer.SetInputMediaType(audio_stream_index, &input_type, None),
            "SetInputMediaType(audio)",
        ) {
            return None;
        }

        Some(audio_stream_index)
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

impl MfEncoder {
    /// Initializes the sink writer. Returns None on failure (stderr already
    /// carries the `ERROR: <label> failed (hr=...)` line). The argument list
    /// mirrors the C++ MFEncoder::initialize signature.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        output_path: &str,
        width: i32,
        height: i32,
        fps: i32,
        bitrate: i32,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        audio_format: Option<&crate::audio::format::AudioFormat>,
    ) -> Option<Self> {
        let width = (width.max(2) / 2) * 2;
        let height = (height.max(2) / 2) * 2;
        let fps = fps.max(1);

        // SAFETY: MF init + media-type/sink-writer construction, attribute
        // values identical to the C++ (H264 out, RGB32 in, stride, PAR, rate).
        unsafe {
            if !check(MFStartup(MF_VERSION, MFSTARTUP_FULL), "MFStartup") {
                return None;
            }

            let output_type = match MFCreateMediaType() {
                Ok(t) => t,
                Err(e) => {
                    eprint_hr("MFCreateMediaType(output)", e.code());
                    return None;
                }
            };
            let _ = output_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video);
            let _ = output_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264);
            let _ = output_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate.max(1) as u32);
            let _ =
                output_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32);
            let _ = output_type.SetUINT64(&MF_MT_FRAME_SIZE, pack_u64(width as u32, height as u32));
            let _ = output_type.SetUINT64(&MF_MT_FRAME_RATE, pack_u64(fps as u32, 1));
            let _ = output_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u64(1, 1));

            let wide_path = to_wide(output_path);
            let sink_writer =
                match MFCreateSinkWriterFromURL(PCWSTR(wide_path.as_ptr()), None, None) {
                    Ok(w) => w,
                    Err(e) => {
                        eprint_hr("MFCreateSinkWriterFromURL", e.code());
                        return None;
                    }
                };
            let video_stream_index = match sink_writer.AddStream(&output_type) {
                Ok(i) => i,
                Err(e) => {
                    eprint_hr("AddStream", e.code());
                    return None;
                }
            };

            // Audio stream is configured between the video AddStream and the
            // video input type, matching mf_encoder.cpp:124-132.
            let audio_stream_index = match audio_format {
                Some(format) => match configure_audio_stream(&sink_writer, format) {
                    Some(index) => Some(index),
                    None => return None,
                },
                None => None,
            };

            let input_type = match MFCreateMediaType() {
                Ok(t) => t,
                Err(e) => {
                    eprint_hr("MFCreateMediaType(input)", e.code());
                    return None;
                }
            };
            let _ = input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video);
            let _ = input_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32);
            let _ =
                input_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32);
            let _ = input_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, (width * 4) as u32);
            let _ = input_type.SetUINT64(&MF_MT_FRAME_SIZE, pack_u64(width as u32, height as u32));
            let _ = input_type.SetUINT64(&MF_MT_FRAME_RATE, pack_u64(fps as u32, 1));
            let _ = input_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u64(1, 1));

            if !check(
                sink_writer.SetInputMediaType(video_stream_index, &input_type, None),
                "SetInputMediaType",
            ) {
                return None;
            }
            if !check(sink_writer.BeginWriting(), "BeginWriting") {
                return None;
            }

            Some(Self {
                width,
                height,
                state: Mutex::new(WriterState {
                    sink_writer: Some(sink_writer),
                    video_stream_index,
                    audio_stream_index,
                    staging_texture: None,
                    device: Some(device.clone()),
                    context: Some(context.clone()),
                    timing: crate::timing::EncoderTiming::new(fps),
                    finalized: false,
                }),
            })
        }
    }

    /// Copies the frame through a staging texture into `destination`
    /// (RowPitch-aware). Mirrors copyFrameToBuffer (mf_encoder.cpp:224-258).
    fn copy_frame_to_buffer(
        state: &mut WriterState,
        width: i32,
        height: i32,
        texture: &ID3D11Texture2D,
        destination: &mut [u8],
    ) -> bool {
        let (Some(device), Some(context)) = (state.device.clone(), state.context.clone()) else {
            return false;
        };

        // SAFETY: staging-texture creation + map/copy sequence identical to
        // the C++; the mapped pointer is only read within this scope.
        unsafe {
            if state.staging_texture.is_none() {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                texture.GetDesc(&mut desc);
                desc.Width = width as u32;
                desc.Height = height as u32;
                desc.MipLevels = 1;
                desc.ArraySize = 1;
                desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
                desc.SampleDesc.Count = 1;
                desc.SampleDesc.Quality = 0;
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                desc.MiscFlags = 0;
                let mut staging: Option<ID3D11Texture2D> = None;
                if let Err(e) = device.CreateTexture2D(&desc, None, Some(&mut staging)) {
                    eprint_hr("CreateTexture2D(staging)", e.code());
                    return false;
                }
                let Some(_) = staging.as_ref() else {
                    eprint_hr("CreateTexture2D(staging)", HRESULT(-1));
                    return false;
                };
                state.staging_texture = staging;
            }
            let staging = state.staging_texture.as_ref().unwrap();

            context.CopyResource(staging, texture);

            let mut mapped =
                windows::Win32::Graphics::Direct3D11::D3D11_MAPPED_SUBRESOURCE::default();
            if let Err(e) = context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) {
                eprint_hr("Map", e.code());
                return false;
            }

            let row_bytes = (width * 4) as usize;
            let required = row_bytes * height as usize;
            if destination.len() < required {
                context.Unmap(staging, 0);
                eprintln!("ERROR: Media Foundation buffer is too small");
                return false;
            }

            let source = mapped.pData.cast::<u8>();
            for y in 0..height as usize {
                let src = source.add(mapped.RowPitch as usize * y);
                std::ptr::copy_nonoverlapping(
                    src,
                    destination.as_mut_ptr().add(row_bytes * y),
                    row_bytes,
                );
            }

            context.Unmap(staging, 0);
        }
        true
    }

    /// Nearest-neighbor copy of a BGRA frame into the encoder-sized buffer,
    /// alpha forced 255 — copyBgraFrameToBuffer (mf_encoder.cpp:260-297).
    fn copy_bgra_frame_to_buffer(
        frame: &crate::pip::BgraFrame<'_>,
        width: i32,
        height: i32,
        destination: &mut [u8],
    ) -> bool {
        if frame.data.is_empty() || frame.width <= 0 || frame.height <= 0 {
            return false;
        }

        let row_bytes = (width * 4) as usize;
        let required = row_bytes * height as usize;
        if destination.len() < required {
            eprintln!("ERROR: Media Foundation webcam buffer is too small");
            return false;
        }

        if frame.width == width && frame.height == height {
            let mut i = 0;
            while i < required {
                destination[i] = frame.data[i];
                destination[i + 1] = frame.data[i + 1];
                destination[i + 2] = frame.data[i + 2];
                destination[i + 3] = 255;
                i += 4;
            }
            return true;
        }

        for y in 0..height {
            let source_y = ((i64::from(y) * i64::from(frame.height)) / i64::from(height)) as i32;
            let dest_row = row_bytes * y as usize;
            for x in 0..width {
                let source_x = ((i64::from(x) * i64::from(frame.width)) / i64::from(width)) as i32;
                let src = ((source_y * frame.width + source_x) * 4) as usize;
                let dst = dest_row + (x * 4) as usize;
                destination[dst] = frame.data[src];
                destination[dst + 1] = frame.data[src + 1];
                destination[dst + 2] = frame.data[src + 2];
                destination[dst + 3] = 255;
            }
        }

        true
    }

    /// Writes one video frame, compositing the PiP webcam overlay when given
    /// (compositeWebcam runs after the staging copy, mf_encoder.cpp:252-254).
    /// Timestamps get the encoder-side latch + bump layer on top of what the
    /// writer thread already computed — both layers exist in the C++ and are
    /// kept.
    pub fn write_frame(
        &self,
        texture: &ID3D11Texture2D,
        timestamp_hns: i64,
        webcam: Option<&crate::pip::BgraFrame<'_>>,
    ) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Synthetic fault injection (test-only, env-gated): reproduce issue #14
        // by blocking forever on the first write_frame while holding the writer
        // mutex, just like a hung WriteSample. Checked once.
        static FAULT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        let fault = *FAULT.get_or_init(|| {
            std::env::var("CLOSESCREEN_WGC_FAULT_HANG_FIRST_FRAME").as_deref() == Ok("1")
        });
        if fault {
            eprintln!(
                "[fault] CLOSESCREEN_WGC_FAULT_HANG_FIRST_FRAME set; blocking writeFrame forever"
            );
            std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
        }

        if state.sink_writer.is_none() || state.finalized {
            return false;
        }

        let sample_time = state.timing.sample_time(timestamp_hns);
        let sample_duration = state.timing.sample_duration();

        let frame_bytes = (self.width * self.height * 4) as u32;
        // SAFETY: MF buffer lock/copy/unlock + sample write, mirroring the C++.
        unsafe {
            let buffer = match MFCreateMemoryBuffer(frame_bytes) {
                Ok(b) => b,
                Err(e) => {
                    eprint_hr("MFCreateMemoryBuffer", e.code());
                    return false;
                }
            };
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut max_length = 0u32;
            if let Err(e) = buffer.Lock(&mut data, Some(&mut max_length), None) {
                eprint_hr("IMFMediaBuffer::Lock", e.code());
                return false;
            }
            let destination = std::slice::from_raw_parts_mut(data, max_length as usize);
            let copied = Self::copy_frame_to_buffer(
                &mut state,
                self.width,
                self.height,
                texture,
                destination,
            );
            if copied && let Some(webcam) = webcam {
                crate::pip::composite_webcam(destination, self.width, self.height, webcam);
            }
            let _ = buffer.Unlock();
            if !copied {
                return false;
            }
            let _ = buffer.SetCurrentLength(frame_bytes);

            let sample = match MFCreateSample() {
                Ok(s) => s,
                Err(e) => {
                    eprint_hr("MFCreateSample", e.code());
                    return false;
                }
            };
            let _ = sample.AddBuffer(&buffer);
            let _ = sample.SetSampleTime(sample_time);
            let _ = sample.SetSampleDuration(sample_duration);

            let stream_index = state.video_stream_index;
            check(
                state
                    .sink_writer
                    .as_ref()
                    .unwrap()
                    .WriteSample(stream_index, &sample),
                "WriteSample",
            )
        }
    }

    /// Writes one CPU-side BGRA frame (the separate webcam file) —
    /// writeBgraFrame (mf_encoder.cpp:360-406). Same timing latch as
    /// write_frame; a separate MfEncoder instance means a separate latch,
    /// exactly like the second C++ MFEncoder. Deliberately NO fault
    /// injection: the C++ writeBgraFrame has no fault check, so under
    /// fault+webcam the webcam frame lands BEFORE the screen write hangs.
    pub fn write_bgra_frame(&self, frame: &crate::pip::BgraFrame<'_>, timestamp_hns: i64) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.sink_writer.is_none() || state.finalized {
            return false;
        }

        let sample_time = state.timing.sample_time(timestamp_hns);
        let sample_duration = state.timing.sample_duration();

        let frame_bytes = (self.width * self.height * 4) as u32;
        // SAFETY: MF buffer lock/copy/unlock + sample write, mirroring the
        // C++ writeBgraFrame.
        unsafe {
            let buffer = match MFCreateMemoryBuffer(frame_bytes) {
                Ok(b) => b,
                Err(e) => {
                    eprint_hr("MFCreateMemoryBuffer(webcam)", e.code());
                    return false;
                }
            };
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut max_length = 0u32;
            if let Err(e) = buffer.Lock(&mut data, Some(&mut max_length), None) {
                eprint_hr("IMFMediaBuffer::Lock(webcam)", e.code());
                return false;
            }
            let destination = std::slice::from_raw_parts_mut(data, max_length as usize);
            let copied =
                Self::copy_bgra_frame_to_buffer(frame, self.width, self.height, destination);
            let _ = buffer.Unlock();
            if !copied {
                return false;
            }
            let _ = buffer.SetCurrentLength(frame_bytes);

            let sample = match MFCreateSample() {
                Ok(s) => s,
                Err(e) => {
                    eprint_hr("MFCreateSample(webcam)", e.code());
                    return false;
                }
            };
            let _ = sample.AddBuffer(&buffer);
            let _ = sample.SetSampleTime(sample_time);
            let _ = sample.SetSampleDuration(sample_duration);

            let stream_index = state.video_stream_index;
            check(
                state
                    .sink_writer
                    .as_ref()
                    .unwrap()
                    .WriteSample(stream_index, &sample),
                "WriteSample(webcam)",
            )
        }
    }

    /// Writes one audio sample. Skip conditions and success semantics mirror
    /// writeAudio (mf_encoder.cpp:408-447): missing stream → false; empty or
    /// non-positive-duration payloads → true (skipped, not an error).
    pub fn write_audio(&self, data: &[u8], timestamp_hns: i64, duration_hns: i64) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.sink_writer.is_none() || state.finalized {
            return false;
        }
        let Some(audio_stream_index) = state.audio_stream_index else {
            return false;
        };
        if data.is_empty() || duration_hns <= 0 {
            return true;
        }

        // SAFETY: MF buffer/sample construction mirroring the C++ writeAudio.
        unsafe {
            let buffer = match MFCreateMemoryBuffer(data.len() as u32) {
                Ok(b) => b,
                Err(e) => {
                    eprint_hr("MFCreateMemoryBuffer(audio)", e.code());
                    return false;
                }
            };
            let mut destination: *mut u8 = std::ptr::null_mut();
            let mut max_length = 0u32;
            if let Err(e) = buffer.Lock(&mut destination, Some(&mut max_length), None) {
                eprint_hr("IMFMediaBuffer::Lock(audio)", e.code());
                return false;
            }
            if (max_length as usize) < data.len() {
                let _ = buffer.Unlock();
                eprintln!("ERROR: Media Foundation audio buffer is too small");
                return false;
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), destination, data.len());
            let _ = buffer.Unlock();
            let _ = buffer.SetCurrentLength(data.len() as u32);

            let sample = match MFCreateSample() {
                Ok(s) => s,
                Err(e) => {
                    eprint_hr("MFCreateSample(audio)", e.code());
                    return false;
                }
            };
            let _ = sample.AddBuffer(&buffer);
            let _ = sample.SetSampleTime(timestamp_hns.max(0));
            let _ = sample.SetSampleDuration(duration_hns);

            check(
                state
                    .sink_writer
                    .as_ref()
                    .unwrap()
                    .WriteSample(audio_stream_index, &sample),
                "WriteSample(audio)",
            )
        }
    }

    /// Finalizes the MP4. Idempotent; mirrors finalize (mf_encoder.cpp:449-466).
    pub fn finalize(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.finalized {
            return true;
        }
        state.finalized = true;
        let mut ok = true;
        if let Some(writer) = state.sink_writer.take() {
            // SAFETY: final sink-writer call; writer is dropped right after.
            ok = check(unsafe { writer.Finalize() }, "SinkWriter::Finalize");
        }
        state.staging_texture = None;
        state.context = None;
        state.device = None;
        // SAFETY: paired with the MFStartup in initialize().
        let _ = unsafe { MFShutdown() };
        ok
    }
}

impl Drop for MfEncoder {
    fn drop(&mut self) {
        self.finalize();
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    use windows::Win32::Foundation::{HMODULE, RPC_E_CHANGED_MODE, S_FALSE, S_OK};
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
        ID3D11DeviceContext,
    };
    use windows::Win32::Media::MediaFoundation::{
        MF_E_INVALIDSTREAMNUMBER, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
        MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
        MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
        MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
        MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READERF_ENDOFSTREAM,
        MF_SOURCE_READERF_ERROR, MF_VERSION, MFAudioFormat_AAC, MFAudioFormat_PCM,
        MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Audio, MFMediaType_Video,
        MFSTARTUP_FULL, MFShutdown, MFStartup,
    };
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
    use windows::core::PCWSTR;

    use super::*;
    use crate::audio::format::{AudioFormat, AudioSubtype};
    use crate::pip::BgraFrame;

    const WIDTH: i32 = 64;
    const HEIGHT: i32 = 64;
    const FPS: i32 = 30;
    const SAMPLE_RATE: u64 = 48_000;
    const AUDIO_FRAMES: u64 = 48_123;
    const HNS_PER_SECOND: u64 = 10_000_000;
    static MF_TEST_LOCK: Mutex<()> = Mutex::new(());
    static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

    struct ComGuard {
        uninitialize: bool,
    }

    impl ComGuard {
        fn initialize() -> Self {
            // SAFETY: this test owns the matching CoUninitialize only for
            // S_OK/S_FALSE. RPC_E_CHANGED_MODE means the runner already
            // initialized the apartment, which remains usable but is not ours.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            assert!(
                hr == S_OK || hr == S_FALSE || hr == RPC_E_CHANGED_MODE,
                "CoInitializeEx failed: {hr:?}"
            );
            Self {
                uninitialize: hr == S_OK || hr == S_FALSE,
            }
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.uninitialize {
                // SAFETY: paired with this guard's successful CoInitializeEx.
                unsafe { CoUninitialize() };
            }
        }
    }

    struct MfGuard;

    impl MfGuard {
        fn initialize() -> Self {
            // Keep one process-level MF reference alive while individual
            // encoders pair their own startup/shutdown and SourceReader
            // validates finalized files.
            // SAFETY: balanced by MfGuard::drop.
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }
                .expect("outer MFStartup for encoder regression");
            Self
        }
    }

    impl Drop for MfGuard {
        fn drop(&mut self) {
            // SAFETY: paired with MfGuard::initialize.
            let _ = unsafe { MFShutdown() };
        }
    }

    struct TempArtifacts(Vec<PathBuf>);

    impl TempArtifacts {
        fn new() -> Self {
            Self(Vec::new())
        }

        fn path(&mut self, label: &str) -> PathBuf {
            let id = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "closescreen-mf-encoder-{label}-{}-{id}.mp4",
                std::process::id()
            ));
            self.0.push(path.clone());
            path
        }
    }

    impl Drop for TempArtifacts {
        fn drop(&mut self) {
            for path in &self.0 {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn warp_device() -> (ID3D11Device, ID3D11DeviceContext) {
        let feature_levels = [D3D_FEATURE_LEVEL_11_0];
        let mut device = None;
        let mut context = None;
        let mut selected_level = D3D_FEATURE_LEVEL::default();
        // SAFETY: standard WARP device creation with initialized out-params.
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&feature_levels),
                D3D11_SDK_VERSION,
                Some(&raw mut device),
                Some(&raw mut selected_level),
                Some(&raw mut context),
            )
        }
        .expect("D3D11CreateDevice(WARP)");
        (
            device.expect("WARP device"),
            context.expect("WARP device context"),
        )
    }

    fn pcm_format() -> AudioFormat {
        AudioFormat {
            subtype: AudioSubtype::Pcm,
            sample_rate: SAMPLE_RATE as u32,
            channels: 2,
            bits_per_sample: 16,
            block_align: 4,
            avg_bytes_per_sec: SAMPLE_RATE as u32 * 4,
        }
    }

    fn write_synthetic_mp4(
        path: &Path,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        with_audio: bool,
    ) {
        let path_string = path.to_string_lossy();
        let audio_format = pcm_format();
        let encoder = MfEncoder::initialize(
            &path_string,
            WIDTH,
            HEIGHT,
            FPS,
            500_000,
            device,
            context,
            with_audio.then_some(&audio_format),
        )
        .expect("initialize synthetic MF encoder");

        let mut pixels = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.copy_from_slice(&[32, 96, 192, 255]);
        }
        let frame = BgraFrame {
            data: &pixels,
            width: WIDTH,
            height: HEIGHT,
        };
        for index in 0..31i64 {
            assert!(
                encoder.write_bgra_frame(&frame, index * HNS_PER_SECOND as i64 / i64::from(FPS)),
                "write synthetic video frame {index}"
            );
        }

        if with_audio {
            let mut written_frames = 0u64;
            while written_frames < AUDIO_FRAMES {
                let chunk_frames = (AUDIO_FRAMES - written_frames).min(480);
                let mut pcm = Vec::with_capacity(chunk_frames as usize * 4);
                for frame_index in written_frames..written_frames + chunk_frames {
                    let phase =
                        std::f64::consts::TAU * 997.0 * frame_index as f64 / SAMPLE_RATE as f64;
                    let sample = (phase.sin() * 10_000.0) as i16;
                    pcm.extend_from_slice(&sample.to_le_bytes());
                    pcm.extend_from_slice(&sample.to_le_bytes());
                }
                let start_hns = (written_frames * HNS_PER_SECOND / SAMPLE_RATE) as i64;
                let end_frames = written_frames + chunk_frames;
                let end_hns = (end_frames * HNS_PER_SECOND / SAMPLE_RATE) as i64;
                assert!(
                    encoder.write_audio(&pcm, start_hns, end_hns - start_hns),
                    "write synthetic audio at frame {written_frames}"
                );
                written_frames = end_frames;
            }
        }

        assert!(encoder.finalize(), "finalize synthetic MP4");
        drop(encoder);
    }

    fn source_reader(path: &Path) -> windows::Win32::Media::MediaFoundation::IMFSourceReader {
        let wide = to_wide(&path.to_string_lossy());
        // SAFETY: NUL-terminated path stays alive for the call; no attributes.
        unsafe { MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), None) }
            .expect("open finalized MP4 with SourceReader")
    }

    fn assert_decodable_aac(path: &Path) {
        let reader = source_reader(path);
        let audio_stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        // SAFETY: synchronous SourceReader calls with valid stream constants.
        unsafe {
            let native = reader
                .GetNativeMediaType(audio_stream, 0)
                .expect("native AAC media type");
            assert_eq!(
                native.GetGUID(&MF_MT_MAJOR_TYPE).expect("audio major type"),
                MFMediaType_Audio
            );
            assert_eq!(
                native.GetGUID(&MF_MT_SUBTYPE).expect("audio subtype"),
                MFAudioFormat_AAC
            );

            reader
                .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
                .expect("deselect source streams");
            reader
                .SetStreamSelection(audio_stream, true)
                .expect("select audio stream");

            let pcm = MFCreateMediaType().expect("PCM decode media type");
            pcm.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                .expect("PCM major type");
            pcm.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
                .expect("PCM subtype");
            pcm.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)
                .expect("PCM channels");
            pcm.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, SAMPLE_RATE as u32)
                .expect("PCM sample rate");
            pcm.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
                .expect("PCM bits");
            pcm.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)
                .expect("PCM block alignment");
            pcm.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, SAMPLE_RATE as u32 * 4)
                .expect("PCM byte rate");
            pcm.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)
                .expect("PCM independent samples");
            reader
                .SetCurrentMediaType(audio_stream, None, &pcm)
                .expect("configure AAC decoder");

            let mut decoded_samples = 0usize;
            let mut decoded_bytes = 0u64;
            for _ in 0..10_000 {
                let mut flags = 0u32;
                let mut sample = None;
                reader
                    .ReadSample(
                        audio_stream,
                        0,
                        None,
                        Some(&raw mut flags),
                        None,
                        Some(&raw mut sample),
                    )
                    .expect("decode AAC sample");
                assert_eq!(
                    flags & MF_SOURCE_READERF_ERROR.0 as u32,
                    0,
                    "SourceReader reported an audio decode error"
                );
                if let Some(sample) = sample {
                    decoded_samples += 1;
                    decoded_bytes += sample.GetTotalLength().expect("decoded PCM length") as u64;
                }
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    assert!(decoded_samples > 0, "no decoded AAC samples");
                    assert!(
                        decoded_bytes >= AUDIO_FRAMES * 4,
                        "decoded PCM tail was truncated: {decoded_bytes} bytes"
                    );
                    assert_eq!(decoded_bytes % 4, 0, "partial stereo PCM frame");
                    return;
                }
            }
        }
        panic!("SourceReader did not reach audio end-of-stream");
    }

    fn assert_video_only(path: &Path) {
        let reader = source_reader(path);
        // SAFETY: native media-type queries do not retain borrowed pointers.
        unsafe {
            let video = reader
                .GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0)
                .expect("video-only artifact has a video stream");
            assert_eq!(
                video.GetGUID(&MF_MT_MAJOR_TYPE).expect("video major type"),
                MFMediaType_Video
            );
            let error = reader
                .GetNativeMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, 0)
                .expect_err("video-only artifact unexpectedly has audio");
            assert_eq!(error.code(), MF_E_INVALIDSTREAMNUMBER);
        }
    }

    #[test]
    fn finalization_flushes_non_aligned_aac_tail_and_preserves_no_audio_mode() {
        let _serial = MF_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _com = ComGuard::initialize();
        let _mf = MfGuard::initialize();
        let mut artifacts = TempArtifacts::new();
        let with_audio = artifacts.path("audio");
        let video_only = artifacts.path("video-only");
        let (device, context) = warp_device();

        write_synthetic_mp4(&with_audio, &device, &context, true);
        write_synthetic_mp4(&video_only, &device, &context, false);
        assert_decodable_aac(&with_audio);
        assert_video_only(&video_only);
    }
}
