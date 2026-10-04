//! ScreenCaptureKit capture backend.
//!
//! ScreenCaptureKit is the only supported macOS API that gives us (a) the
//! pixel format we want, (b) GPU-side scaling to the preview resolution, and
//! (c) a real frame callback at a chosen rate. `CGDisplayStream` is deprecated
//! and `CGWindowListCreateImage` cannot hold a frame rate.
//!
//! Threading: the whole session lives on the pipeline thread. The async
//! shareable-content lookup and the start handshake are bridged with channels,
//! and the stream output object coalesces to one pending frame, which is what
//! keeps capture latency bounded.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::CVPixelBuffer;
use objc2_foundation::{NSArray, NSError, NSObject};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCShareableContent, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
};

use super::{Capture, CaptureRequest, DisplayInfo, PixelBufferHandle, Pixels, RawFrame};

/// `'BGRA'` as an `OSType`: packed 8-bit components, which both the JPEG
/// encoder and a future `CVPixelBuffer`-native encoder accept directly.
const PIXEL_FORMAT_BGRA: u32 = u32::from_be_bytes(*b"BGRA");

/// Longest we will wait for an async ScreenCaptureKit handshake. When
/// permission is already granted these answer in single-digit milliseconds;
/// when it is not, they can hang, so the timeout is what turns a silent stall
/// into a diagnosable error.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// One pending frame between the stream callback and the pipeline. Capacity 1
/// *is* the coalescing policy: `try_send` fails while the previous frame is
/// unconsumed, and the callback drops the new frame rather than queueing it.
const FRAME_SLOT_CAPACITY: usize = 1;

/// Shown whenever TCC has not granted screen recording. This prompt is the one
/// place the feature can silently do nothing, so the message names the exact
/// path the user has to take.
pub const PERMISSION_HINT: &str =
    "需要在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 Orbit，然后重新开启屏幕预览";

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Provisional label. Which display is the main one is decided later, by
/// global origin rather than by array position (`mark_primary` in the parent
/// module).
fn display_name(index: usize) -> String {
    format!("显示器 {}", index + 1)
}

/// State shared between the pipeline thread and the Objective-C stream output.
struct Shared {
    sender: SyncSender<Arc<RawFrame>>,
    stopped: AtomicBool,
    failure: Mutex<Option<String>>,
}

struct OutputIvars {
    shared: Arc<Shared>,
}

define_class!(
    // SAFETY: `NSObject` has no subclassing requirements and this class does
    // not implement `Drop`; every ivar is `Send + Sync`.
    #[unsafe(super(NSObject))]
    #[name = "OrbitScreenStreamOutput"]
    #[ivars = OutputIvars]
    struct StreamOutput;

    unsafe impl NSObjectProtocol for StreamOutput {}

    unsafe impl SCStreamOutput for StreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output_sample_buffer(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if of_type != SCStreamOutputType::Screen {
                return;
            }
            let shared = &self.ivars().shared;
            if shared.stopped.load(Ordering::Acquire) {
                return;
            }
            // SAFETY: ScreenCaptureKit hands us a live screen sample buffer
            // whose pixel buffer stays valid for the duration of this call.
            let Some(frame) = (unsafe { retain_frame(sample_buffer) }) else {
                return;
            };
            match shared.sender.try_send(Arc::new(frame)) {
                // A full slot means the pipeline has not consumed the previous
                // frame yet; the newer frame replaces nothing, so it is simply
                // dropped here and the next callback wins.
                Ok(()) | Err(TrySendError::Full(_)) => {}
                Err(TrySendError::Disconnected(_)) => {
                    shared.stopped.store(true, Ordering::Release);
                }
            }
        }
    }

    unsafe impl SCStreamDelegate for StreamOutput {
        #[unsafe(method(stream:didStopWithError:))]
        fn did_stop_with_error(&self, _stream: &SCStream, error: &NSError) {
            let shared = &self.ivars().shared;
            shared.stopped.store(true, Ordering::Release);
            if let Ok(mut failure) = shared.failure.lock() {
                *failure = Some(format!("屏幕捕获已停止：{}", error.localizedDescription()));
            }
        }
    }
);

impl StreamOutput {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(OutputIvars { shared });
        // SAFETY: `NSObject`'s `init` is the designated initializer here and
        // leaves the ivars we just set untouched.
        unsafe { msg_send![super(this), init] }
    }
}

