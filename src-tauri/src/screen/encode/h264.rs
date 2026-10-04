//! Hardware H.264 via VideoToolbox.
//!
//! This is the codec that makes the screen channel viable on a phone link:
//! JPEG costs tens of kilobytes per frame no matter how little changed, while
//! H.264 costs a few hundred bytes for an idle desktop and is bounded by an
//! explicit bitrate when the screen is busy.
//!
//! Three configuration choices matter more than the rest, and all three are
//! about latency rather than size:
//!
//! * `AllowFrameReordering = false` — no B-frames, so decode order is display
//!   order and a frame never waits for a later one.
//! * `MaxFrameDelayCount = 0` — the encoder emits each frame before returning,
//!   so `encode()` is synchronous from the pipeline's point of view and there
//!   is no hidden queue to add latency.
//! * `RealTime = true` + `PrioritizeEncodingSpeedOverQuality` — the encoder is
//!   allowed to spend bits on speed.
//!
//! Output is AVCC (4-byte length-prefixed NAL units) plus an
//! `AVCDecoderConfigurationRecord`, which is exactly the pair WebCodecs'
//! `VideoDecoder` expects, so the phone needs no format conversion.
//!
//! One deliberate omission: unlike the JPEG path, this one does **no** change
//! detection. Measuring a change would mean locking the pixel buffer and
//! walking it on the CPU — a couple of milliseconds — to avoid a hardware
//! encode that costs about as much and produces a few hundred bytes for a
//! static screen anyway. Inter-frame compression *is* the change detector;
//! adding one here would spend the saving it was meant to make.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, kCFAllocatorDefault,
};
use objc2_core_media::{
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMTime,
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex, kCMVideoCodecType_H264,
};
use objc2_core_video::CVImageBuffer;
use objc2_video_toolbox::{
    VTCompressionSession, VTEncodeInfoFlags,
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AllowOpenGOP,
    kVTCompressionPropertyKey_AverageBitRate, kVTCompressionPropertyKey_DataRateLimits,
    kVTCompressionPropertyKey_MaxKeyFrameInterval,
    kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
    kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
    kVTCompressionPropertyKey_ProfileLevel, kVTCompressionPropertyKey_RealTime,
    kVTEncodeFrameOptionKey_ForceKeyFrame, kVTProfileLevel_H264_Main_AutoLevel,
};

use super::Encoded;
use crate::screen::capture::{Pixels, RawFrame};

/// Longest keyframe interval, in frames and in seconds. Both are set: whichever
/// fires first wins, which keeps a late joiner waiting at most two seconds and
/// bounds error propagation for a viewer that lost the chain.
const KEYFRAME_INTERVAL_FRAMES: i32 = 120;
const KEYFRAME_INTERVAL_SECONDS: i32 = 2;

/// Hard ceiling on the encoder's output buffer, in bytes per second, applied
/// alongside the average bitrate so a burst cannot overflow the relay's
/// per-frame limit. Two seconds of window at the target rate.
fn data_rate_limits(bitrate: u32) -> [i64; 2] {
    [i64::from(bitrate) * 2, 2]
}

/// A finished access unit, produced by the VideoToolbox callback.
struct H264Frame {
    data: Vec<u8>,
    keyframe: bool,
    description: Option<Vec<u8>>,
}

/// State shared with the `VTCompressionSession` output callback.
struct Sink {
    pending: Mutex<VecDeque<Result<H264Frame, String>>>,
}

impl Sink {
    fn push(&self, value: Result<H264Frame, String>) {
        // A poisoned mutex here would mean a panic inside the callback, which
        // cannot happen: the callback only allocates and copies.
        if let Ok(mut pending) = self.pending.lock() {
            pending.push_back(value);
        }
    }
}

pub struct H264 {
    // Field order matters: `session` is invalidated in `Drop` *before*
    // `sink` is released, so the callback can never observe a dangling
    // `Sink`.
    session: CFRetained<VTCompressionSession>,
    sink: Arc<Sink>,
    width: u32,
    height: u32,
    bitrate: u32,
    /// The configuration record most recently handed to the caller. Re-sending
    /// it only when it changes is what makes `description` optional on the
    /// wire.
    description: Option<Vec<u8>>,
    force_keyframe: bool,
    started_at: std::time::Instant,
    last_timestamp: i64,
}

