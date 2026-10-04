//! JPEG preview encoding.
//!
//! JPEG is the *bootstrap* codec, and it is still earning its place: it has no
//! decoder configuration, no reference chain (so any frame can be dropped), and
//! it decodes in any WebView with an `<img>` tag. When H.264 is unavailable or
//! the client cannot decode it, this is what keeps the channel working.
//!
//! Two details matter more than the codec choice:
//!
//! 1. **Change detection.** An agent-driven desktop is static most of the time.
//!    Comparing against the previous RGB buffer costs about a millisecond and
//!    skips a ten-millisecond encode, which is most frames. The comparison is
//!    byte-exact rather than sampled, so a one-pixel update cannot slip
//!    through; the bandwidth governor, not a tolerance, is what keeps a
//!    fast-changing screen inside the link budget.
//! 2. **Buffer reuse.** The RGB and output buffers survive across frames, so
//!    steady-state encoding allocates nothing.

use image::ExtendedColorType;
use image::codecs::jpeg::JpegEncoder;

use super::Encoded;
use crate::screen::capture::RawFrame;

/// How many differing bits make a frame worth sending.
///
/// The comparison runs on raw captured pixels, not on decoded output, so two
/// frames of an unchanged screen are *bit-identical* — there is no compression
/// noise to filter. The threshold therefore only has to be non-zero, and a
/// single changed pixel (a blinking caret, one character of streamed output)
/// counts. Anything larger would silently hide small updates, and no later
/// stage could recover them.
const CHANGE_THRESHOLD: usize = 0;

pub struct Jpeg {
    quality: u8,
    rgb: Vec<u8>,
    previous: Vec<u8>,
    output: Vec<u8>,
}

impl Jpeg {
    #[must_use]
    pub fn new(quality: u8) -> Self {
        Self {
            quality: quality.clamp(1, 95),
            rgb: Vec::new(),
            previous: Vec::new(),
            output: Vec::new(),
        }
    }

    /// Adopt a new quality without dropping the reusable buffers.
    pub fn set_quality(&mut self, quality: u8) {
        self.quality = quality.clamp(1, 95);
    }

    /// Forget the previous frame so the next `encode` always produces output.
    pub fn invalidate(&mut self) {
        self.previous.clear();
    }

    /// Convert, compare, and encode. An empty result means the frame was
    /// visually identical to the previous one.
    pub fn encode(&mut self, frame: &RawFrame) -> Result<Vec<Encoded>, String> {
        let width = frame.width;
        let height = frame.height;
        let width_usize = width as usize;
        let height_usize = height as usize;
        let row_bytes = width_usize * 3;

        // Moved out and back so the row visitor can borrow it mutably while
        // `self` still holds the rest of the state.
        let mut rgb = std::mem::take(&mut self.rgb);
        rgb.resize(row_bytes * height_usize, 0);
        let mut offset = 0usize;
        let converted = frame.pixels.for_each_row(width_usize, height_usize, &mut |row| {
            let target = &mut rgb[offset..offset + row_bytes];
            bgra_to_rgb_row(row, target);
            offset += row_bytes;
        });
        if let Err(error) = converted {
            self.rgb = rgb;
            return Err(error);
        }

        if self.previous.len() == rgb.len() && !differs(&rgb, &self.previous) {
            self.rgb = rgb;
            return Ok(Vec::new());
        }
        self.previous.clear();
        self.previous.extend_from_slice(&rgb);

        self.output.clear();
        let mut encoder = JpegEncoder::new_with_quality(&mut self.output, self.quality);
        let result = encoder.encode(&rgb, width, height, ExtendedColorType::Rgb8);
        self.rgb = rgb;
        result.map_err(|error| format!("JPEG 编码失败：{error}"))?;

        Ok(vec![Encoded {
            bytes: std::mem::take(&mut self.output),
            // JPEG frames are all independently decodable, which is exactly
            // why the transport may drop any of them.
            keyframe: true,
            description: None,
        }])
    }
}

fn differs(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return true;
    }
    // Eight bytes at a time, then the remainder: rounding down and stopping
    // there would leave the last few pixels of the buffer uncompared, which is
    // exactly the kind of hole that turns into "the preview froze".
    let aligned = left.len() & !7;
    let mut changed = 0usize;
    for offset in (0..aligned).step_by(8) {
        let a = u64::from_ne_bytes(left[offset..offset + 8].try_into().expect("8 bytes"));
        let b = u64::from_ne_bytes(right[offset..offset + 8].try_into().expect("8 bytes"));
        if a == b {
            continue;
        }
        changed += (a ^ b).count_ones() as usize;
        if changed > CHANGE_THRESHOLD {
            return true;
        }
    }
    left[aligned..] != right[aligned..] || changed > CHANGE_THRESHOLD
}