/// Take ownership of the captured frame's pixel buffer.
///
/// No pixels are copied: the retained IOSurface-backed buffer travels to the
/// pipeline thread and is handed straight to VideoToolbox. Only the JPEG
/// encoder ever reads its bytes, and it does so under a read lock.
///
/// # Safety
/// `sample_buffer` must be a valid screen sample buffer owned by the caller
/// for the duration of the call.
unsafe fn retain_frame(sample_buffer: &CMSampleBuffer) -> Option<RawFrame> {
    // SAFETY: guarded by the caller's contract. The sample buffer does not
    // transfer its reference, so `image_buffer` takes one of its own.
    let buffer: CFRetained<CVPixelBuffer> = unsafe { sample_buffer.image_buffer() }?;
    let handle = PixelBufferHandle::new(buffer);
    let (width, height) = (handle.width(), handle.height());
    if width == 0 || height == 0 {
        return None;
    }
    Some(RawFrame {
        width,
        height,
        captured_at_ms: now_ms(),
        pixels: Pixels::PixelBuffer(handle),
    })
}

fn describe_display(display: &SCDisplay, index: usize) -> DisplayInfo {
    // SAFETY: every call is a value-returning getter on a display that
    // ScreenCaptureKit owns for the duration of the snapshot.
    unsafe {
        let id = display.displayID();
        let frame = display.frame();
        let pixel_width = display.width() as u32;
        let pixel_height = display.height() as u32;
        let logical_width = if frame.size.width > 0.0 {
            frame.size.width
        } else {
            f64::from(pixel_width)
        };
        let logical_height = if frame.size.height > 0.0 {
            frame.size.height
        } else {
            f64::from(pixel_height)
        };
        let scale = if logical_width > 0.0 {
            f64::from(pixel_width) / logical_width
        } else {
            1.0
        };
        DisplayInfo {
            id,
            name: display_name(index),
            logical_x: frame.origin.x,
            logical_y: frame.origin.y,
            logical_width,
            logical_height,
            pixel_width,
            pixel_height,
            scale,
            primary: false,
        }
    }
}

/// A shareable-content snapshot plus the display metadata derived from it.
struct Snapshot {
    content: Retained<SCShareableContent>,
    displays: Vec<DisplayInfo>,
}

/// Blocking wrapper around ScreenCaptureKit's completion-handler lookup.
fn shareable_content() -> Result<Snapshot, String> {
    let (sender, receiver) = mpsc::sync_channel::<Result<Retained<SCShareableContent>, String>>(1);
    let block = block2::RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: `content` and `error` are the callback's parameters and
            // are valid for the duration of the call.
            let result = if let Some(content) = unsafe { content.as_ref() } {
                // SAFETY: the caller does not own the returned object, so we
                // take our own reference before handing it to the channel.
                Ok(unsafe { Retained::retain(std::ptr::from_ref(content).cast_mut()) }.unwrap())
            } else if let Some(error) = unsafe { error.as_ref() } {
                Err(format!("读取显示器列表失败：{}", error.localizedDescription()))
            } else {
                Err("读取显示器列表失败：ScreenCaptureKit 未返回内容".into())
            };
            let _ = sender.try_send(result);
        },
    );
    // SAFETY: the block matches the expected signature; the class method is
    // callable from any thread.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&block) };
    let content = receiver
        .recv_timeout(HANDSHAKE_TIMEOUT)
        .map_err(|_| format!("读取显示器列表超时。{PERMISSION_HINT}"))??;
    // SAFETY: `content` is the snapshot we just received.
    let array = unsafe { content.displays() };
    let mut displays = Vec::with_capacity(array.len());
    for index in 0..array.len() {
        displays.push(describe_display(&array.objectAtIndex(index), index));
    }
    if let Some(first) = displays.first_mut() {
        first.primary = first.logical_x == 0.0 && first.logical_y == 0.0;
    }
    if displays.is_empty() {
        return Err(format!("没有可捕获的显示器。{PERMISSION_HINT}"));
    }
    Ok(Snapshot { content, displays })
}

pub(super) fn permission_granted() -> bool {
    CGPreflightScreenCaptureAccess()
}

pub(super) fn request_permission() -> bool {
    // Shows the system prompt at most once per process; the answer only
    // becomes true after the user grants access and restarts Orbit.
    CGRequestScreenCaptureAccess()
}

pub(super) fn displays() -> Result<Vec<DisplayInfo>, String> {
    if !permission_granted() {
        return Err(PERMISSION_HINT.into());
    }
    Ok(shareable_content()?.displays)
}

struct MacCapture {
    stream: Retained<SCStream>,
    /// Kept alive for the stream's lifetime: ScreenCaptureKit holds an
    /// unowned reference to its outputs, so dropping this would leave the
    /// callback pointing at freed memory. Never read, always required.
    #[allow(dead_code, reason = "owns the stream output for the stream's lifetime")]
    output: Retained<StreamOutput>,
    /// Kept alive so the sample handler queue outlives the stream.
    #[allow(dead_code)]
    queue: dispatch2::DispatchRetained<DispatchQueue>,
    receiver: Receiver<Arc<RawFrame>>,
    shared: Arc<Shared>,
}