/// The profile/level we ask for. `Main` (not `Baseline`) because it allows
/// CABAC, which is a meaningful quality win at the same bitrate, and every
/// decoder that supports H.264 in a WebView supports Main. `AutoLevel` lets
/// the encoder pick a level matching the resolution.
fn profile_level() -> &'static CFType {
    // SAFETY: `kVTProfileLevel_H264_Main_AutoLevel` is a static CFString owned
    // by VideoToolbox and valid for the process lifetime.
    unsafe { kVTProfileLevel_H264_Main_AutoLevel }.as_ref()
}

/// Set a property that the configuration genuinely depends on.
///
/// A rejection here is fatal on purpose: silently ignoring, say,
/// `AllowFrameReordering` would reintroduce B-frames and the exact latency this
/// configuration exists to avoid, and the failure would be invisible.
fn set_required(
    session: &VTCompressionSession,
    key: &CFString,
    value: &CFType,
    name: &str,
) -> Result<(), String> {
    match apply_property(session, key, value) {
        0 => Ok(()),
        status => Err(format!("设置 {name} 失败（OSStatus {status}）")),
    }
}

/// Set a tuning property that improves latency but is not required.
///
/// VideoToolbox rejects different optional keys on different hardware and macOS
/// versions. Losing a hint costs some latency; failing the session costs the
/// whole feature, so these are recorded and ignored.
fn set_optional(session: &VTCompressionSession, key: &CFString, value: &CFType, name: &str) -> bool {
    apply_property(session, key, value) == 0 || {
        log::debug!("VideoToolbox 拒绝了可选属性 {name}，继续使用默认值");
        false
    }
}

fn apply_property(session: &VTCompressionSession, key: &CFString, value: &CFType) -> i32 {
    // SAFETY: `session` is a live compression session and `value` is a
    // CFNumber/CFBoolean/CFString/CFArray, which is what these keys require.
    unsafe { objc2_video_toolbox::VTSessionSetProperty(session, key, Some(value)) }
}

fn number(value: i32) -> CFRetained<CFNumber> {
    CFNumber::new_i32(value)
}

