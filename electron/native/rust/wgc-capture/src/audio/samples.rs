//! Pure sample math — verbatim port of audio_sample_utils.cpp's free
//! functions. Everything here operates on byte slices so the arithmetic
//! stays under unit test with synthesized fixtures.

use super::format::{AudioFormat, same_format_for_mixing};

fn bytes_per_sample(format: &AudioFormat) -> usize {
    (format.bits_per_sample / 8) as usize
}

fn clamp_round_i16(value: f64) -> i16 {
    value
        .round()
        .clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
}

fn clamp_round_i32(value: f64) -> i32 {
    value
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn read_sample_as_f64(
    source: &[u8],
    format: &AudioFormat,
    frame_index: usize,
    channel_index: u32,
) -> f64 {
    if format.block_align == 0 || channel_index >= format.channels {
        return 0.0;
    }
    let offset = frame_index * format.block_align as usize
        + channel_index as usize * bytes_per_sample(format);
    if format.is_float() {
        let Some(bytes) = source.get(offset..offset + 4) else {
            return 0.0;
        };
        f64::from(f32::from_le_bytes(bytes.try_into().unwrap()))
    } else if format.is_pcm(16) {
        let Some(bytes) = source.get(offset..offset + 2) else {
            return 0.0;
        };
        f64::from(i16::from_le_bytes(bytes.try_into().unwrap())) / 32768.0
    } else if format.is_pcm(32) {
        let Some(bytes) = source.get(offset..offset + 4) else {
            return 0.0;
        };
        f64::from(i32::from_le_bytes(bytes.try_into().unwrap())) / 2147483648.0
    } else {
        0.0
    }
}

fn write_sample_from_f64(
    destination: &mut [u8],
    format: &AudioFormat,
    frame_index: usize,
    channel_index: u32,
    value: f64,
) {
    if format.block_align == 0 || channel_index >= format.channels {
        return;
    }
    let clamped = value.clamp(-1.0, 1.0);
    let offset = frame_index * format.block_align as usize
        + channel_index as usize * bytes_per_sample(format);
    if format.is_float() {
        if let Some(bytes) = destination.get_mut(offset..offset + 4) {
            bytes.copy_from_slice(&(clamped as f32).to_le_bytes());
        }
    } else if format.is_pcm(16) {
        if let Some(bytes) = destination.get_mut(offset..offset + 2) {
            bytes.copy_from_slice(&clamp_round_i16(clamped * 32767.0).to_le_bytes());
        }
    } else if format.is_pcm(32)
        && let Some(bytes) = destination.get_mut(offset..offset + 4)
    {
        bytes.copy_from_slice(&clamp_round_i32(clamped * 2147483647.0).to_le_bytes());
    }
}

/// readMappedChannel (audio_sample_utils.cpp:70-88).
fn read_mapped_channel(
    source: &[u8],
    format: &AudioFormat,
    frame_index: usize,
    target_channel: u32,
    target_channels: u32,
) -> f64 {
    if format.channels == 0 {
        return 0.0;
    }
    if format.channels == target_channels && target_channel < format.channels {
        return read_sample_as_f64(source, format, frame_index, target_channel);
    }
    if format.channels == 1 {
        return read_sample_as_f64(source, format, frame_index, 0);
    }
    if target_channels == 1 {
        let mut sum = 0.0;
        for channel in 0..format.channels {
            sum += read_sample_as_f64(source, format, frame_index, channel);
        }
        return sum / f64::from(format.channels);
    }
    read_sample_as_f64(
        source,
        format,
        frame_index,
        target_channel.min(format.channels - 1),
    )
}

/// copyAudioWithGain: near-unity gain short-circuits to a straight copy; the
/// integer paths scale the RAW sample value (no normalize round-trip).
pub fn copy_audio_with_gain(
    source: &[u8],
    format: &AudioFormat,
    gain: f64,
    destination: &mut Vec<u8>,
) {
    destination.resize(source.len(), 0);
    if source.is_empty() {
        return;
    }
    if (gain - 1.0).abs() < 0.0001 {
        destination.copy_from_slice(source);
        return;
    }

    if format.is_float() {
        for (dst, src) in destination.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
            let v = f64::from(f32::from_le_bytes(src.try_into().unwrap()));
            dst.copy_from_slice(&((v * gain).clamp(-1.0, 1.0) as f32).to_le_bytes());
        }
    } else if format.is_pcm(16) {
        for (dst, src) in destination.chunks_exact_mut(2).zip(source.chunks_exact(2)) {
            let v = f64::from(i16::from_le_bytes(src.try_into().unwrap()));
            dst.copy_from_slice(&clamp_round_i16(v * gain).to_le_bytes());
        }
    } else if format.is_pcm(32) {
        for (dst, src) in destination.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
            let v = f64::from(i32::from_le_bytes(src.try_into().unwrap()));
            dst.copy_from_slice(&clamp_round_i32(v * gain).to_le_bytes());
        }
    } else {
        destination.copy_from_slice(source);
    }
}

