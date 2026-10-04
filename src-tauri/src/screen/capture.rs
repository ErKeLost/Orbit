//! Platform capture abstraction for the screen channel.
//!
//! The pipeline receives [`RawFrame`] values: pixel data plus the display
//! metadata needed to map a normalized mobile touch back to a logical screen
//! point.
//!
//! Crucially the pixels are *not* required to be a CPU copy. On macOS the
//! frame carries the retained `CVPixelBuffer` that ScreenCaptureKit already
//! produced, which means the hardware H.264 encoder can read the IOSurface
//! directly and the pipeline never touches 8 MB per frame. The JPEG encoder,
//! which genuinely needs bytes, asks for them through [`Pixels::for_each_row`]
//! and pays the copy only when it is the selected codec.
//!
//! Downscaling also happens inside the platform capturer (ScreenCaptureKit
//! scales on the GPU), so this layer never resizes pixels.

use std::sync::Arc;
use std::time::Duration;

/// Where capture is pointed.
///
/// A display and an application window are the same thing to everything
/// downstream: a rectangle in global logical coordinates plus the pixel size it
/// is captured at. That is why watching the app the agent is driving needed no
/// new type, no protocol change to the frame envelope, and no change to the
/// input mapping — only a different rectangle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Display,
    Window,
}

/// A capturable region, described in both logical points and device pixels.
///
/// Logical geometry is what `CGEvent` / accessibility coordinates use; pixel
/// geometry is what the encoder receives. Keeping both on one struct is what
/// lets the mobile client stay ignorant of Retina scaling.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub kind: TargetKind,
    /// Owning process for a window target; `None` for a display.
    pub owner_pid: Option<i32>,
    /// Global logical origin (`SCDisplay.frame().origin`). Secondary displays
    /// can and do have negative origins.
    pub logical_x: f64,
    pub logical_y: f64,
    pub logical_width: f64,
    pub logical_height: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// Pixel-to-logical ratio (`2.0` on Retina).
    pub scale: f64,
    pub primary: bool,
}

impl DisplayInfo {
    /// Map a normalized `0..1` capture-space point onto a global logical
    /// screen point, which is the coordinate space input injection expects.
    #[must_use]
    pub fn to_logical_point(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.logical_x + x.clamp(0.0, 1.0) * self.logical_width,
            self.logical_y + y.clamp(0.0, 1.0) * self.logical_height,
        )
    }
}

/// Pixel storage of one captured frame.
pub enum Pixels {
    /// Retained, IOSurface-backed, zero-copy. The preferred form: the H.264
    /// encoder consumes it directly.
    #[cfg(target_os = "macos")]
    PixelBuffer(PixelBufferHandle),
    /// Tightly packed BGRA with a row stride. Used by tests and by any future
    /// capturer that can only hand out bytes.
    #[allow(
        dead_code,
        reason = "produced by tests and by byte-only capturers; the macOS path deliberately does not use it"
    )]
    Bgra {
        bytes: Vec<u8>,
        bytes_per_row: usize,
    },
}

impl Pixels {
    /// Visit every BGRA row, packed to `width * 4` bytes.
    ///
    /// This is the one place that knows how to turn either representation into
    /// contiguous bytes, so the JPEG encoder never has to care which capturer
    /// produced the frame.
    pub fn for_each_row(
        &self,
        width: usize,
        height: usize,
        visit: &mut impl FnMut(&[u8]),
    ) -> Result<(), String> {
        let stride = width * 4;
        match self {
            #[cfg(target_os = "macos")]
            Pixels::PixelBuffer(buffer) => {
                let locked = buffer
                    .lock()
                    .ok_or_else(|| "无法锁定捕获帧的内存".to_string())?;
                if locked.bytes_per_row() < stride {
                    return Err("捕获帧的行跨距异常".into());
                }
                for row in 0..height.min(locked.height()) {
                    visit(&locked.row(row)[..stride]);
                }
                Ok(())
            }
            Pixels::Bgra {
                bytes,
                bytes_per_row,
            } => {
                if *bytes_per_row < stride {
                    return Err("捕获帧的行跨距异常".into());
                }
                for row in 0..height {
                    let start = row * bytes_per_row;
                    let end = start + stride;
                    let Some(row_bytes) = bytes.get(start..end) else {
                        return Err("捕获帧数据不完整".into());
                    };
                    visit(row_bytes);
                }
                Ok(())
            }
        }
    }

