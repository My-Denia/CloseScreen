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

    /// Writes one video frame. Timestamps get the encoder-side latch + bump
    /// layer on top of what the writer thread already computed — both layers
    /// exist in the C++ and are kept.
    pub fn write_frame(&self, texture: &ID3D11Texture2D, timestamp_hns: i64) -> bool {
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