/// convertAudioWithGain: same-format short-circuit, else nearest-frame
/// resample with channel mapping (audio_sample_utils.cpp:164-209).
pub fn convert_audio_with_gain(
    source: &[u8],
    source_format: &AudioFormat,
    target_format: &AudioFormat,
    gain: f64,
    destination: &mut Vec<u8>,
) {
    if source.is_empty()
        || source_format.block_align == 0
        || target_format.block_align == 0
        || source_format.sample_rate == 0
        || target_format.sample_rate == 0
        || source_format.channels == 0
        || target_format.channels == 0
    {
        destination.clear();
        return;
    }

    if same_format_for_mixing(source_format, target_format) {
        copy_audio_with_gain(source, target_format, gain, destination);
        return;
    }

    let source_frames = source.len() / source_format.block_align as usize;
    if source_frames == 0 {
        destination.clear();
        return;
    }

    let rate_ratio = f64::from(target_format.sample_rate) / f64::from(source_format.sample_rate);
    let target_frames = ((source_frames as f64 * rate_ratio).round() as usize).max(1);
    destination.clear();
    destination.resize(target_frames * target_format.block_align as usize, 0);

    for target_frame in 0..target_frames {
        let source_position = target_frame as f64 / rate_ratio;
        let source_frame = (source_position.round() as usize).min(source_frames - 1);
        for channel in 0..target_format.channels {
            let sample = read_mapped_channel(
                source,
                source_format,
                source_frame,
                channel,
                target_format.channels,
            );
            write_sample_from_f64(
                destination,
                target_format,
                target_frame,
                channel,
                sample * gain,
            );
        }
    }
}