    /// Mutable access to the BGRA bytes.
    ///
    /// Test-only: the zero-copy path deliberately cannot be mutated in place,
    /// and tests synthesise frames from bytes rather than from a capturer.
    #[cfg(test)]
    pub fn bgra_mut(&mut self) -> &mut [u8] {
        match self {
            Pixels::Bgra { bytes, .. } => bytes,
            #[cfg(target_os = "macos")]
            Pixels::PixelBuffer(_) => panic!("tests build frames from byte buffers"),
        }
    }
}

/// One captured frame.
///
/// The originating display is deliberately not carried here: the pipeline
/// already knows which display it opened, and duplicating it on every frame
/// would create a second source of truth for the input mapping.
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    pub captured_at_ms: u128,
    pub pixels: Pixels,
}

#[cfg(target_os = "macos")]
mod pixel_buffer {
    use objc2_core_foundation::CFRetained;
    use objc2_core_video::{
        CVImageBuffer, CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
        CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
        CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    };

    /// A retained `CVPixelBuffer` that may be moved between threads.
    ///
    /// # Safety rationale
    ///
    /// `CVPixelBuffer` is not `Sync` and is not thread-safe for *concurrent*
    /// access, which is exactly what this wrapper does not permit: the handle
    /// is moved along a channel, so precisely one thread owns it at a time,
    /// and its pixels are only reachable through a `&self` borrow held on that
    /// thread. CoreVideo objects use atomic reference counting, so handing a
    /// reference from the capture callback to the pipeline is well defined —
    /// this is the same ownership transfer Apple's own sample code performs
    /// when it dispatches frames off the sample-handler queue.
    pub struct PixelBufferHandle(CFRetained<CVPixelBuffer>);

    unsafe impl Send for PixelBufferHandle {}

    impl PixelBufferHandle {
        #[must_use]
        pub fn new(buffer: CFRetained<CVPixelBuffer>) -> Self {
            Self(buffer)
        }

        /// Borrow the buffer in the form VideoToolbox wants.
        #[must_use]
        pub fn image_buffer(&self) -> &CVImageBuffer {
            &self.0
        }

        #[must_use]
        pub fn width(&self) -> u32 {
            CVPixelBufferGetWidth(&self.0) as u32
        }

        #[must_use]
        pub fn height(&self) -> u32 {
            CVPixelBufferGetHeight(&self.0) as u32
        }

