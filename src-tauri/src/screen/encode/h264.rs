//! Hardware H.264, on top of the `videotoolbox` crate.
//!
//! This is the codec that makes the screen channel viable on a phone link:
//! JPEG costs tens of kilobytes per frame no matter how little changed, while
//! H.264 costs a few hundred bytes for an idle desktop and is bounded by an
//! explicit bitrate when the screen is busy. It is also the only codec that can
//! carry maximum clarity *and* a high frame rate at the same time.
//!
//! Almost none of this file is VideoToolbox plumbing. The session, its output
//! callback, the frame slot, the blocking `encode`, the AVCC NAL extraction and
//! the parameter-set walk all come from `videotoolbox` and `apple-cf`. What is
//! left is the part specific to this product:
//!
//! * the configuration that makes a *preview* rather than a file encode —
//!   real time, no frame reordering, low-latency rate control,
//! * the `AVCDecoderConfigurationRecord` WebCodecs needs, assembled from the
//!   parameter sets the crate hands back,
//! * and sending that record only when it changes.
//!
//! Three configuration choices matter more than the rest, and all three are
//! about latency rather than size:
//!
//! * `allow_frame_reordering = false` — no B-frames, so decode order is display
//!   order and a frame never waits for a later one.
//! * `real_time = true` — the encoder may spend bits on speed.
//! * a bounded keyframe interval plus an on-demand keyframe, which is what lets
//!   the pipeline repair a viewer that fell behind.
//!
//! One deliberate omission: unlike the JPEG path, this one does **no** change
//! detection. Measuring a change would mean locking the pixel buffer and walking
//! it on the CPU — a couple of milliseconds — to avoid a hardware encode that
//! costs about as much and produces a few hundred bytes for a static screen
//! anyway. Inter-frame compression *is* the change detector.

use std::time::Instant;

use apple_cf::cf::{CFDictionary, CFNumber, CFString};
use apple_cf::cm::CMTime;
use videotoolbox::compression::{CompressionSession, EncodedFrame, FrameProperties, ProfileLevel};
use videotoolbox::error::VTError;
use videotoolbox::session::Codec;

use super::Encoded;
use crate::screen::capture::{Pixels, RawFrame};
use crate::screen::governor_bitrate;

/// Longest keyframe interval before one is forced, in seconds. A late joiner
/// waits at most this long and error propagation stays bounded.
const KEYFRAME_INTERVAL_SECONDS: i32 = 2;

/// `kVTEncodeInfo_FrameDropped`.
const ENCODE_INFO_FRAME_DROPPED: u32 = 1 << 1;

pub struct H264 {
    session: CompressionSession,
    width: u32,
    height: u32,
    bitrate: u32,
    /// A bitrate change not yet pushed to the running session.
    ///
    /// `AverageBitRate` is a property VideoToolbox accepts on a *live* session,
    /// so a governor step does not rebuild the encoder. Rebuilding was the bug:
    /// every step produced new parameter sets and a forced keyframe, which the
    /// viewer reads as a broken reference chain (`resync`) — and the startup
    /// probe steps several times in the first seconds of every session.
    pending_bitrate: Option<u32>,
    /// The configuration record most recently handed to the caller. Re-sending
    /// it only when it changes is what makes `description` optional on the wire.
    description: Option<Vec<u8>>,
    force_keyframe: bool,
    started_at: Instant,
    last_timestamp: i64,
}

impl H264 {
    pub fn new(width: u32, height: u32, bitrate: u32, fps: u32) -> Result<Self, String> {
        let bitrate = bitrate.clamp(150_000, 60_000_000);
        let fps = fps.clamp(1, 120);
        Ok(Self {
            session: build_session(width, height, bitrate, fps)?,
            width,
            height,
            bitrate,
            pending_bitrate: None,
            description: None,
            force_keyframe: true,
            started_at: Instant::now(),
            last_timestamp: -1,
        })
    }

    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The decoder configuration the stream currently needs.
    #[must_use]
    pub fn description(&self) -> Option<Vec<u8>> {
        self.description.clone()
    }

    pub fn set_bitrate(&mut self, bits_per_second: u32) -> Result<(), String> {
        let bits_per_second = bits_per_second.clamp(150_000, 60_000_000);
        if bits_per_second == self.bitrate {
            return Ok(());
        }
        self.bitrate = bits_per_second;
        self.pending_bitrate = Some(bits_per_second);
        Ok(())
    }

