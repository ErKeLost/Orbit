//! Preview encoding: the codec layer.
//!
//! Two codecs, one interface, because they solve different problems:
//!
//! * **H.264 (VideoToolbox, hardware).** Inter-frame compression, so an idle
//!   desktop costs a few hundred bytes per second instead of tens of
//!   kilobytes, and a busy one is bounded by the bitrate instead of by the
//!   screen's entropy. This is the default wherever it exists.
//! * **JPEG.** No decoder configuration, no reference chain, universally
//!   decodable by a WebView `<img>`. It stays as the guaranteed fallback for
//!   browsers without WebCodecs, and as the path that proves the whole
//!   channel works before any hardware encoder is involved.
//!
//! The difference that shapes the *pipeline* rather than this file: JPEG frames
//! are independent, so any of them can be dropped; H.264 frames are not, so
//! the pipeline must not encode a frame no subscriber can receive. See
//! `bus::needs_frame` and the keyframe request path in `mod.rs`.

/// VideoToolbox H.264. macOS only: the module binds Objective-C frameworks that
/// exist nowhere else, and on other targets `Codec::H264` resolves to
/// [`Inner::Unsupported`] instead, which is what lets `screen.start` report an
/// honest downgrade rather than failing to build.
#[cfg(target_os = "macos")]
pub mod h264;
pub mod jpeg;

use crate::screen::capture::RawFrame;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Jpeg,
    H264,
}

impl Codec {
    /// The wire name carried in `screen.frame` and the `screen.start` reply.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Codec::Jpeg => "jpeg",
            Codec::H264 => "h264",
        }
    }

    /// Parse a client request. Unknown names are rejected rather than
    /// silently downgraded, so a typo surfaces instead of looking like a
    /// platform limitation.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "jpeg" => Some(Codec::Jpeg),
            "h264" => Some(Codec::H264),
            _ => None,
        }
    }
}

/// One encoded access unit.
pub struct Encoded {
    pub bytes: Vec<u8>,
    /// `true` when this frame can be decoded without any earlier frame. Always
    /// true for JPEG.
    pub keyframe: bool,
    /// H.264 decoder configuration (an `AVCDecoderConfigurationRecord`),
    /// present only on the frames where it changed. H.264 only.
    pub description: Option<Vec<u8>>,
}

pub struct Encoder {
    inner: Inner,
}

enum Inner {
    Jpeg(jpeg::Jpeg),
    #[cfg(target_os = "macos")]
    H264(h264::H264),
    /// H.264 was asked for on a platform without a hardware encoder. Kept as a
    /// distinct state so `screen.start` can report the downgrade once instead
    /// of failing every frame.
    #[cfg(not(target_os = "macos"))]
    Unsupported,
}

impl Encoder {
    /// Build an encoder for the resolved frame size.
    ///
    /// `bitrate` is the target for H.264 and ignored by JPEG, which is bounded
    /// by `quality` instead.
    pub fn new(
        codec: Codec,
        width: u32,
        height: u32,
        quality: u8,
        bitrate: u32,
        fps: u32,
    ) -> Result<Self, String> {
        Ok(Self {
            inner: match codec {
                Codec::Jpeg => Inner::Jpeg(jpeg::Jpeg::new(quality)),
                #[cfg(target_os = "macos")]
                Codec::H264 => Inner::H264(h264::H264::new(width, height, bitrate, fps)?),
                #[cfg(not(target_os = "macos"))]
                Codec::H264 => {
                    let _ = (width, height, bitrate, fps);
                    Inner::Unsupported
                }
            },
        })
    }

    #[must_use]
    pub fn codec(&self) -> Codec {
        match self.inner {
            Inner::Jpeg(_) => Codec::Jpeg,
            #[cfg(target_os = "macos")]
            Inner::H264(_) => Codec::H264,
            #[cfg(not(target_os = "macos"))]
            Inner::Unsupported => Codec::Jpeg,
        }
    }

    /// Whether this encoder can consume a frame of this size. A mismatch means
    /// the capture box changed under us (a display was reconfigured, or
    /// ScreenCaptureKit rounded differently) and the caller has to rebuild.
    #[must_use]
    pub fn matches_size(&self, width: u32, height: u32) -> bool {
        match &self.inner {
            // JPEG resizes its own buffers per frame, so nothing can mismatch.
            Inner::Jpeg(_) => true,
            #[cfg(target_os = "macos")]
            Inner::H264(encoder) => encoder.width() == width && encoder.height() == height,
            #[cfg(not(target_os = "macos"))]
            Inner::Unsupported => {
                let _ = (width, height);
                true
            }
        }
    }

    /// Encode one frame, returning every access unit that became ready.
    ///
    /// An empty result means "nothing to send": either the frame was
    /// byte-identical to the previous one (JPEG), or the encoder accepted it
    /// and has not produced output yet (H.264, which may run asynchronously).
    /// A `Vec` rather than an `Option` is what lets the H.264 path stay
    /// correct in both cases without the pipeline guessing.
    pub fn encode(&mut self, frame: &RawFrame) -> Result<Vec<Encoded>, String> {
        match &mut self.inner {
            Inner::Jpeg(encoder) => encoder.encode(frame).map(|encoded| encoded.into_iter().collect()),
            // `videotoolbox`'s `encode` blocks until the encoder emits this
            // frame, so there is exactly one access unit to report — unlike a
            // hand-driven session, no output can still be in flight.
            #[cfg(target_os = "macos")]
            Inner::H264(encoder) => encoder.encode(frame).map(|encoded| vec![encoded]),
            #[cfg(not(target_os = "macos"))]
            Inner::Unsupported => Err("此平台没有可用的 H.264 编码器".into()),
        }
    }

    /// The decoder configuration currently in use, if this codec needs one.
    ///
    /// The pipeline attaches this to every *resync* frame, which is what makes
    /// such a frame self-contained: a viewer that joins an already-running
    /// pipeline has no configuration of its own, and the encoder has no reason
    /// to resend it (nothing changed). Without this, a phone that closes and
    /// reopens the screen tab inside the idle grace window would receive a
    /// valid keyframe it could not configure a decoder for.
    #[must_use]
    pub fn description(&self) -> Option<Vec<u8>> {
        match &self.inner {
            Inner::Jpeg(_) => None,
            #[cfg(target_os = "macos")]
            Inner::H264(encoder) => encoder.description(),
            #[cfg(not(target_os = "macos"))]
            Inner::Unsupported => None,
        }
    }

    /// Make the next encoded frame a fresh start.
    ///
    /// For H.264 that means a keyframe, so a decoder that lost the reference
    /// chain can resynchronise. For JPEG it means forcing a frame through the
    /// change detector, because JPEG has no chain to repair but a joining
    /// viewer still has to receive *something* on an idle desktop.
    pub fn refresh(&mut self) {
        match &mut self.inner {
            Inner::Jpeg(encoder) => encoder.invalidate(),
            #[cfg(target_os = "macos")]
            Inner::H264(encoder) => encoder.request_keyframe(),
            #[cfg(not(target_os = "macos"))]
            Inner::Unsupported => {}
        }
    }

    pub fn set_quality(&mut self, quality: u8) {
        match &mut self.inner {
            Inner::Jpeg(encoder) => encoder.set_quality(quality),
            #[cfg(target_os = "macos")]
            Inner::H264(encoder) => {
                // Quality is expressed as a bitrate target for H.264; the
                // governor's 0..100 scale is the one knob both codecs share.
                let _ = encoder.set_bitrate_scale(quality);
            }
            #[cfg(not(target_os = "macos"))]
            Inner::Unsupported => {}
        }
    }
}