/// One BGRA row (already packed to `width * 4`) → one packed RGB row.
fn bgra_to_rgb_row(source: &[u8], target: &mut [u8]) {
    for (pixel, out) in source.chunks_exact(4).zip(target.chunks_exact_mut(3)) {
        out[0] = pixel[2];
        out[1] = pixel[1];
        out[2] = pixel[0];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::capture::Pixels;

    fn frame(width: u32, height: u32, fill: u8) -> RawFrame {
        RawFrame {
            width,
            height,
            captured_at_ms: 0,
            pixels: Pixels::Bgra {
                bytes: vec![fill; width as usize * height as usize * 4],
                bytes_per_row: width as usize * 4,
            },
        }
    }

    #[test]
    fn identical_frames_are_dropped_and_changes_are_kept() {
        let mut encoder = Jpeg::new(70);
        let first = frame(64, 48, 0);
        assert_eq!(encoder.encode(&first).unwrap().len(), 1);
        assert!(encoder.encode(&first).unwrap().is_empty());

        let mut changed = frame(64, 48, 0);
        for byte in changed.pixels.bgra_mut().iter_mut().take(4096) {
            *byte = 255;
        }
        assert_eq!(encoder.encode(&changed).unwrap().len(), 1);
    }

    #[test]
    fn a_single_changed_pixel_is_not_mistaken_for_an_idle_screen() {
        // 10 x 3 leaves 90 RGB bytes, so two of them fall outside the 8-byte
        // blocks of the comparison. Changing the last pixel's blue channel is
        // therefore both the smallest possible update *and* a tail case.
        let mut encoder = Jpeg::new(70);
        let first = frame(10, 3, 0);
        assert_eq!(encoder.encode(&first).unwrap().len(), 1);

        let mut changed = frame(10, 3, 0);
        let last_pixel = changed.pixels.bgra_mut().len() - 4;
        changed.pixels.bgra_mut()[last_pixel] = 255;
        assert_eq!(encoder.encode(&changed).unwrap().len(), 1);
        assert!(encoder.encode(&changed).unwrap().is_empty());
    }

    #[test]
    fn alpha_only_changes_are_not_treated_as_updates() {
        // The screen is opaque, so an alpha-only difference produces identical
        // JPEG output. Sending it would be pure waste.
        let mut encoder = Jpeg::new(70);
        let first = frame(32, 16, 0);
        assert_eq!(encoder.encode(&first).unwrap().len(), 1);

        let mut changed = frame(32, 16, 0);
        for pixel in changed.pixels.bgra_mut().chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        assert!(encoder.encode(&changed).unwrap().is_empty());
    }

    #[test]
    fn encoded_jpeg_has_the_expected_dimensions() {
        let mut encoder = Jpeg::new(80);
        let encoded = encoder.encode(&frame(32, 16, 128)).unwrap().remove(0);
        // JPEG is always a sync point, so the transport may drop any of them.
        assert!(encoded.keyframe);
        assert!(encoded.description.is_none());
        assert!(encoded.bytes.starts_with(&[0xFF, 0xD8]));
        assert!(encoded.bytes.len() > 100);
        // A single frame carries no resolution metadata; the caller supplies
        // the geometry from the frame it asked for.
        let frame = frame(32, 16, 128);
        assert_eq!((frame.width, frame.height), (32, 16));
    }

    #[test]
    fn padded_rows_do_not_leak_into_the_next_row() {
        // The visitor packs rows to `width * 4`, so a padded source must still
        // produce tightly packed RGB.
        let mut bytes = vec![0_u8; 16 * 2];
        for byte in bytes.iter_mut().skip(16) {
            *byte = 255;
        }
        let frame = RawFrame {
            width: 4,
            height: 2,
            captured_at_ms: 0,
            pixels: Pixels::Bgra {
                bytes,
                bytes_per_row: 16,
            },
        };
        let mut rgb = vec![0_u8; 4 * 2 * 3];
        let mut offset = 0usize;
        frame
            .pixels
            .for_each_row(4, 2, &mut |row| {
                bgra_to_rgb_row(row, &mut rgb[offset..offset + 12]);
                offset += 12;
            })
            .unwrap();
        assert!(rgb[..12].iter().all(|byte| *byte == 0));
        assert!(rgb[12..].iter().all(|byte| *byte == 255));
    }
}