    /// Map the governor's 0..100 quality scale onto a bitrate. The scale is what
    /// `screen.stats` reports, so both codecs share one knob.
    pub fn set_bitrate_scale(&mut self, quality: u8) -> Result<(), String> {
        self.set_bitrate(governor_bitrate(quality))
    }

    pub fn request_keyframe(&mut self) {
        self.force_keyframe = true;
    }

    pub fn encode(&mut self, frame: &RawFrame) -> Result<Encoded, String> {
        if let Some(bitrate) = self.pending_bitrate.take() {
            // In place: same session, same parameter sets, no keyframe, no
            // `resync` for the viewer. A failure here is not fatal to the
            // stream — the old rate keeps working — so it is logged, not raised.
            if let Err(error) = apply_bitrate(&self.session, bitrate) {
                log::debug!("调整 H.264 码率失败，保持当前码率：{error}");
            }
        }
        let Pixels::PixelBuffer(buffer) = &frame.pixels else {
            return Err("H.264 编码需要捕获层直接提供像素缓冲".into());
        };
        if frame.width != self.width || frame.height != self.height {
            return Err(format!(
                "帧尺寸变化：编码器为 {}×{}，收到 {}×{}",
                self.width, self.height, frame.width, frame.height
            ));
        }
        // The encoder consumes the IOSurface the capturer produced, so no pixels
        // are copied on the way in.
        let surface = buffer
            .io_surface()
            .ok_or_else(|| "捕获帧没有 IOSurface，无法交给硬件编码器".to_string())?;

        // Two frames can land inside the same millisecond and VideoToolbox
        // requires strictly increasing timestamps, so nudge rather than risk a
        // rejected frame.
        let millis = i64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(i64::MAX);
        let millis = millis.max(self.last_timestamp.saturating_add(1));
        self.last_timestamp = millis;

        let properties = if self.force_keyframe {
            self.force_keyframe = false;
            FrameProperties::new().with_force_key_frame(true)
        } else {
            FrameProperties::new()
        };
        // Blocking: the crate waits for the encoder to emit this frame, so the
        // pipeline sees one frame in, one access unit out, with no hidden queue
        // to add latency.
        let encoded = self
            .session
            .encode_with_properties(&surface, CMTime::new(millis, 1000), properties)
            .map_err(|error| format!("H.264 编码失败：{error}"))?;
        if encoded.data.is_empty() || encoded.info_flags & ENCODE_INFO_FRAME_DROPPED != 0 {
            return Err("H.264 编码器丢弃了该帧".into());
        }
        let keyframe = contains_parameter_set(&encoded.data) || contains_idr(&encoded.data);
        // Read the configuration before the payload moves out.
        let description = self.configuration(&encoded)?;
        Ok(Encoded {
            bytes: encoded.data,
            keyframe,
            description,
        })
    }

    /// Build the `AVCDecoderConfigurationRecord`, returning it only when it
    /// changed since the last frame.
    fn configuration(&mut self, encoded: &EncodedFrame) -> Result<Option<Vec<u8>>, String> {
        let Some(sample) = encoded.cm_sample_buffer() else {
            return Ok(None);
        };
        let Some(format) = sample.format_description() else {
            return Ok(None);
        };
        let sets = format
            .video_parameter_sets()
            .map_err(|status| format!("读取 H.264 参数集失败（{status}）"))?;
        let record = avcc(&sets.parameter_sets)?;
        if self.description.as_ref() == Some(&record) {
            return Ok(None);
        }
        self.description = Some(record.clone());
        Ok(Some(record))
    }
}

/// Build the encoder session. Called once per stream (and again only when the
/// frame size changes, which the pipeline already treats as a new stream).
fn build_session(
    width: u32,
    height: u32,
    bitrate: u32,
    fps: u32,
) -> Result<CompressionSession, String> {
    CompressionSession::builder(width as i32, height as i32, Codec::H264)
        // Latency, in order of importance.
        .with_real_time(true)
        .with_allow_frame_reordering(false)
        .with_low_latency_rate_control(true)
        // `Main` rather than `Baseline`: CABAC is a real quality win at the same
        // bitrate, and every H.264 decoder in a WebView supports Main. The level
        // is automatic, which keeps a 720-class preview at level 3.1 — well
        // inside what an older phone decodes.
        .with_profile_level(ProfileLevel::H264MainAutoLevel)
        .with_average_bit_rate(bitrate as i32)
        // Sizes the rate-control window. Without it the encoder assumes a much
        // lower frame rate and overshoots on every keyframe.
        .with_expected_frame_rate(f64::from(fps))
        .with_max_keyframe_interval(KEYFRAME_INTERVAL_SECONDS * fps as i32)
        .build()
        .map_err(|error: VTError| format!("无法创建 H.264 编码会话：{error}"))
}