/// mixAudioInPlace: saturating in-place add over min(dest, source) bytes.
pub fn mix_audio_in_place(destination: &mut [u8], source: &[u8], format: &AudioFormat) {
    if source.is_empty() || destination.is_empty() {
        return;
    }
    let mix_bytes = destination.len().min(source.len());

    if format.is_float() {
        for (dst, src) in destination[..mix_bytes]
            .chunks_exact_mut(4)
            .zip(source[..mix_bytes].chunks_exact(4))
        {
            let a = f32::from_le_bytes(dst[..4].try_into().unwrap());
            let b = f32::from_le_bytes(src.try_into().unwrap());
            dst.copy_from_slice(&(a + b).clamp(-1.0, 1.0).to_le_bytes());
        }
    } else if format.is_pcm(16) {
        for (dst, src) in destination[..mix_bytes]
            .chunks_exact_mut(2)
            .zip(source[..mix_bytes].chunks_exact(2))
        {
            let a = f64::from(i16::from_le_bytes(dst[..2].try_into().unwrap()));
            let b = f64::from(i16::from_le_bytes(src.try_into().unwrap()));
            dst.copy_from_slice(&clamp_round_i16(a + b).to_le_bytes());
        }
    } else if format.is_pcm(32) {
        for (dst, src) in destination[..mix_bytes]
            .chunks_exact_mut(4)
            .zip(source[..mix_bytes].chunks_exact(4))
        {
            let a = f64::from(i32::from_le_bytes(dst[..4].try_into().unwrap()));
            let b = f64::from(i32::from_le_bytes(src.try_into().unwrap()));
            dst.copy_from_slice(&clamp_round_i32(a + b).to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::format::AudioSubtype;
    use super::*;

    fn f32_format(rate: u32, channels: u32) -> AudioFormat {
        AudioFormat {
            subtype: AudioSubtype::Float,
            sample_rate: rate,
            channels,
            bits_per_sample: 32,
            block_align: channels * 4,
            avg_bytes_per_sec: rate * channels * 4,
        }
    }

    fn s16_format(rate: u32, channels: u32) -> AudioFormat {
        AudioFormat {
            subtype: AudioSubtype::Pcm,
            sample_rate: rate,
            channels,
            bits_per_sample: 16,
            block_align: channels * 2,
            avg_bytes_per_sec: rate * channels * 2,
        }
    }

    fn f32_bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    fn s16_bytes(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    fn as_s16(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes(c.try_into().unwrap()))
            .collect()
    }

    #[test]
    fn near_unity_gain_is_a_straight_copy() {
        let format = s16_format(48000, 2);
        let source = s16_bytes(&[1000, -1000, 32767, -32768]);
        let mut out = Vec::new();
        copy_audio_with_gain(&source, &format, 1.00005, &mut out);
        assert_eq!(out, source);
    }

    #[test]
    fn integer_gain_scales_and_saturates() {
        let format = s16_format(48000, 1);
        let source = s16_bytes(&[1000, -1000, 30000]);
        let mut out = Vec::new();
        copy_audio_with_gain(&source, &format, 2.0, &mut out);
        assert_eq!(as_s16(&out), vec![2000, -2000, 32767]); // 60000 saturates
    }

    #[test]
    fn float_gain_clamps_to_unit_range() {
        let format = f32_format(48000, 1);
        let source = f32_bytes(&[0.4, -0.9]);
        let mut out = Vec::new();
        copy_audio_with_gain(&source, &format, 2.0, &mut out);
        let vals: Vec<f32> = out
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        assert_eq!(vals, vec![0.8, -1.0]);
    }

    #[test]
    fn convert_float_stereo_to_s16_stereo_same_rate() {
        let src_fmt = f32_format(48000, 2);
        let dst_fmt = s16_format(48000, 2);
        let source = f32_bytes(&[0.5, -0.5, 1.0, -1.0]);
        let mut out = Vec::new();
        convert_audio_with_gain(&source, &src_fmt, &dst_fmt, 1.0, &mut out);
        assert_eq!(as_s16(&out), vec![16384, -16384, 32767, -32767]);
    }

    #[test]
    fn convert_mono_to_stereo_duplicates_channel_zero() {
        let src_fmt = s16_format(48000, 1);
        let dst_fmt = s16_format(48000, 2);
        let source = s16_bytes(&[100, 200]);
        let mut out = Vec::new();
        convert_audio_with_gain(&source, &src_fmt, &dst_fmt, 1.0, &mut out);
        // Round-trip through the f64 normalize (v/32768 → round(v*32767))
        // rounds back to the original for small magnitudes — same as C++.
        assert_eq!(as_s16(&out), vec![100, 100, 200, 200]);
    }

    #[test]
    fn convert_stereo_to_mono_averages() {
        let src_fmt = s16_format(48000, 2);
        let dst_fmt = s16_format(48000, 1);
        let source = s16_bytes(&[1000, 3000]);
        let mut out = Vec::new();
        convert_audio_with_gain(&source, &src_fmt, &dst_fmt, 1.0, &mut out);
        let vals = as_s16(&out);
        assert_eq!(vals.len(), 1);
        assert!((vals[0] - 2000).abs() <= 1);
    }

    #[test]
    fn resample_nearest_frame_44100_to_48000() {
        let src_fmt = s16_format(44100, 1);
        let dst_fmt = s16_format(48000, 1);
        // 441 frames in → round(441 * 48000/44100) = 480 frames out.
        let samples: Vec<i16> = (0..441).map(|i| i as i16).collect();
        let source = s16_bytes(&samples);
        let mut out = Vec::new();
        convert_audio_with_gain(&source, &src_fmt, &dst_fmt, 1.0, &mut out);
        let vals = as_s16(&out);
        assert_eq!(vals.len(), 480);
        // Nearest-frame mapping: target frame 479 → round(479/ (48000/44100)) = 440.
        // Values round-trip through the f64 normalize with ≤1 LSB shave.
        assert!((vals[479] - 440).abs() <= 1);
        assert_eq!(vals[0], 0);
    }

    #[test]
    fn invalid_conversion_clears_destination() {
        let src_fmt = s16_format(0, 1);
        let dst_fmt = s16_format(48000, 1);
        let source = s16_bytes(&[1]);
        let mut out = vec![1u8, 2, 3];
        convert_audio_with_gain(&source, &src_fmt, &dst_fmt, 1.0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn mix_saturates_and_respects_shorter_source() {
        let format = s16_format(48000, 1);
        let mut dest = s16_bytes(&[30000, 100, 50]);
        let source = s16_bytes(&[10000, -300]);
        mix_audio_in_place(&mut dest, &source, &format);
        assert_eq!(as_s16(&dest), vec![32767, -200, 50]);
    }

    #[test]
    fn mix_float_clamps_unit_range() {
        let format = f32_format(48000, 1);
        let mut dest = f32_bytes(&[0.8]);
        let source = f32_bytes(&[0.5]);
        mix_audio_in_place(&mut dest, &source, &format);
        assert_eq!(f32::from_le_bytes(dest[..4].try_into().unwrap()), 1.0);
    }
}