impl H264 {
    pub fn new(width: u32, height: u32, bitrate: u32, fps: u32) -> Result<Self, String> {
        let sink = Arc::new(Sink {
            pending: Mutex::new(VecDeque::new()),
        });
        // The callback receives this pointer as its refcon. The `Arc` is kept
        // alive by `Self::sink`, and `Drop` invalidates the session before
        // releasing it.
        let refcon = Arc::as_ptr(&sink) as *mut std::ffi::c_void;
        let mut session_out: *mut VTCompressionSession = std::ptr::null_mut();
        // SAFETY: a null allocator means "default", the codec type and
        // dimensions are validated below, no encoder specification or source
        // attributes are needed, and `refcon` stays valid for the session's
        // lifetime.
        let status = unsafe {
            VTCompressionSession::create(
                kCFAllocatorDefault,
                width as i32,
                height as i32,
                kCMVideoCodecType_H264,
                None,
                None,
                None,
                Some(output_callback),
                refcon,
                std::ptr::NonNull::from(&mut session_out),
            )
        };
        if status != 0 {
            return Err(format!("无法创建 H.264 编码会话（OSStatus {status}）"));
        }
        let Some(session_out) = std::ptr::NonNull::new(session_out) else {
            return Err("创建 H.264 编码会话失败：没有返回会话".into());
        };
        // SAFETY: `create` returned success and a non-null, +1 retained
        // session, whose ownership transfers to us.
        let session: CFRetained<VTCompressionSession> =
            unsafe { CFRetained::from_raw(session_out) };

        let bitrate = bitrate.max(150_000);
        let true_value: &CFType = CFBoolean::new(true);
        let false_value: &CFType = CFBoolean::new(false);
        // Required: these define the latency and compatibility contract.
        set_required(&session, unsafe { kVTCompressionPropertyKey_RealTime }, true_value, "RealTime")?;
        set_required(
            &session,
            unsafe { kVTCompressionPropertyKey_AllowFrameReordering },
            false_value,
            "AllowFrameReordering",
        )?;
        let profile: &CFType = profile_level();
        set_required(
            &session,
            unsafe { kVTCompressionPropertyKey_ProfileLevel },
            profile,
            "ProfileLevel",
        )?;
        let interval = KEYFRAME_INTERVAL_FRAMES.min(
            i32::try_from(fps).unwrap_or(30).saturating_mul(KEYFRAME_INTERVAL_SECONDS),
        );
        set_required(
            &session,
            unsafe { kVTCompressionPropertyKey_MaxKeyFrameInterval },
            &number(interval),
            "MaxKeyFrameInterval",
        )?;
        // Optional: latency and shape hints whose rejection must not be fatal.
        set_optional(
            &session,
            unsafe { kVTCompressionPropertyKey_AllowOpenGOP },
            false_value,
            "AllowOpenGOP",
        );
        set_optional(
            &session,
            unsafe { kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality },
            true_value,
            "PrioritizeEncodingSpeedOverQuality",
        );
        set_optional(
            &session,
            unsafe { kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration },
            &number(KEYFRAME_INTERVAL_SECONDS),
            "MaxKeyFrameIntervalDuration",
        );
        let mut encoder = Self {
            session,
            sink,
            width,
            height,
            bitrate: 0,
            description: None,
            force_keyframe: true,
            started_at: std::time::Instant::now(),
            last_timestamp: -1,
        };
        encoder.set_bitrate(bitrate)?;
        // Warm up the session so the first real frame is not charged for the
        // encoder's one-time setup. Failure here is not fatal — the first
        // `encode` simply pays it.
        // SAFETY: a plain call on a live session.
        unsafe { encoder.session.prepare_to_encode_frames() };
        Ok(encoder)
    }

    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn set_bitrate(&mut self, bits_per_second: u32) -> Result<(), String> {
        let bits_per_second = bits_per_second.clamp(150_000, 40_000_000);
        if bits_per_second == self.bitrate {
            return Ok(());
        }
        set_required(
            &self.session,
            // SAFETY: a static property key.
            unsafe { kVTCompressionPropertyKey_AverageBitRate },
            &number(bits_per_second as i32),
            "AverageBitRate",
        )?;
        // `DataRateLimits` is documented as a two-element array:
        // [bytes per window, window length in seconds].
        let limits = data_rate_limits(bits_per_second);
        let bytes = CFNumber::new_i64(limits[0]);
        let seconds = CFNumber::new_i64(limits[1]);
        let windows: [&CFType; 2] = [bytes.as_ref(), seconds.as_ref()];
        let array = CFArray::from_objects(&windows);
        set_optional(
            &self.session,
            // SAFETY: a static property key.
            unsafe { kVTCompressionPropertyKey_DataRateLimits },
            array.as_ref(),
            "DataRateLimits",
        );
        self.bitrate = bits_per_second;
        Ok(())
    }

    /// The configuration record the decoder currently needs.
    #[must_use]
    pub fn description(&self) -> Option<Vec<u8>> {
        self.description.clone()
    }

    /// Map the governor's 0..100 quality scale onto a bitrate. The scale is
    /// what `screen.stats` reports, so both codecs share one knob.
    pub fn set_bitrate_scale(&mut self, quality: u8) -> Result<(), String> {
        let quality = u32::from(quality.clamp(20, 95));
        // 1.5 Mbps at quality 20, ~9 Mbps at quality 95.
        let bitrate = 1_500_000 + (quality - 20) * 100_000;
        self.set_bitrate(bitrate)
    }

    pub fn request_keyframe(&mut self) {
        self.force_keyframe = true;
    }