/// Change the average bitrate of a running session.
///
/// `kVTCompressionPropertyKey_AverageBitRate` is documented as changeable while
/// the session is encoding; the encoder adapts its rate control from the next
/// frame on and keeps the existing reference chain.
fn apply_bitrate(session: &CompressionSession, bitrate: u32) -> Result<(), VTError> {
    let key = CFString::new("AverageBitRate");
    let value = CFNumber::from_i64(i64::from(bitrate));
    let properties = CFDictionary::from_pairs(&[(&key, &value)]);
    session.set_properties(&properties)
}

/// Assemble an `AVCDecoderConfigurationRecord` from the parameter sets.
///
/// This is the byte blob WebCodecs calls `description`. Passing it is what saves
/// the phone from doing any H.264 parsing of its own.
fn avcc(parameter_sets: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    let sps = parameter_sets.first().ok_or("H.264 缺少 SPS".to_string())?;
    let pps = parameter_sets.get(1).ok_or("H.264 缺少 PPS".to_string())?;
    if sps.len() < 4 || sps.len() > u16::MAX as usize || pps.len() > u16::MAX as usize {
        return Err("H.264 参数集长度异常".into());
    }
    let mut record = Vec::with_capacity(11 + sps.len() + pps.len());
    record.push(1);
    record.push(sps[1]);
    record.push(sps[2]);
    record.push(sps[3]);
    // 4-byte NAL length prefixes, which is what `videotoolbox` documents its
    // output as using.
    record.push(0xFF);
    record.push(0xE1);
    record.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    record.extend_from_slice(sps);
    record.push(1);
    record.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    record.extend_from_slice(pps);
    Ok(record)
}

/// `true` when the payload carries an IDR slice, i.e. a sync point.
fn contains_idr(avcc: &[u8]) -> bool {
    nal_types(avcc).any(|nal_type| nal_type == 5)
}

/// `true` when the payload carries its own parameter sets, which also starts a
/// new coded video sequence and therefore decodes independently.
fn contains_parameter_set(avcc: &[u8]) -> bool {
    nal_types(avcc).any(|nal_type| nal_type == 7 || nal_type == 8)
}