impl MacCapture {
    fn new(request: CaptureRequest) -> Result<Self, String> {
        if !permission_granted() {
            return Err(PERMISSION_HINT.into());
        }
        let snapshot = shareable_content()?;
        let target = request
            .display_id
            .and_then(|id| snapshot.displays.iter().position(|display| display.id == id))
            .or_else(|| snapshot.displays.iter().position(|display| display.primary))
            .ok_or_else(|| "没有可捕获的显示器".to_string())?;
        // SAFETY: reading a display out of the snapshot we still hold.
        let display = unsafe { snapshot.content.displays() }.objectAtIndex(target);

        let (sender, receiver) = mpsc::sync_channel(FRAME_SLOT_CAPACITY);
        let shared = Arc::new(Shared {
            sender,
            stopped: AtomicBool::new(false),
            failure: Mutex::new(None),
        });
        let output = StreamOutput::new(shared.clone());
        let queue = DispatchQueue::new("com.orbit.screen.capture", None);

        // SAFETY: all ScreenCaptureKit objects below are configured before the
        // stream is handed to the runtime, and `display`, `output` and `queue`
        // outlive the stream (they are stored on `Self`).
        let stream = unsafe {
            let filter = SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::<SCWindow>::from_slice(&[]),
            );
            let configuration = SCStreamConfiguration::new();
            configuration.setWidth(request.width as usize);
            configuration.setHeight(request.height as usize);
            // Scalng inside the capture pipeline is GPU work; doing it here is
            // the difference between a cheap preview and a full-resolution CPU
            // downscale on every frame.
            configuration.setScalesToFit(true);
            configuration.setPreservesAspectRatio(true);
            configuration.setPixelFormat(PIXEL_FORMAT_BGRA);
            configuration.setShowsCursor(request.shows_cursor);
            // A short queue plus one-slot coalescing keeps latency low; a deep
            // queue only adds throughput, which a preview does not need.
            configuration.setQueueDepth(3);
            configuration.setMinimumFrameInterval(CMTime::new(1, request.fps.clamp(1, 60) as i32));

            let stream = SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &configuration,
                Some(ProtocolObject::from_ref(&*output)),
            );
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*output),
                    SCStreamOutputType::Screen,
                    Some(&queue),
                )
                .map_err(|error| format!("无法附加屏幕输出：{}", error.localizedDescription()))?;
            stream
        };
        start_capture(&stream)?;
        Ok(Self {
            stream,
            output,
            queue,
            receiver,
            shared,
        })
    }
}

/// Start the stream and wait for the completion handler, so the caller learns
/// about permission and configuration problems before the phone is told the
/// preview is live.
fn start_capture(stream: &SCStream) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel::<Option<String>>(1);
    let block = block2::RcBlock::new(move |error: *mut NSError| {
        // SAFETY: null or a valid NSError for the duration of the call.
        let message = unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
        let _ = sender.try_send(message);
    });
    // SAFETY: the completion handler is invoked exactly once.
    unsafe { stream.startCaptureWithCompletionHandler(Some(&block)) };
    match receiver.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(None) => Ok(()),
        Ok(Some(message)) => Err(format!("启动屏幕捕获失败：{message}")),
        Err(_) => Err(format!("启动屏幕捕获超时。{PERMISSION_HINT}")),
    }
}

impl Capture for MacCapture {
    fn next_frame(&mut self, timeout: Duration) -> Option<Arc<RawFrame>> {
        let first = self.receiver.recv_timeout(timeout).ok()?;
        // Drain to the newest pending frame: anything older is stale by
        // definition, and delivering it would only add latency.
        let mut newest = first;
        while let Ok(newer) = self.receiver.try_recv() {
            newest = newer;
        }
        Some(newest)
    }

    fn failure(&self) -> Option<String> {
        self.shared
            .failure
            .lock()
            .ok()
            .and_then(|failure| failure.clone())
    }

    fn stop(&mut self) {
        if self.shared.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        let block = block2::RcBlock::new(|_error: *mut NSError| {});
        // SAFETY: stopping is idempotent and the completion handler only
        // signals completion.
        unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&block)) };
    }
}

impl Drop for MacCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(super) fn open(request: CaptureRequest) -> Result<Box<dyn Capture>, String> {
    Ok(Box::new(MacCapture::new(request)?))
}
