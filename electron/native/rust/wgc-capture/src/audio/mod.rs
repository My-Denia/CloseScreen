//! Audio capture pipeline: WASAPI endpoints → per-source conversion →
//! mixer timeline → AAC stream in the MF encoder.

pub mod format;
pub mod mixer;
pub mod samples;
pub mod wasapi;