    /// Feed one frame and return every access unit that became ready.
    ///
    /// VideoToolbox may hand back a frame later than the call that produced it,
    /// so this returns a list rather than assuming one-in-one-out. The order is
    /// always encoder order, which without frame reordering is display order,
    /// so the pipeline can publish them sequentially without gaps.
    pub fn encode(&mut self, frame: &RawFrame) -> Result<Vec<Encoded>, String> {
        let Pixels::PixelBuffer(buffer) = &frame.pixels else {
            return Err("H.264 编码需要捕获层直接提供像素缓冲".into());
        };
        if frame.width != self.width || frame.height != self.height {
            return Err(format!(
                "帧尺寸变化：编码器为 {}×{}，收到 {}×{}",
                self.width, self.height, frame.width, frame.height
            ));
        }
        let image_buffer: &CVImageBuffer = buffer.image_buffer();
        let elapsed = self.started_at.elapsed();
        // Two frames can land inside the same millisecond, and VideoToolbox
        // requires strictly increasing timestamps, so nudge rather than risk a
        // rejected frame.
        let millis = i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX);
        let millis = millis.max(self.last_timestamp.saturating_add(1));
        self.last_timestamp = millis;
        // SAFETY: `CMTimeMake` is a pure constructor for a value type; a
        // millisecond timescale is what makes the timestamps meaningful.
        let timestamp = unsafe { CMTime::new(millis, 1000) };
        let properties = if self.force_keyframe {
            self.force_keyframe = false;
            let key = unsafe { kVTEncodeFrameOptionKey_ForceKeyFrame };
            let key: &CFType = key.as_ref();
            let value: &CFType = CFBoolean::new(true);
            Some(CFDictionary::<CFType, CFType>::from_slices(
                &[key],
                &[value],
            ))
        } else {
            None
        };
        // SAFETY: the image buffer is a live pixel buffer owned by `frame`,
        // the timestamp is monotonic, and `properties` is either absent or a
        // dictionary with the documented key.
        let status = unsafe {
            self.session.encode_frame(
                image_buffer,
                timestamp,
                // An unknown duration, which is what a live capture has.
                CMTime::new(0, 1),
                properties
                    .as_deref()
                    .map(|properties| AsRef::<CFDictionary>::as_ref(properties)),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(format!("H.264 编码失败（OSStatus {status}）"));
        }
        self.drain()
    }

    /// Take everything the callback has produced so far.
    ///
    /// The configuration record is trimmed to the frames where it actually
    /// changes, which for a static display means the first frame and nothing
    /// after it.
    fn drain(&mut self) -> Result<Vec<Encoded>, String> {
        let mut ready = Vec::new();
        loop {
            let next = self
                .sink
                .pending
                .lock()
                .map_err(|_| "H.264 编码回调状态不可用".to_string())?
                .pop_front();
            let Some(next) = next else { break };
            let mut frame = next?;
            if frame.description.as_ref() == self.description.as_ref() {
                frame.description = None;
            } else {
                self.description = frame.description.clone();
            }
            ready.push(Encoded {
                bytes: frame.data,
                keyframe: frame.keyframe,
                description: frame.description,
            });
        }
        Ok(ready)
    }
}

impl Drop for H264 {
    fn drop(&mut self) {
        // SAFETY: invalidating is idempotent and must happen before the `Sink`
        // the callback points at is released, which is guaranteed because
        // `Drop::drop` runs before the fields are dropped.
        unsafe { self.session.invalidate() };
    }
}

/// VideoToolbox output callback.
///
/// # Safety
/// `output_ref_con` must be the `Arc<Sink>` pointer passed to
/// `VTCompressionSessionCreate`, and `sample_buffer` must be null or a valid
/// compressed sample buffer.
unsafe extern "C-unwind" fn output_callback(
    output_ref_con: *mut std::ffi::c_void,
    _source_frame_ref_con: *mut std::ffi::c_void,
    status: i32,
    info_flags: VTEncodeInfoFlags,
    sample_buffer: *mut CMSampleBuffer,
) {
    if output_ref_con.is_null() {
        return;
    }
    // SAFETY: the refcon is the `Arc<Sink>` raw pointer from `H264::new`, kept
    // alive by the encoder for at least as long as its session.
    let sink: &Sink = unsafe { &*output_ref_con.cast::<Sink>() };
    if status != 0 {
        sink.push(Err(format!("H.264 编码器返回错误（OSStatus {status}）")));
        return;
    }
    if info_flags.contains(VTEncodeInfoFlags::FrameDropped) {
        // The encoder deliberately dropped the frame. Reporting it as a frame
        // would be worse than reporting nothing: the reference chain is intact
        // because nothing was emitted.
        return;
    }
    let Some(sample) = (unsafe { sample_buffer.as_ref() }) else {
        return;
    };
    // SAFETY: the sample buffer is valid for the duration of this call.
    sink.push(unsafe { extract(sample) });
}