/// Walk the AVCC length prefixes and yield each NAL unit's type.
fn nal_types(avcc: &[u8]) -> impl Iterator<Item = u8> + '_ {
    let mut offset = 0usize;
    std::iter::from_fn(move || {
        let header = avcc.get(offset..offset + 4)?;
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        offset += 4;
        // A truncated or zero-length unit means the buffer is malformed;
        // stopping is safer than reading past the end.
        if length == 0 || offset + length > avcc.len() {
            return None;
        }
        let nal_type = avcc[offset] & 0x1F;
        offset += length;
        Some(nal_type)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nal_walk_reads_types_and_stops_on_truncation() {
        let mut avcc = Vec::new();
        avcc.extend_from_slice(&2_u32.to_be_bytes());
        avcc.extend_from_slice(&[0x67, 0x42]);
        avcc.extend_from_slice(&1_u32.to_be_bytes());
        avcc.extend_from_slice(&[0x65]);
        assert_eq!(nal_types(&avcc).collect::<Vec<_>>(), vec![7, 5]);
        assert!(contains_parameter_set(&avcc));
        assert!(contains_idr(&avcc));

        // A length that runs past the end must stop the walk, not panic.
        let truncated = [0, 0, 0, 200, 0x65];
        assert_eq!(nal_types(&truncated).count(), 0);
        assert!(!contains_idr(&truncated));
    }

    /// A synthetic BGRA frame backed by an IOSurface, so the real VideoToolbox
    /// encoder can run in CI without screen-recording permission.
    #[cfg(target_os = "macos")]
    fn synthetic_frame(width: u32, height: u32, shade: u8) -> RawFrame {
        use apple_cf::cv::CVPixelBuffer;
        use apple_cf::iosurface::IOSurface;
        let format = u32::from_be_bytes(*b"BGRA");
        let surface = IOSurface::create(width as usize, height as usize, format, 4)
            .expect("IOSurface");
        // Different content per frame so the encoder emits real inter frames.
        {
            let mut guard = surface.lock_read_write().expect("lock IOSurface");
            // SAFETY: the surface was created a few lines up and is not shared
            // with anything else; it stays locked for this block.
            if let Some(bytes) = unsafe { guard.as_slice_mut() } {
                for (index, byte) in bytes.iter_mut().enumerate() {
                    *byte = shade.wrapping_add((index % 251) as u8);
                }
            }
        }
        let pixels = CVPixelBuffer::create_with_io_surface(&surface).expect("pixel buffer");
        RawFrame {
            width,
            height,
            captured_at_ms: 0,
            pixels: Pixels::PixelBuffer(pixels),
        }
    }

    /// The regression this guards: a governor step used to rebuild the whole
    /// VideoToolbox session, so every step produced new parameter sets and a
    /// forced keyframe. The viewer reads that as a broken reference chain and
    /// throws its decoder away — and the startup probe steps several times in
    /// the first seconds of every session, which is what blacked the preview.
    ///
    /// Changing the bitrate must leave the stream decodable *as is*: the very
    /// next frame is an ordinary inter frame with no new configuration record.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_bitrate_change_does_not_restart_the_stream() {
        let mut encoder = match H264::new(640, 360, 4_000_000, 30) {
            Ok(encoder) => encoder,
            Err(error) => {
                eprintln!("跳过：本机没有可用的硬件 H.264 编码器（{error}）");
                return;
            }
        };
        let first = encoder.encode(&synthetic_frame(640, 360, 0)).expect("首帧");
        assert!(first.keyframe, "首帧必须是关键帧");
        assert!(first.description.is_some(), "首帧必须带解码器配置");

        // Settle into inter frames.
        for shade in 1..6 {
            encoder.encode(&synthetic_frame(640, 360, shade)).expect("帧");
        }

        for bitrate in [3_000_000, 2_000_000, 5_000_000, 8_000_000] {
            encoder.set_bitrate(bitrate).expect("set_bitrate");
            let after = encoder
                .encode(&synthetic_frame(640, 360, 40))
                .expect("改码率后的第一帧");
            assert!(
                after.description.is_none(),
                "改码率到 {bitrate} 后不应下发新的解码器配置（会让手机重置解码器）"
            );
            assert!(
                !after.keyframe,
                "改码率到 {bitrate} 后不应被迫插入关键帧"
            );
        }
    }

    #[test]
    fn non_idr_payload_is_not_a_keyframe() {
        let mut avcc = Vec::new();
        avcc.extend_from_slice(&1_u32.to_be_bytes());
        avcc.extend_from_slice(&[0x41]);
        assert!(!contains_idr(&avcc));
        assert!(!contains_parameter_set(&avcc));
    }

    #[test]
    fn the_configuration_record_matches_the_avc_spec_layout() {
        let sps = vec![0x67, 0x4d, 0x40, 0x1f, 0x00];
        let pps = vec![0x68, 0xee, 0x3c, 0x80];
        let record = avcc(&[sps.clone(), pps.clone()]).expect("record");
        assert_eq!(record[0], 1, "configurationVersion");
        assert_eq!(&record[1..4], &[0x4d, 0x40, 0x1f], "profile, compat, level");
        assert_eq!(record[4], 0xFF, "4-byte NAL lengths");
        assert_eq!(record[5], 0xE1, "one SPS");
        assert_eq!(&record[6..8], &(sps.len() as u16).to_be_bytes());
        assert_eq!(&record[8..8 + sps.len()], &sps[..]);
        let after_sps = 8 + sps.len();
        assert_eq!(record[after_sps], 1, "one PPS");
        assert_eq!(
            &record[after_sps + 1..after_sps + 3],
            &(pps.len() as u16).to_be_bytes()
        );
    }

    #[test]
    fn a_missing_parameter_set_is_an_error_not_a_panic() {
        assert!(avcc(&[]).is_err());
        assert!(avcc(&[vec![0x67, 0x4d, 0x40, 0x1f]]).is_err(), "no PPS");
        assert!(
            avcc(&[vec![0x67, 0x4d], vec![0x68, 0xee]]).is_err(),
            "SPS too short"
        );
    }
}
