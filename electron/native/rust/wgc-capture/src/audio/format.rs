//! Audio format descriptor — port of AudioInputFormat (mf_encoder.h) with
//! the MF subtype reduced to the two variants the pipeline supports.

use windows::Win32::Media::MediaFoundation::{MFAudioFormat_Float, MFAudioFormat_PCM};
use windows::core::GUID;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioSubtype {
    Float,
    Pcm,
}

impl AudioSubtype {
    pub fn to_guid(self) -> GUID {
        match self {
            AudioSubtype::Float => MFAudioFormat_Float,
            AudioSubtype::Pcm => MFAudioFormat_PCM,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioFormat {
    pub subtype: AudioSubtype,
    pub sample_rate: u32,
    pub channels: u32,
    pub bits_per_sample: u32,
    pub block_align: u32,
    pub avg_bytes_per_sec: u32,
}

impl AudioFormat {
    pub fn is_float(&self) -> bool {
        self.subtype == AudioSubtype::Float && self.bits_per_sample == 32
    }

    pub fn is_pcm(&self, bits: u32) -> bool {
        self.subtype == AudioSubtype::Pcm && self.bits_per_sample == bits
    }
}

/// makeAacCompatibleAudioFormat (audio_sample_utils.cpp:103-112).
pub fn make_aac_compatible(source: &AudioFormat) -> AudioFormat {
    let sample_rate = if source.sample_rate > 0 {
        source.sample_rate
    } else {
        48000
    };
    let channels = 2u32;
    let bits = 16u32;
    let block_align = channels * (bits / 8);
    AudioFormat {
        subtype: AudioSubtype::Pcm,
        sample_rate,
        channels,
        bits_per_sample: bits,
        block_align,
        avg_bytes_per_sec: sample_rate * block_align,
    }
}

/// sameAudioFormatForMixing — all six fields equal.
pub fn same_format_for_mixing(left: &AudioFormat, right: &AudioFormat) -> bool {
    left == right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aac_compatible_derivation() {
        let src = AudioFormat {
            subtype: AudioSubtype::Float,
            sample_rate: 44100,
            channels: 6,
            bits_per_sample: 32,
            block_align: 24,
            avg_bytes_per_sec: 44100 * 24,
        };
        let aac = make_aac_compatible(&src);
        assert_eq!(aac.subtype, AudioSubtype::Pcm);
        assert_eq!(aac.sample_rate, 44100);
        assert_eq!(aac.channels, 2);
        assert_eq!(aac.bits_per_sample, 16);
        assert_eq!(aac.block_align, 4);
        assert_eq!(aac.avg_bytes_per_sec, 44100 * 4);
        // Zero rate falls back to 48k.
        let zero = AudioFormat {
            sample_rate: 0,
            ..src
        };
        assert_eq!(make_aac_compatible(&zero).sample_rate, 48000);
    }
}