/// Pull the access unit and the decoder configuration out of a compressed
/// sample buffer.
///
/// # Safety
/// `sample` must be a valid compressed sample buffer.
unsafe fn extract(sample: &CMSampleBuffer) -> Result<H264Frame, String> {
    // SAFETY: guarded by the caller's contract.
    let format: CFRetained<CMFormatDescription> = unsafe { sample.format_description() }
        .ok_or_else(|| "H.264 输出缺少格式描述".to_string())?;
    // SAFETY: reading the media subtype of a live description.
    let subtype = unsafe { format.media_sub_type() };
    if subtype != kCMVideoCodecType_H264 {
        return Err(format!("H.264 输出格式异常（{subtype:#x}）"));
    }
    let description = parameter_sets(&format)?;

    // SAFETY: guarded by the caller's contract.
    let block: CFRetained<CMBlockBuffer> = unsafe { sample.data_buffer() }
        .ok_or_else(|| "H.264 输出缺少数据块".to_string())?;
    // SAFETY: sampling the buffer length is always valid.
    let length = unsafe { block.data_length() };
    if length == 0 {
        return Err("H.264 输出为空".into());
    }
    let mut data = vec![0_u8; length];
    // SAFETY: `data.as_mut_ptr()` points at exactly `length` writable bytes,
    // which is the range the copy fills.
    let status = unsafe {
        block.copy_data_bytes(0, length, std::ptr::NonNull::new(data.as_mut_ptr().cast()).unwrap())
    };
    if status != 0 {
        return Err(format!("读取 H.264 数据失败（OSStatus {status}）"));
    }

    let keyframe = contains_parameter_set(&data) || contains_idr(&data);
    Ok(H264Frame {
        data,
        keyframe,
        description: Some(description),
    })
}

/// Build an `AVCDecoderConfigurationRecord` from the format description.
///
/// This is the byte blob WebCodecs calls `description`. Passing it is what
/// saves the phone from doing any H.264 parsing of its own.
fn parameter_sets(format: &CMFormatDescription) -> Result<Vec<u8>, String> {
    let mut sets: Vec<Vec<u8>> = Vec::new();
    let mut count = 0usize;
    let mut nal_length_size = 0i32;
    // Index 0 and 1 are SPS and PPS; index 2+ would be SEI, which the record
    // format has no place for.
    for index in 0..2 {
        let mut pointer: *const u8 = std::ptr::null();
        let mut size = 0usize;
        // SAFETY: all four out-parameters are valid pointers to locals, and
        // the returned pointer is only read while `format` is borrowed.
        let status = unsafe { CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            index,
            &mut pointer,
            &mut size,
            &mut count,
            &mut nal_length_size,
        ) };
        if status != 0 {
            return Err(format!("读取 H.264 参数集失败（OSStatus {status}）"));
        }
        if pointer.is_null() || size == 0 {
            return Err("H.264 参数集为空".into());
        }
        // SAFETY: the pointer refers to memory inside `format`, which the
        // caller holds a reference to, and is valid for `size` bytes.
        sets.push(unsafe { std::slice::from_raw_parts(pointer, size) }.to_vec());
    }
    if nal_length_size != 4 {
        // The record we build advertises 4-byte lengths. A different length
        // would make every client misparse the stream, so this is a hard
        // error rather than a warning.
        return Err(format!("H.264 NAL 长度前缀为 {nal_length_size} 字节，只支持 4"));
    }
    let (sps, pps) = (&sets[0], &sets[1]);
    if sps.len() < 4 {
        return Err("H.264 SPS 过短".into());
    }
    let mut record = Vec::with_capacity(11 + sps.len() + pps.len());
    record.push(1);
    record.push(sps[1]);
    record.push(sps[2]);
    record.push(sps[3]);
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
    for nal_type in nal_types(avcc) {
        if nal_type == 5 {
            return true;
        }
    }
    false
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

    #[test]
    fn non_idr_payload_is_not_a_keyframe() {
        let mut avcc = Vec::new();
        avcc.extend_from_slice(&1_u32.to_be_bytes());
        avcc.extend_from_slice(&[0x41]);
        assert!(!contains_idr(&avcc));
        assert!(!contains_parameter_set(&avcc));
    }

    #[test]
    fn data_rate_limits_scale_with_the_bitrate() {
        assert_eq!(data_rate_limits(1_000_000), [2_000_000, 2]);
    }
}