        /// Lock for reading; the matching unlock happens when the guard drops.
        #[must_use]
        pub fn lock(&self) -> Option<LockedPixels<'_>> {
            // SAFETY: a plain lock on a buffer we hold a reference to.
            if unsafe {
                CVPixelBufferLockBaseAddress(&self.0, CVPixelBufferLockFlags::ReadOnly)
            } != 0
            {
                return None;
            }
            // SAFETY: valid until the unlock in `Drop`.
            let base = CVPixelBufferGetBaseAddress(&self.0).cast::<u8>();
            if base.is_null() {
                // SAFETY: matches the successful lock above.
                unsafe {
                    CVPixelBufferUnlockBaseAddress(&self.0, CVPixelBufferLockFlags::ReadOnly);
                }
                return None;
            }
            Some(LockedPixels {
                buffer: &self.0,
                base,
                bytes_per_row: CVPixelBufferGetBytesPerRow(&self.0),
                height: CVPixelBufferGetHeight(&self.0),
            })
        }
    }

    /// A read-locked pixel buffer. Unlocks on drop, so no early return can
    /// leave a buffer locked and stall every later frame.
    pub struct LockedPixels<'a> {
        buffer: &'a CVPixelBuffer,
        base: *const u8,
        bytes_per_row: usize,
        height: usize,
    }

    impl LockedPixels<'_> {
        #[must_use]
        pub fn bytes_per_row(&self) -> usize {
            self.bytes_per_row
        }

        #[must_use]
        pub fn height(&self) -> usize {
            self.height
        }

        #[must_use]
        pub fn row(&self, index: usize) -> &[u8] {
            debug_assert!(index < self.height);
            // SAFETY: `index < height` and the row is `bytes_per_row` bytes
            // inside a buffer at least that large, held locked by `self`.
            unsafe { std::slice::from_raw_parts(self.base.add(index * self.bytes_per_row), self.bytes_per_row) }
        }
    }

    impl Drop for LockedPixels<'_> {
        fn drop(&mut self) {
            // SAFETY: matches the lock that produced this guard.
            unsafe {
                CVPixelBufferUnlockBaseAddress(self.buffer, CVPixelBufferLockFlags::ReadOnly);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use pixel_buffer::PixelBufferHandle;

/// A live capture session.
///
/// `next_frame` is expected to coalesce: the implementation keeps at most one
/// pending frame and drops older ones. A capture source that queues frames
/// would accumulate latency that no later stage can remove.
///
/// Deliberately not `Send`: platform capture objects (ScreenCaptureKit in
/// particular) are not thread-safe, so the session is created *inside* the
/// pipeline thread and never crosses a thread boundary.
pub trait Capture {
    /// Wait up to `timeout` for the newest frame, then drain to the latest.
    fn next_frame(&mut self, timeout: Duration) -> Option<Arc<RawFrame>>;
    /// A human-readable reason the session ended, when it ended abnormally.
    fn failure(&self) -> Option<String>;
    fn stop(&mut self);
}

/// Requested capture geometry. `width`/`height` are the *target pixel* size:
/// the capturer scales the display down to fit inside this box, preserving
/// aspect ratio, before the pixels ever reach Rust.
#[derive(Clone, Copy, Debug)]
pub struct CaptureRequest {
    pub display_id: Option<u32>,
    /// When set, capture this window instead of a display.
    pub window_id: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub shows_cursor: bool,
}

/// Whether the OS has already granted screen-recording access to this process.
///
/// On macOS this is TCC `Screen Recording`, which is a *different* grant from
/// the accessibility permission the AX worker uses.
#[must_use]
pub fn permission_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::permission_granted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Ask the OS for screen-recording access if it has not been granted yet.
/// Returns whether access is available *now*; on macOS the user normally has
/// to answer a system prompt and retry.
#[must_use]
pub fn request_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_permission()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// What to tell the user when screen recording has not been granted.
#[must_use]
pub fn permission_hint() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        macos::PERMISSION_HINT
    }
    #[cfg(not(target_os = "macos"))]
    {
        "此平台尚未实现屏幕捕获"
    }
}

/// Resolve the application window worth watching.
///
/// With computer use, the app the agent is driving is by construction the
/// frontmost one — `ax.rs` refuses to act on a non-foreground app
/// (`FOREGROUND_REQUIRED`) — so "the window being operated" and "the frontmost
/// app's window" are the same question, and the second one needs no plumbing
/// through the accessibility worker.
///
/// Returns `None` when there is nothing sensible to show, which the caller
/// treats as "fall back to the display".
pub fn frontmost_app_target() -> Result<Option<DisplayInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::frontmost_app_target()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

/// Enumerate capturable displays without starting a stream.
pub fn displays() -> Result<Vec<DisplayInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::displays()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("此平台尚未实现屏幕捕获".into())
    }
}

/// Start capturing.
pub fn open(request: CaptureRequest) -> Result<Box<dyn Capture>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::open(request)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Err("此平台尚未实现屏幕捕获".into())
    }
}

#[cfg(target_os = "macos")]
pub mod macos;
