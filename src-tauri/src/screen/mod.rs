//! Screen channel: capture → encode → latest-frame bus.
//!
//! Design and protocol live in `docs/SCREEN.md`. The four invariants this
//! module exists to enforce:
//!
//! 1. **Latest wins, never queue.** The bus holds one frame. A client that
//!    falls behind skips to the newest frame instead of accumulating a
//!    backlog that no later stage can drain.
//! 2. **One encode, many viewers.** Encoding happens once per frame; every
//!    subscriber receives the same envelope.
//! 3. **The screen never touches the control channel.** Frames travel on
//!    their own WebSocket (the phone opens a second client), so a 200 KB
//!    frame cannot delay a thinking token or an input acknowledgement.
//! 4. **Never encode a frame nobody can receive.** H.264 frames depend on
//!    their predecessors, so dropping one corrupts everything after it — and
//!    a single-slot bus drops by design. The pipeline therefore publishes only
//!    while a subscriber is still waiting for the previous frame, and falls
//!    back to an explicit keyframe if one ever falls behind anyway.

// Platforms without a capture backend still compile the protocol, the bus, and
// the input mapping (so the mobile client and its tests stay portable), but
// nothing can reach the pipeline, which makes most of it dead code there.
#![cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "no capture backend on this platform, so the pipeline is unreachable")
)]

pub mod capture;
pub mod encode;
pub mod input;

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use capture::{Capture, CaptureRequest, DisplayInfo};
use encode::{Codec, Encoder};

/// How long the pipeline keeps a live capture stream after the last viewer
/// leaves. Restarting ScreenCaptureKit costs a few hundred milliseconds and
/// flashes the menu-bar recording indicator, so a short grace period makes
/// tab switching on the phone feel instant.
const IDLE_GRACE: Duration = Duration::from_secs(20);

/// Sampling window for the bandwidth governor.
const GOVERNOR_WINDOW: Duration = Duration::from_millis(1000);

/// Byte budget the governor aims at for JPEG.
///
/// Full-frame JPEG cannot fit a moving Retina desktop into a phone link, which
/// is exactly why H.264 is the default; this budget is what keeps the fallback
/// usable rather than spectacular.
const JPEG_BUDGET_BYTES_PER_SECOND: u64 = 2_500_000;

/// Bitrate range the governor maps its quality scale onto for H.264.
///
/// The top of the range is a *ceiling*, not a target: rate control only spends
/// what the picture needs, so a static screen stays at a few hundred kilobits
/// even here. It is set high because the ceiling is also what decides whether
/// maximum clarity and a high frame rate can co-exist on a good link — at
/// 1080p-class resolution, 120 fps and quality 90, a low ceiling would silently
/// become the thing that limits sharpness.
const H264_MIN_BITRATE: u32 = 1_500_000;
const H264_BITRATE_STEP: u32 = 260_000;

/// Hard ceiling on one encoded frame.
///
/// The relay refuses a WebSocket frame above 1 MiB, and a relayed frame is
/// double base64 (payload → envelope → AES-GCM ciphertext), so it costs about
/// 1.78x the encoded size. A frame that would not survive that trip is dropped
/// and answered with an aggressive downshift, because a silently closed relay
/// socket is far worse than one missing frame.
const MAX_FRAME_BYTES: usize = 480_000;

/// Lowest quality the governor will fall back to before it starts trading
/// frame rate. Below this the picture stops being readable, which is worse
/// than a slower refresh.
const QUALITY_FLOOR: u8 = 40;

/// How long to wait for the capture session to report whether it opened.
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// How often to check whether the operated application changed.
///
/// A second is the right order: faster would poll AppKit for no reason, slower
/// would leave the preview showing the previous application while the agent has
/// visibly moved on.
const TARGET_RECHECK: Duration = Duration::from_secs(1);

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Clamped client-requested limits. The phone asks for a "shape", the host
/// decides whether it is reasonable.
///
/// The defaults sit at the ceiling rather than in the middle: the caller that
/// asks for nothing should get the most the machine can do, with the governor
/// discovering the link's real capacity by walking down from there.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSettings {
    #[serde(default)]
    pub max_width: Option<u32>,
    #[serde(default)]
    pub max_fps: Option<u32>,
    #[serde(default)]
    pub quality: Option<u8>,
    #[serde(default)]
    pub display_id: Option<u32>,
    #[serde(default)]
    pub show_cursor: Option<bool>,
    /// `"h264"` or `"jpeg"`. Defaults to `"h264"`; the host reports the codec
    /// it actually used in the `screen.start` reply.
    #[serde(default)]
    pub codec: Option<String>,
    /// `"app"` to follow the frontmost application's window, `"display"` for a
    /// whole screen. Defaults to `"app"`.
    #[serde(default)]
    pub source: Option<String>,
}

/// Which region the preview follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    /// The frontmost application's window: with computer use, the app the agent
    /// is driving is by construction the frontmost one.
    App,
    /// A whole display.
    Display,
}

impl Source {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "app" => Some(Source::App),
            "display" => Some(Source::Display),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Source::App => "app",
            Source::Display => "display",
        }
    }
}

/// Fully resolved capture parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Resolved {
    max_width: u32,
    max_fps: u32,
    quality: u8,
    display_id: Option<u32>,
    show_cursor: bool,
    codec: Codec,
    source: Source,
    /// Derived frame size. Part of the identity because a change here requires
    /// a new capture session *and* a new encoder.
    frame_width: u32,
    frame_height: u32,
}

impl Resolved {
    fn with_frame_size(mut self, width: u32, height: u32) -> Self {
        self.frame_width = width;
        self.frame_height = height;
        self
    }
}

impl ScreenSettings {
    fn resolve(&self) -> Resolved {
        Resolved {
            // 1600 px keeps UI text legible without paying for a Retina-sized
            // frame; the client can ask for less on a phone screen.
            max_width: self.max_width.unwrap_or(2560).clamp(320, 2560),
            // 120 is the ceiling, not 60: a 120 Hz panel is common on phones
            // now, and the frame rate is the largest single latency term (half
            // a frame interval of pacing). The client asks for its own panel's
            // rate; anything above that is invisible.
            max_fps: self.max_fps.unwrap_or(60).clamp(1, 120),
            quality: self.quality.unwrap_or(90).clamp(30, 90),
            display_id: self.display_id,
            show_cursor: self.show_cursor.unwrap_or(true),
            codec: Codec::parse(self.codec.as_deref().unwrap_or("h264")).unwrap_or(Codec::H264),
            // Following the operated app is the default because that is what
            // the preview is for; a whole display stays one setting away.
            source: Source::parse(self.source.as_deref().unwrap_or("app")).unwrap_or(Source::App),
            frame_width: 0,
            frame_height: 0,
        }
    }

    /// Validate a client request before it reaches the capture backend, so a
    /// bad shape fails with a message instead of a silent clamp.
    fn resolve_checked(&self) -> Result<(), String> {
        if let Some(width) = self.max_width {
            if !(160..=3840).contains(&width) {
                return Err("maxWidth 必须在 160 到 3840 之间".into());
            }
        }
        if let Some(fps) = self.max_fps {
            if !(1..=120).contains(&fps) {
                return Err("maxFps 必须在 1 到 120 之间".into());
            }
        }
        if let Some(quality) = self.quality {
            if !(20..=95).contains(&quality) {
                return Err("quality 必须在 20 到 95 之间".into());
            }
        }
        if let Some(codec) = self.codec.as_deref() {
            if Codec::parse(codec).is_none() {
                return Err(format!("不支持的编码格式：{codec}"));
            }
        }
        if let Some(source) = self.source.as_deref() {
            if Source::parse(source).is_none() {
                return Err(format!("不支持的画面来源：{source}"));
            }
        }
        Ok(())
    }
}

/// One encoded frame plus the envelope that will be sent verbatim.
///
/// The individual fields are metadata for diagnostics; the transport itself
/// only reads `seq` and `envelope`.
#[allow(dead_code, reason = "frame metadata for stats and diagnostics")]
pub struct EncodedFrame {
    pub seq: u64,
    pub captured_at_ms: u128,
    pub encoded_at_ms: u128,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub display: DisplayInfo,
    /// Serialized `screen.frame` message, ready to send or to encrypt. Built
    /// once per frame and shared by every subscriber.
    pub envelope: Arc<str>,
}

/// One subscriber's delivery state.
struct Entry {
    cursor: u64,
    wake: tokio::sync::mpsc::Sender<()>,
}

/// Single-slot fan-out for encoded frames.
pub struct ScreenBus {
    latest: Mutex<Option<Arc<EncodedFrame>>>,
    /// The sequence of the frame in `latest`, stored after it so a reader that
    /// observes a new version is guaranteed to see the matching frame.
    version: AtomicU64,
    subscribers: AtomicUsize,
    published: AtomicU64,
    /// Set when a viewer joins so the pipeline emits a key frame even if the
    /// desktop has not changed since the last one. Without this, a phone that
    /// opens the screen tab on an idle desktop would stare at nothing.
    refresh: AtomicBool,
    /// Set when a subscriber skipped frames, meaning its decoder lost the
    /// reference chain and needs a fresh keyframe.
    resync: AtomicBool,
    /// Per-subscriber state, keyed by subscription id.
    ///
    /// Two facts live here, and both exist for the same reason — that the frame
    /// path must not poll:
    ///
    /// * the **cursor**: where this subscriber has been delivered to, whose
    ///   minimum is [`ScreenBus::delivered`]. That single number is what keeps
    ///   an inter-frame codec legal: the pipeline publishes only while every
    ///   subscriber has consumed the previous frame, so a frame is never
    ///   produced that the transport would have to drop.
    /// * the **wake channel**: how the connection loop learns a frame exists.
    ///   Without it a loop can only ask on a timer, and a timer is a latency
    ///   floor under every frame. Capacity one plus `try_send` is the right
    ///   shape for a single-slot bus: the signal is a *fact* ("something is
    ///   pending"), not a queue, so signalling while one is already pending is a
    ///   no-op rather than a backlog.
    entries: Mutex<std::collections::HashMap<u64, Entry>>,
    /// Cached minimum of the cursors.
    delivered: AtomicU64,
    next_subscription_id: AtomicU64,
}

impl Default for ScreenBus {
    fn default() -> Self {
        Self {
            latest: Mutex::new(None),
            version: AtomicU64::new(0),
            subscribers: AtomicUsize::new(0),
            published: AtomicU64::new(0),
            refresh: AtomicBool::new(false),
            resync: AtomicBool::new(false),
            entries: Mutex::new(std::collections::HashMap::new()),
            delivered: AtomicU64::new(0),
            next_subscription_id: AtomicU64::new(1),
        }
    }
}

impl ScreenBus {
    #[must_use]
    pub fn subscribers(&self) -> usize {
        self.subscribers.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn published(&self) -> u64 {
        self.published.load(Ordering::Acquire)
    }

    fn publish(&self, frame: EncodedFrame) {
        let seq = frame.seq;
        let frame = Arc::new(frame);
        if let Ok(mut latest) = self.latest.lock() {
            *latest = Some(frame);
        }
        // The version is bumped only after `latest` holds the matching frame,
        // so a reader that observes a new version cannot read a stale frame.
        self.version.store(seq, Ordering::Release);
        self.published.fetch_add(1, Ordering::AcqRel);
        // Wake every subscriber's sender. A full channel already means "there is
        // something to send", so the failure case needs no handling.
        if let Ok(entries) = self.entries.lock() {
            for entry in entries.values() {
                let _ = entry.wake.try_send(());
            }
        }
    }

    fn clear(&self) {
        if let Ok(mut latest) = self.latest.lock() {
            *latest = None;
        }
    }

    /// Take a pending refresh request, if any.
    fn take_refresh(&self) -> bool {
        self.refresh.swap(false, Ordering::AcqRel)
    }

    /// Take a pending resync request, if any.
    fn take_resync(&self) -> bool {
        self.resync.swap(false, Ordering::AcqRel)
    }

    /// Geometry of the frame currently on screen, if any.
    ///
    /// Input maps onto this rather than onto a value cached at start: in app
    /// mode the target window changes while the stream runs, and a touch that
    /// mapped onto the previous window's rectangle would land somewhere else on
    /// the computer entirely.
    fn target(&self) -> Option<DisplayInfo> {
        self.latest
            .lock()
            .ok()
            .and_then(|latest| latest.as_ref().map(|frame| frame.display.clone()))
    }

    /// The slowest subscriber's delivered sequence.
    fn delivered(&self) -> u64 {
        self.delivered.load(Ordering::Acquire)
    }

    /// Register a subscriber and its wake channel.
    fn register(&self, subscription: u64, cursor: u64, wake: tokio::sync::mpsc::Sender<()>) {
        let minimum = match self.entries.lock() {
            Ok(mut entries) => {
                entries.insert(subscription, Entry { cursor, wake });
                entries.values().map(|entry| entry.cursor).min().unwrap_or(cursor)
            }
            Err(_) => cursor,
        };
        self.delivered.store(minimum, Ordering::Release);
    }

    /// Record where one subscription has been delivered to, and refresh the
    /// cached minimum.
    fn ack(&self, subscription: u64, seq: u64) {
        let minimum = match self.entries.lock() {
            Ok(mut entries) => {
                match entries.get_mut(&subscription) {
                    Some(entry) => entry.cursor = seq,
                    // A delivery from a subscription that already unregistered
                    // (a disconnect racing a final frame) is not an error.
                    None => return,
                }
                entries.values().map(|entry| entry.cursor).min().unwrap_or(seq)
            }
            Err(_) => seq,
        };
        self.delivered.store(minimum, Ordering::Release);
    }

    fn forget(&self, subscription: u64) {
        let minimum = match self.entries.lock() {
            Ok(mut entries) => {
                entries.remove(&subscription);
                // With no subscribers left the minimum is the newest frame:
                // there is nothing to stay behind.
                entries.values().map(|entry| entry.cursor).min().unwrap_or(u64::MAX)
            }
            Err(_) => u64::MAX,
        };
        self.delivered.store(minimum, Ordering::Release);
    }

    /// Whether producing another frame is useful.
    ///
    /// This gate — not a rate limit — is what makes an inter-frame codec legal:
    /// publishing while the previous frame is still in flight would force the
    /// transport to drop one, and every frame after a dropped H.264 frame is
    /// undecodable.
    fn needs_frame(&self) -> bool {
        if self.subscribers() == 0 {
            return false;
        }
        // Nothing published yet, or every subscriber has consumed the last one.
        let version = self.version.load(Ordering::Acquire);
        version == 0 || self.delivered() >= version
    }
}

/// Per-connection subscription state: whether this connection is watching, and
/// the last frame sequence it has been sent.
///
/// The display geometry deliberately is *not* cached here. It lives on
/// [`ScreenHost`], so when one viewer changes monitor and the pipeline
/// restarts, every other viewer's input mapping follows along instead of
/// silently pointing at the old screen.
pub struct ScreenSubscription {
    bus: Arc<ScreenBus>,
    /// Identity used to publish this subscription's position to the bus.
    id: u64,
    active: AtomicBool,
    cursor: AtomicU64,
    wake: tokio::sync::mpsc::Sender<()>,
    /// Handed to the connection loop, which is the only thing that waits on it.
    /// `None` once taken.
    receiver: Mutex<Option<tokio::sync::mpsc::Receiver<()>>>,
}

impl ScreenSubscription {
    #[must_use]
    pub fn new(bus: Arc<ScreenBus>) -> Arc<Self> {
        let id = bus.next_subscription_id.fetch_add(1, Ordering::AcqRel);
        let (wake, receiver) = tokio::sync::mpsc::channel(1);
        Arc::new(Self {
            bus,
            id,
            active: AtomicBool::new(false),
            cursor: AtomicU64::new(0),
            wake,
            receiver: Mutex::new(Some(receiver)),
        })
    }

    /// Take the wake receiver, for the connection loop to wait on.
    ///
    /// Ownership moves rather than being shared because `recv` needs `&mut`, and
    /// exactly one loop ever waits on one subscription.
    pub fn take_wake(&self) -> Option<tokio::sync::mpsc::Receiver<()>> {
        self.receiver.lock().ok().and_then(|mut slot| slot.take())
    }

    #[must_use]
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn activate(&self) {
        // Skip whatever is already on the bus: it predates this subscriber.
        let version = self.bus.version.load(Ordering::Acquire);
        self.cursor.store(version, Ordering::Release);
        self.bus.refresh.store(true, Ordering::Release);
        if self.active.swap(true, Ordering::AcqRel) {
            self.bus.ack(self.id, version);
            return;
        }
        self.bus.subscribers.fetch_add(1, Ordering::AcqRel);
        self.bus.register(self.id, version, self.wake.clone());
    }

    pub fn deactivate(&self) {
        if self.active.swap(false, Ordering::AcqRel) {
            self.bus.subscribers.fetch_sub(1, Ordering::AcqRel);
            self.bus.forget(self.id);
        }
    }

    /// Geometry of the frame currently on screen, for input mapping.
    #[must_use]
    pub fn target(&self) -> Option<DisplayInfo> {
        self.bus.target()
    }

    /// The newest frame this connection has not yet been sent, if any.
    ///
    /// Skipping straight to the newest published frame is what makes a slow
    /// connection drop rather than lag. The cursor advances to the sequence of
    /// the frame that was actually returned, not to the version that was read:
    /// a publish can replace the frame between the two reads, and advancing to
    /// the version would then re-deliver the same frame on the next poll.
    #[must_use]
    pub fn poll(&self) -> Option<Arc<EncodedFrame>> {
        if !self.is_active() {
            return None;
        }
        let version = self.bus.version.load(Ordering::Acquire);
        let cursor = self.cursor.load(Ordering::Acquire);
        if version == 0 || version <= cursor {
            return None;
        }
        let frame = self.bus.latest.lock().ok().and_then(|latest| latest.clone())?;
        if frame.seq <= cursor {
            return None;
        }
        // A jump means frames were skipped while this connection was busy.
        // H.264 cannot recover from that on its own, so ask for a keyframe
        // rather than letting the decoder render garbage.
        if cursor != 0 && frame.seq > cursor + 1 {
            self.bus.resync.store(true, Ordering::Release);
        }
        self.cursor.store(frame.seq, Ordering::Release);
        self.bus.ack(self.id, frame.seq);
        Some(frame)
    }
}

impl Drop for ScreenSubscription {
    fn drop(&mut self) {
        self.deactivate();
    }
}

/// Counters the desktop UI and `screen.stats` report.
#[derive(Default)]
struct Stats {
    captured: AtomicU64,
    dropped: AtomicU64,
    /// Frames skipped because they were byte-identical to the previous frame.
    unchanged: AtomicU64,
    encode_micros_total: AtomicU64,
    encode_micros_max: AtomicU64,
    bytes_total: AtomicU64,
    bits_per_second: AtomicU64,
    effective_fps: AtomicU64,
    failure: Mutex<Option<String>>,
    /// Codec the running pipeline actually settled on, which can differ from
    /// the request when the platform has no hardware encoder.
    codec: Mutex<Option<Codec>>,
}

impl Stats {
    fn observe_encode(&self, micros: u64) {
        self.encode_micros_total.fetch_add(micros, Ordering::AcqRel);
        self.encode_micros_max.fetch_max(micros, Ordering::AcqRel);
    }

    fn failure(&self) -> Option<String> {
        self.failure.lock().ok().and_then(|failure| failure.clone())
    }

    fn set_failure(&self, message: String) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = Some(message);
        }
    }

    fn codec(&self) -> Option<Codec> {
        self.codec.lock().ok().and_then(|codec| *codec)
    }

    fn set_codec(&self, codec: Codec) {
        if let Ok(mut slot) = self.codec.lock() {
            *slot = Some(codec);
        }
    }
}

struct Pipeline {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    bus: Arc<ScreenBus>,
    stats: Arc<Stats>,
    resolved: Resolved,
    display: DisplayInfo,
    displays: Vec<DisplayInfo>,
}

impl Pipeline {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            // The loop re-checks `stop` every iteration and always tears the
            // capture session down on the way out, so waiting here is a
            // courtesy, not a requirement. Waiting unconditionally would let
            // an in-flight ScreenCaptureKit handshake (up to ten seconds) block
            // `screen.stop` / `screen_status`, and those run on the settings
            // page's request path. Reap only a thread that already finished.
            if handle.is_finished() {
                let _ = handle.join();
            }
        }
        self.bus.clear();
    }
}

/// Managed Tauri state for the screen channel.
pub struct ScreenHost {
    pipeline: Mutex<Option<Pipeline>>,
    bus: Arc<ScreenBus>,
    /// Geometry of the display currently being captured, or the display that
    /// *would* be captured. Read by the input path on every event.
    display: Mutex<Option<DisplayInfo>>,
    /// Set once from the app's setup hook, so every path that changes the
    /// status — a request, a stop, the pipeline's own tick — can push it.
    app: Mutex<Option<AppHandle>>,
}

impl Default for ScreenHost {
    fn default() -> Self {
        Self {
            pipeline: Mutex::new(None),
            bus: Arc::new(ScreenBus::default()),
            display: Mutex::new(None),
            app: Mutex::new(None),
        }
    }
}

impl ScreenHost {
    #[must_use]
    pub fn bus(&self) -> Arc<ScreenBus> {
        self.bus.clone()
    }

    /// Remember the app handle so status changes can be pushed to the UI.
    pub fn attach(&self, app: AppHandle) {
        if let Ok(mut slot) = self.app.lock() {
            *slot = Some(app);
        }
    }

    fn app(&self) -> Option<AppHandle> {
        self.app.lock().ok().and_then(|slot| slot.clone())
    }

    /// Push the current status to the desktop UI, if this process has one.
    fn push(&self) {
        if let Some(app) = self.app() {
            publish_status(&app, self);
        }
    }

    fn stop(&self) {
        if let Ok(mut slot) = self.pipeline.lock() {
            if let Some(pipeline) = slot.as_mut() {
                pipeline.stop();
            }
            *slot = None;
        }
        if let Ok(mut display) = self.display.lock() {
            *display = None;
        }
        self.push();
    }

    /// The display whose coordinates currently map to this session's input.
    #[must_use]
    pub fn display(&self) -> Option<DisplayInfo> {
        self.display.lock().ok().and_then(|display| display.clone())
    }

    fn set_display(&self, display: Option<DisplayInfo>) {
        if let Ok(mut slot) = self.display.lock() {
            *slot = display;
        }
    }

    /// Start the pipeline, or restart it when the requested shape changed.
    ///
    /// Restarts are cheap enough to be unconditional on change and are the
    /// only way to honour a viewer switching monitors or codecs. The last
    /// request wins, which matches how a single phone views one desktop.
    ///
    /// This holds the pipeline lock across startup, so a second `screen.start`
    /// waits for the first one's handshake instead of racing it into two
    /// capture sessions. Callers are per-connection socket threads, and the
    /// handshake is bounded by `OPEN_TIMEOUT`.
    fn ensure(&self, settings: ScreenSettings) -> Result<(DisplayInfo, Codec), String> {
        let mut requested = settings.resolve();
        let mut slot = self.pipeline.lock().map_err(|error| error.to_string())?;
        if let Some(pipeline) = slot.as_mut() {
            if pipeline.resolved == requested && !pipeline.stop.load(Ordering::Acquire) {
                let codec = pipeline.stats.codec().unwrap_or(requested.codec);
                return Ok((pipeline.display.clone(), codec));
            }
        }
        if let Some(mut previous) = slot.take() {
            previous.stop();
        }
        let app = self.app();
        let (pipeline, display) = match start_pipeline(self.bus.clone(), requested, app.clone()) {
            Ok(started) => started,
            Err(error) if requested.codec == Codec::H264 && unavailable_encoder(&error) => {
                // The platform has no hardware H.264 encoder. Downgrade once,
                // explicitly, instead of failing the request: a JPEG preview is
                // still a preview, and the reply tells the client what it got.
                requested.codec = Codec::Jpeg;
                start_pipeline(self.bus.clone(), requested, app).map_err(|_| error)?
            }
            Err(error) => return Err(error),
        };
        self.set_display(Some(display.clone()));
        let codec = pipeline.stats.codec().unwrap_or(requested.codec);
        *slot = Some(pipeline);
        drop(slot);
        self.push();
        Ok((display, codec))
    }

    fn status(&self) -> ScreenStatus {
        let slot = self.pipeline.lock().ok();
        let Some(pipeline) = slot.as_ref().and_then(|slot| slot.as_ref()) else {
            return ScreenStatus {
                running: false,
                permission: capture::permission_granted(),
                subscribers: self.bus.subscribers(),
                displays: capture::displays().unwrap_or_default(),
                failure: None,
                ..ScreenStatus::default()
            };
        };
        status_of(
            &pipeline.bus,
            &pipeline.stats,
            &pipeline.resolved,
            &pipeline.display,
            &pipeline.displays,
        )
    }
}

/// Build a status snapshot from the parts.
///
/// A free function because two callers own different halves of it: the host
/// reads the pipeline it holds, while the pipeline thread reports itself — and
/// the thread is the only one that knows the target it is *currently* following,
/// which changes while the stream runs.
fn status_of(
    bus: &ScreenBus,
    stats: &Stats,
    resolved: &Resolved,
    display: &DisplayInfo,
    displays: &[DisplayInfo],
) -> ScreenStatus {
    ScreenStatus {
        running: true,
        permission: capture::permission_granted(),
        subscribers: bus.subscribers(),
        codec: stats.codec().unwrap_or(resolved.codec).as_str().into(),
        source: resolved.source.as_str().into(),
        width: resolved.frame_width,
        height: resolved.frame_height,
        fps: resolved.max_fps as f32,
        effective_fps: stats.effective_fps.load(Ordering::Acquire) as f64 / 1000.0,
        quality: resolved.quality,
        displays: displays.to_vec(),
        display: Some(display.clone()),
        captured: stats.captured.load(Ordering::Acquire),
        published: bus.published(),
        dropped: stats.dropped.load(Ordering::Acquire),
        unchanged: stats.unchanged.load(Ordering::Acquire),
        encode_ms_avg: average(
            stats.encode_micros_total.load(Ordering::Acquire),
            bus.published(),
        ),
        encode_ms_max: stats.encode_micros_max.load(Ordering::Acquire) as f64 / 1000.0,
        bits_per_second: stats.bits_per_second.load(Ordering::Acquire) as f64,
        failure: stats.failure(),
    }
}

/// Whether an encoder failure is a missing platform encoder rather than a real
/// fault, which decides between downgrading and reporting.
fn unavailable_encoder(error: &str) -> bool {
    error.contains("没有可用的 H.264 编码器") || error.contains("此平台尚未实现")
}

fn average(total_micros: u64, samples: u64) -> f64 {
    if samples == 0 {
        return 0.0;
    }
    total_micros as f64 / samples as f64 / 1000.0
}

/// Snapshot reported to the desktop settings UI and to `screen.stats`.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenStatus {
    pub running: bool,
    pub permission: bool,
    pub subscribers: usize,
    pub codec: String,
    /// What capture actually followed, which can differ from the request when
    /// no application window was worth showing.
    pub source: String,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub effective_fps: f64,
    pub quality: u8,
    pub displays: Vec<DisplayInfo>,
    pub display: Option<DisplayInfo>,
    pub captured: u64,
    pub published: u64,
    pub dropped: u64,
    pub unchanged: u64,
    pub encode_ms_avg: f64,
    pub encode_ms_max: f64,
    pub bits_per_second: f64,
    pub failure: Option<String>,
}

/// Pick the capture box so the frame is *exactly* the display content.
///
/// ScreenCaptureKit letterboxes when the requested box has a different aspect
/// ratio than the display, and a letterboxed frame would break the normalized
/// input mapping. Deriving the height from the display's own aspect ratio
/// keeps the mapping linear.
fn capture_box(display: &DisplayInfo, max_width: u32) -> (u32, u32) {
    let logical_width = display.logical_width.max(1.0);
    let logical_height = display.logical_height.max(1.0);
    let scale = (f64::from(max_width) / logical_width).min(1.0);
    let even = |value: f64| {
        let rounded = value.round().max(2.0) as u32;
        rounded - (rounded % 2)
    };
    (even(logical_width * scale), even(logical_height * scale))
}

/// Pick the display to capture when the source is a whole screen.
fn pick_display(display_id: Option<u32>) -> Result<DisplayInfo, String> {
    let displays = capture::displays()?;
    display_id
        .and_then(|id| displays.iter().find(|display| display.id == id).cloned())
        .or_else(|| displays.iter().find(|display| display.primary).cloned())
        .or_else(|| displays.first().cloned())
        .ok_or_else(|| "没有可捕获的显示器".to_string())
}

/// Resolve what to capture for the current settings.
///
/// Following the app can come up empty — nothing is frontmost that is worth
/// showing, or the frontmost app is Orbit itself — and that is not an error:
/// it means "show the screen", which is what a person expects when the agent is
/// between applications.
fn resolve_target(resolved: &Resolved) -> Result<DisplayInfo, String> {
    match resolved.source {
        Source::Display => pick_display(resolved.display_id),
        Source::App => match capture::frontmost_app_target() {
            Ok(Some(target)) => Ok(target),
            Ok(None) => pick_display(resolved.display_id),
            Err(error) => {
                log::debug!("读取前台应用窗口失败，回退到显示器：{error}");
                pick_display(resolved.display_id)
            }
        },
    }
}

/// Open a capture session for a resolved target.
fn open_target(
    resolved: &Resolved,
    target: &DisplayInfo,
) -> Result<(Box<dyn Capture>, Resolved), String> {
    let (width, height) = capture_box(target, resolved.max_width);
    let request = CaptureRequest {
        display_id: (target.kind == capture::TargetKind::Display).then_some(target.id),
        window_id: (target.kind == capture::TargetKind::Window).then_some(target.id),
        width,
        height,
        // Capture at exactly the target rate. There is no second rate limiter
        // any more — publishing is gated on demand and on the byte budget, not
        // on a timer — so ScreenCaptureKit's own gate is the only one, and
        // doubling it would just allocate twice the frames at 120 Hz for
        // nothing.
        fps: resolved.max_fps.clamp(1, 120),
        shows_cursor: resolved.show_cursor,
    };
    Ok((capture::open(request)?, resolved.with_frame_size(width, height)))
}

/// Resolve the target display and start the pipeline thread.
///
/// The capture session itself is created *inside* the pipeline thread:
/// ScreenCaptureKit objects are not thread-safe, and the pipeline is the only
/// thread that ever touches them.
fn start_pipeline(
    bus: Arc<ScreenBus>,
    resolved: Resolved,
    app: Option<AppHandle>,
) -> Result<(Pipeline, DisplayInfo), String> {
    if !capture::permission_granted() {
        // Do not prompt from a background thread: the desktop UI offers an
        // explicit button, and the phone gets an actionable message.
        return Err(capture::permission_hint().to_string());
    }
    let display = resolve_target(&resolved)?;
    let (width, height) = capture_box(&display, resolved.max_width);
    let resolved = resolved.with_frame_size(width, height);

    let stats = Arc::new(Stats::default());
    let stop = Arc::new(AtomicBool::new(false));
    let (ready, opened) = std::sync::mpsc::sync_channel::<Result<Codec, String>>(1);
    let displays = capture::displays().unwrap_or_default();
    let handle = {
        let bus = bus.clone();
        let stats = stats.clone();
        let stop = stop.clone();
        let display = display.clone();
        let app = app.clone();
        thread::Builder::new()
            .name("orbit-screen-pipeline".into())
            .spawn(move || {
                let capture = match open_target(&resolved, &display) {
                    Ok((capture, _)) => capture,
                    Err(error) => {
                        let _ = ready.try_send(Err(error));
                        return;
                    }
                };
                match Encoder::new(
                    resolved.codec,
                    resolved.frame_width,
                    resolved.frame_height,
                    resolved.quality,
                    governor_bitrate(resolved.quality),
                    resolved.max_fps,
                ) {
                    Ok(encoder) => {
                        let codec = encoder.codec();
                        stats.set_codec(codec);
                        let _ = ready.try_send(Ok(codec));
                        pipeline_loop(capture, encoder, bus, stats, stop, resolved, display, app);
                    }
                    Err(error) => {
                        let mut capture = capture;
                        capture.stop();
                        let _ = ready.try_send(Err(error));
                    }
                }
            })
            .map_err(|error| format!("无法启动屏幕管线：{error}"))?
    };
    match opened.recv_timeout(OPEN_TIMEOUT) {
        Ok(Ok(_codec)) => Ok((
            Pipeline {
                stop,
                handle: Some(handle),
                bus,
                stats,
                resolved,
                display: display.clone(),
                displays,
            },
            display,
        )),
        Ok(Err(error)) => {
            stop.store(true, Ordering::Release);
            let _ = handle.join();
            Err(error)
        }
        Err(_) => {
            // The thread is stuck inside ScreenCaptureKit (normally a pending
            // TCC prompt). Signal it to stop and let it unwind on its own
            // rather than blocking the request.
            stop.store(true, Ordering::Release);
            Err(format!("启动屏幕捕获超时。{}", capture::permission_hint()))
        }
    }
}

/// The governor's quality scale mapped onto an H.264 bitrate.
pub(crate) fn governor_bitrate(quality: u8) -> u32 {
    let quality = u32::from(quality.clamp(20, 95));
    H264_MIN_BITRATE + (quality - 20) * H264_BITRATE_STEP
}

/// Adaptive downshift of frame rate, quality, and therefore bitrate.
///
/// Neither codec survives a phone link at its default settings: JPEG costs tens
/// of kilobytes per frame no matter how little changed, and H.264 at a fixed
/// bitrate will either starve a busy screen or waste a static one. This
/// measures what was actually sent and trades quality, then frame rate, to stay
/// inside the budget instead of collapsing into stalls.
struct Governor {
    quality: u8,
    /// The quality the client asked for. The governor degrades below it under
    /// pressure and recovers back to it, but never above: for a rate-controlled
    /// codec, being under budget is the normal state and is not evidence that
    /// the link can afford more.
    ceiling: u8,
    min_fps: u32,
    max_fps: u32,
    /// Byte budget per second, in the units the pipeline measures.
    budget: u64,
    fps: f64,
    relaxed_windows: u8,
    codec: Codec,
}

impl Governor {
    fn new(quality: u8, max_fps: u32, codec: Codec) -> Self {
        Self {
            quality,
            ceiling: quality,
            min_fps: 2,
            max_fps,
            budget: budget_bytes(codec, quality),
            fps: f64::from(max_fps),
            relaxed_windows: 0,
            codec,
        }
    }

    /// Push the current shape into the encoder. Quality *is* the bitrate knob
    /// for H.264, so one scale drives both codecs.
    fn apply(&mut self, encoder: &mut Encoder) {
        encoder.set_quality(self.quality);
        self.budget = budget_bytes(self.codec, self.quality);
    }

    /// React to a frame that is simply too large to send, regardless of the
    /// rolling budget.
    fn force_downshift(&mut self) {
        self.relaxed_windows = 0;
        if self.quality > QUALITY_FLOOR {
            self.quality = self.quality.saturating_sub(10).max(QUALITY_FLOOR);
        } else {
            self.fps = (self.fps - 1.0).max(f64::from(self.min_fps));
        }
    }

    /// Feed one window's byte count and adjust for the next window.
    fn observe(&mut self, bytes: u64) {
        if bytes > self.budget {
            self.relaxed_windows = 0;
            if self.quality > QUALITY_FLOOR {
                // Step proportionally to how far over the budget we are. With
                // the quality ceiling set to maximum — which is the default,
                // because a deliberately mediocre preview is a preview you have
                // to squint at — a fixed small step needs many seconds to
                // converge and the user watches it stutter the whole way.
                let ratio = (bytes / self.budget.max(1)).clamp(1, 16);
                let step = (6 * ratio).min(60) as u8;
                // Clamp on the way down: undershooting the floor would skip
                // straight past the frame-rate stage.
                self.quality = self.quality.saturating_sub(step).max(QUALITY_FLOOR);
            } else if self.fps > f64::from(self.min_fps) {
                self.fps = (self.fps - 1.0).max(f64::from(self.min_fps));
            }
        } else if bytes * 2 < self.budget {
            self.relaxed_windows = self.relaxed_windows.saturating_add(1);
            if self.relaxed_windows >= 3 {
                self.relaxed_windows = 0;
                if self.quality < self.ceiling {
                    self.quality = self.quality.saturating_add(4).min(self.ceiling);
                } else if self.fps < f64::from(self.max_fps) {
                    self.fps = (self.fps + 1.0).min(f64::from(self.max_fps));
                }
            }
        }
    }
}

/// Byte budget for the current shape.
///
/// JPEG is measured directly; H.264 has an explicit bitrate, so its budget is
/// the bitrate plus a quarter of headroom for the frames where the encoder
/// legitimately overshoots to catch a scene change.
fn budget_bytes(codec: Codec, quality: u8) -> u64 {
    match codec {
        Codec::Jpeg => JPEG_BUDGET_BYTES_PER_SECOND,
        Codec::H264 => u64::from(governor_bitrate(quality)) / 8 * 5 / 4,
    }
}

#[allow(clippy::too_many_arguments, reason = "one pipeline, one thread, one loop")]
fn pipeline_loop(
    mut capture: Box<dyn Capture>,
    mut encoder: Encoder,
    bus: Arc<ScreenBus>,
    stats: Arc<Stats>,
    stop: Arc<AtomicBool>,
    mut resolved: Resolved,
    mut display: DisplayInfo,
    app: Option<AppHandle>,
) {
    let codec = encoder.codec();
    let mut governor = Governor::new(resolved.quality, resolved.max_fps, codec);
    let mut last_window = Instant::now();
    let mut window_bytes = 0_u64;
    let mut window_frames = 0_u64;
    let mut last_frame_bytes = 0_u64;
    let mut empty_since: Option<Instant> = None;
    let mut seq = bus.version.load(Ordering::Acquire);
    // The first frame of a session is always a fresh start for the decoder.
    let mut announce_resync = true;
    let mut last_target_check = Instant::now();

    while !stop.load(Ordering::Acquire) {
        // Idle out once nobody is watching. `screen.start` from a new client
        // restarts the pipeline, so only the grace window is wasted.
        if bus.subscribers() == 0 {
            let since = *empty_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= IDLE_GRACE {
                break;
            }
        } else {
            empty_since = None;
        }
        if let Some(failure) = capture.failure() {
            stats.set_failure(failure);
            break;
        }

        // In app mode the target is not fixed: the agent moves between
        // applications, and the preview is supposed to show the one being
        // worked on. Re-resolving means a new capture session, which is a real
        // interruption — so it only happens when the window actually changed,
        // and the new session is opened before the old one is closed so a
        // failure here leaves the current picture running.
        if resolved.source == Source::App && last_target_check.elapsed() >= TARGET_RECHECK {
            last_target_check = Instant::now();
            match capture::frontmost_app_target() {
                Ok(Some(target)) if target.id != display.id => {
                    match open_target(&resolved, &target) {
                        Ok((next, next_resolved)) => {
                            capture.stop();
                            capture = next;
                            resolved = next_resolved;
                            display = target;
                            // A different window is a different picture, not a
                            // continuation of the previous one.
                            encoder.refresh();
                            announce_resync = true;
                        }
                        Err(error) => {
                            log::debug!("切换预览窗口失败，保持当前画面：{error}");
                        }
                    }
                }
                Ok(_) => {}
                Err(error) => log::debug!("读取前台应用窗口失败：{error}"),
            }
        }

        // Keep draining the capture stream even when nothing is encoded:
        // leaving frames queued would make the next real frame stale, and the
        // capturer's own coalescing only works if somebody is consuming.
        let Some(frame) = capture.next_frame(Duration::from_millis(120)) else {
            continue;
        };
        stats.captured.fetch_add(1, Ordering::AcqRel);

        // Somebody must be waiting: this is what keeps an inter-frame codec
        // legal, because publishing ahead of the viewers would force the
        // transport to drop a frame and corrupt everything after it.
        if !bus.needs_frame() {
            continue;
        }
        // Pace on bytes, not on a timer. A timer at the target rate throws away
        // the frame that happens to land just inside the interval — on real
        // hardware that alone cost half the frame rate (7.6 fps against a 15 fps
        // target) — and it caps a static screen, which costs almost nothing per
        // frame, at the same rate as a scrolling one. A byte budget lets an
        // idle desktop run at the full frame rate and throttles exactly when the
        // link cannot keep up.
        if window_bytes.saturating_add(last_frame_bytes) > governor.budget {
            stats.dropped.fetch_add(1, Ordering::AcqRel);
            continue;
        }

        // A joining viewer needs a keyframe; a viewer whose sequence numbers
        // jumped needs one even more urgently.
        if bus.take_refresh() | bus.take_resync() {
            encoder.refresh();
            announce_resync = true;
        }

        // A size change invalidates the reference chain, so it restarts the
        // encoder and is announced as a resync rather than hidden.
        if !encoder.matches_size(frame.width, frame.height) {
            match Encoder::new(
                codec,
                frame.width,
                frame.height,
                governor.quality,
                governor_bitrate(governor.quality),
                resolved.max_fps,
            ) {
                Ok(rebuilt) => {
                    encoder = rebuilt;
                    announce_resync = true;
                }
                Err(error) => {
                    stats.set_failure(error);
                    break;
                }
            }
        }

        let started = Instant::now();
        match encoder.encode(&frame) {
            Ok(ready) if ready.is_empty() => {
                // Either nothing changed, or the encoder is still working.
                stats.unchanged.fetch_add(1, Ordering::AcqRel);
            }
            Ok(ready) => {
                stats.observe_encode(started.elapsed().as_micros() as u64);
                for encoded in ready {
                if encoded.bytes.len() > MAX_FRAME_BYTES {
                    // Drop the frame and step down hard: the next frame has to
                    // be smaller, and skipping one is cheaper than losing the
                    // connection. For H.264 the keyframe that follows repairs
                    // the chain.
                    governor.force_downshift();
                    governor.apply(&mut encoder);
                    encoder.refresh();
                    announce_resync = true;
                    stats.dropped.fetch_add(1, Ordering::AcqRel);
                    continue;
                }
                seq += 1;
                let bytes = encoded.bytes.len();
                let data = base64::engine::general_purpose::STANDARD.encode(&encoded.bytes);
                // A resync frame carries the decoder configuration even when
                // it did not change: that is what makes it decodable by a
                // viewer that just joined an already-running pipeline.
                let description = if announce_resync || encoded.description.is_some() {
                    encoder
                        .description()
                        .or_else(|| encoded.description.clone())
                        .map(|record| base64::engine::general_purpose::STANDARD.encode(record))
                } else {
                    None
                };
                let envelope = json!({
                    "type": "screen.frame",
                    "seq": seq,
                    "capturedAt": frame.captured_at_ms as u64,
                    "encodedAt": now_ms() as u64,
                    "width": frame.width,
                    "height": frame.height,
                    "displayId": display.id,
                    "displayWidth": display.logical_width,
                    "displayHeight": display.logical_height,
                    "scale": display.scale,
                    "codec": codec.as_str(),
                    "keyframe": encoded.keyframe,
                    // Sent when the encoder restarted the reference chain, so
                    // the client resets rather than guessing.
                    "resync": announce_resync || encoded.description.is_some(),

                    "description": description,
                    "bytes": bytes,
                    "data": data,
                })
                .to_string();
                bus.publish(EncodedFrame {
                    seq,
                    captured_at_ms: frame.captured_at_ms,
                    encoded_at_ms: now_ms(),
                    width: frame.width,
                    height: frame.height,
                    bytes,
                    display: display.clone(),
                    envelope: Arc::from(envelope.as_str()),
                });
                announce_resync = false;
                stats.bytes_total.fetch_add(bytes as u64, Ordering::AcqRel);
                window_bytes = window_bytes.saturating_add(bytes as u64);
                window_frames += 1;
                last_frame_bytes = bytes as u64;
                }
            }
            Err(error) => {
                stats.set_failure(error);
                break;
            }
        }

        if last_window.elapsed() >= GOVERNOR_WINDOW {
            let seconds = last_window.elapsed().as_secs_f64().max(0.001);
            stats.bits_per_second.store(
                ((window_bytes as f64 * 8.0) / seconds) as u64,
                Ordering::Release,
            );
            stats.effective_fps.store(
                ((window_frames as f64 / seconds) * 1000.0) as u64,
                Ordering::Release,
            );
            governor.observe(window_bytes);
            governor.apply(&mut encoder);
            window_bytes = 0;
            window_frames = 0;
            last_window = Instant::now();
            // One push per window is the natural cadence: the numbers are
            // window aggregates, so pushing faster would only repeat them.
            if let Some(app) = &app {
                // The display list is a mount-time fact, not a per-second one,
                // and the thread does not carry it; the settings page keeps the
                // list it fetched at startup.
                let status = status_of(&bus, &stats, &resolved, &display, &[]);
                if let Err(error) = app.emit(STATUS_EVENT, status) {
                    log::debug!("推送屏幕状态失败：{error}");
                }
            }
        }
    }
    capture.stop();
    // The pipeline owns the last word on the status: it knows it just stopped.
    if let Some(app) = &app {
        if let Err(error) = app.emit(STATUS_EVENT, Value::Null) {
            log::debug!("推送屏幕停止事件失败：{error}");
        }
    }
}

/// Handle one screen-channel request from a connected client.
///
/// Returns `None` when `request` is not a screen message, so the caller can
/// fall through to its own handling. `Err` becomes a normal `remote.error`
/// response; the phone turns those into a visible message.
pub fn handle_request(
    host: &ScreenHost,
    subscription: &ScreenSubscription,
    request: &Value,
) -> Option<Result<Value, String>> {
    let kind = request.get("type").and_then(Value::as_str)?;
    if !kind.starts_with("screen.") {
        return None;
    }
    Some(match kind {
        "screen.start" => {
            let settings = request
                .get("settings")
                .cloned()
                .map(serde_json::from_value::<ScreenSettings>)
                .transpose()
                .map_err(|_| "screen.start 参数无效".to_string())
                .map(|settings| settings.unwrap_or_default());
            settings.and_then(|settings| {
                settings.resolve_checked()?;
                let (display, codec) = host.ensure(settings)?;
                subscription.activate();
                Ok(json!({
                    "display": display,
                    "displays": capture::displays().unwrap_or_default(),
                    "codec": codec.as_str(),
                    "width": display.logical_width,
                    "height": display.logical_height,
                }))
            })
        }
        "screen.stop" => {
            subscription.deactivate();
            Ok(Value::Null)
        }
        "screen.displays" => capture::displays().map(|displays| json!(displays)),
        "screen.stats" => Ok(serde_json::to_value(host.status()).unwrap_or(Value::Null)),
        "screen.input" => {
            let Some(event) = request.get("event").cloned() else {
                return Some(Err("screen.input 缺少 event".into()));
            };
            // Prefer the geometry of the frame the user is looking at; the
            // host's own value is only a fallback before the first frame.
            let Some(display) = subscription.target().or_else(|| host.display()) else {
                return Some(Err("屏幕预览尚未开始".into()));
            };
            serde_json::from_value::<input::ScreenInput>(event)
                .map_err(|_| "screen.input 事件无效".to_string())
                .and_then(|event| input::apply(&event, &display).map(|()| Value::Null))
        }
        other => Err(format!("不支持的屏幕消息：{other}")),
    })
}

// ── Tauri commands (desktop UI) ──────────────────────────────────────

/// Event name the desktop UI listens on.
///
/// The pipeline is the only thing that knows when capture starts, when it
/// settles, and when it fails, so it pushes. The settings page used to poll
/// `screen_status` every two seconds, which is a poll of a fact this process
/// already has — and Tauri's event system exists precisely so it does not have
/// to be asked.
pub const STATUS_EVENT: &str = "screen:status";

/// Push the current status to the desktop UI.
fn publish_status(app: &AppHandle, host: &ScreenHost) {
    let status = host.status();
    if let Err(error) = app.emit(STATUS_EVENT, status) {
        log::debug!("推送屏幕状态失败：{error}");
    }
}

#[tauri::command]
pub fn screen_status(state: tauri::State<'_, ScreenHost>) -> ScreenStatus {
    state.status()
}

#[tauri::command]
pub fn screen_displays() -> Result<Vec<DisplayInfo>, String> {
    capture::displays()
}

/// Ask macOS for screen-recording access. The answer only becomes `true` after
/// the user grants it in System Settings, so the UI re-reads `screen_status`.
#[tauri::command]
pub fn screen_request_permission() -> bool {
    capture::request_permission() || capture::permission_granted()
}

#[tauri::command]
pub fn screen_stop(state: tauri::State<'_, ScreenHost>) -> ScreenStatus {
    state.stop();
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display() -> DisplayInfo {
        DisplayInfo {
            id: 1,
            name: "主显示器".into(),
            kind: crate::screen::capture::TargetKind::Display,
            owner_pid: None,
            logical_x: 0.0,
            logical_y: 0.0,
            logical_width: 1728.0,
            logical_height: 1117.0,
            pixel_width: 3456,
            pixel_height: 2234,
            scale: 2.0,
            primary: true,
        }
    }

    #[test]
    fn capture_box_preserves_aspect_ratio_and_uses_even_pixels() {
        let (width, height) = capture_box(&display(), 1280);
        assert_eq!(width, 1280);
        assert_eq!(height % 2, 0);
        // 1280 * (1117 / 1728) = 827.4
        assert_eq!(height, 826);
    }

    #[test]
    fn capture_box_never_upscales_past_the_display() {
        let (width, height) = capture_box(&display(), 4000);
        assert_eq!((width, height), (1728, 1116));
    }

    #[test]
    fn subscriptions_drop_stale_frames_instead_of_queueing() {
        let bus = Arc::new(ScreenBus::default());
        let subscription = ScreenSubscription::new(bus.clone());
        subscription.activate();
        assert!(subscription.poll().is_none());

        for seq in 1..=3 {
            bus.publish(frame(seq));
        }
        // Three frames were published while the subscriber was busy; exactly
        // one delivery happens, and it carries the newest frame.
        let delivered = subscription.poll().expect("one frame");
        assert_eq!(delivered.seq, 3);
        assert!(subscription.poll().is_none());
    }

    #[test]
    fn a_frame_published_mid_poll_is_never_delivered_twice() {
        let bus = Arc::new(ScreenBus::default());
        let subscription = ScreenSubscription::new(bus.clone());
        subscription.activate();

        // Simulate the interleaving: `poll` reads the version, a publish lands,
        // and only then does `poll` take the frame. The frame it returns is
        // newer than the version it saw, so the cursor must follow the frame.
        bus.publish(frame(1));
        let version = bus.version.load(Ordering::Acquire);
        bus.publish(frame(2));
        assert_eq!(version, 1);
        assert_eq!(subscription.poll().expect("frame").seq, 2);
        assert!(subscription.poll().is_none(), "no duplicate delivery");
    }

    #[test]
    fn skipping_frames_requests_a_keyframe() {
        let bus = Arc::new(ScreenBus::default());
        let subscription = ScreenSubscription::new(bus.clone());
        subscription.activate();
        bus.publish(frame(1));
        assert_eq!(subscription.poll().expect("frame").seq, 1);
        assert!(!bus.take_resync(), "a contiguous delivery is not a resync");

        // Two frames published, one delivered: the decoder lost its chain.
        bus.publish(frame(2));
        bus.publish(frame(3));
        assert_eq!(subscription.poll().expect("frame").seq, 3);
        assert!(bus.take_resync(), "the gap must ask for a keyframe");
    }

    #[test]
    fn encoding_is_gated_on_every_subscriber_consuming_the_last_frame() {
        let bus = Arc::new(ScreenBus::default());
        assert!(!bus.needs_frame(), "no viewers, no encoding");

        let slow = ScreenSubscription::new(bus.clone());
        slow.activate();
        assert!(bus.needs_frame(), "the first frame is always needed");

        bus.publish(frame(1));
        assert!(
            !bus.needs_frame(),
            "the frame is still in flight, so an inter-frame codec must not run ahead"
        );
        slow.poll().expect("frame");
        assert!(bus.needs_frame(), "now the next frame is wanted");

        // A second viewer at a different pace holds the pipeline back on its
        // own: the minimum, not the count, is what gates encoding.
        let fast = ScreenSubscription::new(bus.clone());
        fast.activate();
        bus.publish(frame(2));
        fast.poll().expect("frame");
        assert!(!bus.needs_frame(), "the slow viewer has not consumed frame 2");
        slow.poll().expect("frame");
        assert!(bus.needs_frame());

        slow.deactivate();
        fast.deactivate();
        assert!(!bus.needs_frame());
    }

    #[test]
    fn inactive_subscriptions_are_not_counted() {
        let bus = Arc::new(ScreenBus::default());
        {
            let subscription = ScreenSubscription::new(bus.clone());
            assert_eq!(bus.subscribers(), 0);
            subscription.activate();
            assert_eq!(bus.subscribers(), 1);
            // Activating twice must not double count.
            subscription.activate();
            assert_eq!(bus.subscribers(), 1);
        }
        assert_eq!(bus.subscribers(), 0);
    }

    #[test]
    fn governor_downshifts_when_over_budget_and_recovers_when_idle() {
        let mut governor = Governor::new(80, 10, Codec::Jpeg);
        let over = governor.budget * 2;
        assert_eq!(governor.quality, 80);
        governor.observe(over);
        // Two times the budget steps twice as far as the base step: the further
        // over, the faster it comes down.
        assert_eq!(governor.quality, 68);
        // Exactly at the budget is not over it: the comparison is strict, so
        // hitting the target does not cost quality.
        governor.observe(governor.budget);
        assert_eq!(governor.quality, 68, "meeting the budget changes nothing");

        // Quality walks down to the floor and stops there, then frame rate
        // absorbs the rest of the pressure.
        while governor.quality > QUALITY_FLOOR {
            governor.observe(over);
        }
        assert_eq!(governor.quality, QUALITY_FLOOR);
        assert_eq!(governor.fps, 10.0, "frame rate holds until quality floors");
        for _ in 0..3 {
            governor.observe(over);
        }
        assert_eq!(governor.fps, 7.0);

        // Sustained headroom buys quality back before frame rate, and stops at
        // the quality the client asked for.
        let mut governor = Governor::new(70, 10, Codec::Jpeg);
        governor.fps = 4.0;
        while governor.quality > QUALITY_FLOOR {
            governor.observe(over);
        }
        assert_eq!(governor.quality, QUALITY_FLOOR);
        for _ in 0..40 {
            governor.observe(1);
        }
        assert_eq!(
            governor.quality, 70,
            "recovery stops at the requested quality, never above it"
        );
        assert!(governor.fps > 4.0, "frame rate follows once quality is restored");
        assert!(governor.fps <= 10.0);
    }

    #[test]
    fn h264_budget_follows_the_bitrate_rather_than_the_frame_size() {
        // H.264's cost is decoupled from how much of the screen is text: the
        // budget is derived from the target bitrate, not from a byte cap.
        let low = Governor::new(40, 10, Codec::H264);
        let high = Governor::new(80, 10, Codec::H264);
        assert!(high.budget > low.budget);
        assert_eq!(low.budget, u64::from(governor_bitrate(40)) / 8 * 5 / 4);
        // A JPEG governor at the same quality has a fixed budget.
        assert_eq!(
            Governor::new(40, 10, Codec::Jpeg).budget,
            JPEG_BUDGET_BYTES_PER_SECOND
        );
    }

    #[test]
    fn the_frame_rate_ceiling_allows_a_high_refresh_panel() {
        // 60 used to be the clamp, which silently halved what a 120 Hz phone
        // could ask for.
        let resolved = ScreenSettings {
            max_fps: Some(120),
            ..ScreenSettings::default()
        }
        .resolve();
        assert_eq!(resolved.max_fps, 120);
        let too_much = ScreenSettings {
            max_fps: Some(240),
            ..ScreenSettings::default()
        };
        assert!(too_much.resolve_checked().is_err());
    }

    #[test]
    fn a_maxed_out_start_converges_quickly_instead_of_crawling() {
        // Requesting maximum quality on a link that cannot carry it must reach a
        // workable shape in a couple of windows, not a couple of dozen.
        let mut governor = Governor::new(90, 30, Codec::Jpeg);
        let mut windows = 0;
        while governor.quality > QUALITY_FLOOR && windows < 10 {
            governor.observe(governor.budget * 8);
            windows += 1;
        }
        assert!(windows <= 3, "收敛用了 {windows} 个窗口，太慢");
    }

    #[test]
    fn oversized_frames_force_a_downshift_rather_than_a_relay_disconnect() {
        let mut governor = Governor::new(90, 15, Codec::Jpeg);
        assert_eq!(governor.quality, 90);
        governor.force_downshift();
        assert_eq!(governor.quality, 80);
        while governor.quality > QUALITY_FLOOR {
            governor.force_downshift();
        }
        assert_eq!(governor.quality, QUALITY_FLOOR);
        assert_eq!(governor.fps, 15.0, "frame rate holds until quality floors");
        governor.force_downshift();
        assert!(governor.fps < 15.0);
    }

    #[test]
    fn the_frame_ceiling_leaves_room_for_double_base64_and_aes() {
        // Two base64 expansions plus the AES-GCM nonce and tag must still fit
        // in the relay's 1 MiB WebSocket frame limit.
        let wire = MAX_FRAME_BYTES.div_ceil(3) * 4;
        let wire = wire.div_ceil(3) * 4 + 17;
        assert!(wire < 1_048_576, "worst-case relayed frame was {wire} bytes");
    }

    #[test]
    fn settings_are_clamped_to_a_sane_preview_shape() {
        // Asking for nothing gets the maximum: the governor walks down from the
        // ceiling, it does not start in the middle.
        let resolved = ScreenSettings::default().resolve();
        assert_eq!(resolved.max_width, 2560);
        assert_eq!(resolved.max_fps, 60);
        assert_eq!(resolved.quality, 90);
        // H.264 is the default because it is strictly cheaper on the wire.
        assert_eq!(resolved.codec, Codec::H264);
        let extreme = ScreenSettings {
            max_width: Some(9000),
            max_fps: Some(240),
            quality: Some(1),
            display_id: None,
            show_cursor: None,
            codec: None,
            source: None,
        }
        .resolve();
        assert_eq!(extreme.max_width, 2560);
        assert_eq!(extreme.max_fps, 120);
        assert_eq!(extreme.quality, 30);
    }

    #[test]
    fn the_preview_follows_the_operated_app_by_default() {
        // With computer use the app being driven is the frontmost one, so this
        // is the default the product wants; a whole display is one setting away.
        assert_eq!(ScreenSettings::default().resolve().source, Source::App);
        let display = ScreenSettings {
            source: Some("display".into()),
            ..ScreenSettings::default()
        }
        .resolve();
        assert_eq!(display.source, Source::Display);
    }

    #[test]
    fn an_unknown_source_is_rejected_rather_than_guessed() {
        let bad = ScreenSettings {
            source: Some("window".into()),
            ..ScreenSettings::default()
        };
        assert!(bad.resolve_checked().is_err());
    }

    #[test]
    fn input_maps_onto_the_geometry_of_the_frame_on_screen() {
        // In app mode the target changes while the stream runs. Input must
        // follow the frame the viewer is looking at, or a touch lands on the
        // previous window's coordinates.
        let bus = Arc::new(ScreenBus::default());
        let subscription = ScreenSubscription::new(bus.clone());
        subscription.activate();
        assert!(subscription.target().is_none(), "no frame yet");

        let mut with_window = frame(1);
        let mut window = display();
        window.kind = crate::screen::capture::TargetKind::Window;
        window.owner_pid = Some(4242);
        window.logical_x = -400.0;
        window.logical_y = 120.0;
        window.logical_width = 900.0;
        window.logical_height = 600.0;
        with_window.display = window;
        bus.publish(with_window);

        let target = subscription.target().expect("geometry from the frame");
        assert_eq!(target.kind, crate::screen::capture::TargetKind::Window);
        assert_eq!(target.logical_x, -400.0);
    }

    #[test]
    fn a_client_can_ask_for_the_jpeg_fallback() {
        let resolved = ScreenSettings {
            codec: Some("jpeg".into()),
            ..ScreenSettings::default()
        }
        .resolve();
        assert_eq!(resolved.codec, Codec::Jpeg);
    }

    #[test]
    fn invalid_client_settings_are_rejected_with_a_reason() {
        let bad = ScreenSettings {
            max_fps: Some(0),
            ..ScreenSettings::default()
        };
        assert!(bad.resolve_checked().is_err());
        let bad_codec = ScreenSettings {
            codec: Some("vp9".into()),
            ..ScreenSettings::default()
        };
        assert!(bad_codec.resolve_checked().is_err());
        assert!(ScreenSettings::default().resolve_checked().is_ok());
    }

    /// Manual verification of the whole capture path: ScreenCaptureKit, the
    /// one-frame coalescing receiver, and encoding.
    ///
    /// Ignored by default because it needs a real display *and* the macOS
    /// screen-recording grant, neither of which exists in CI. Run it after
    /// touching the capture or encode backend:
    ///
    /// ```text
    /// cargo test --lib screen::tests::captures_and_encodes -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "requires screen-recording permission and a real display"]
    fn captures_and_encodes_a_real_frame() {
        if !capture::permission_granted() {
            eprintln!("未授权：{}", capture::permission_hint());
            return;
        }
        let displays = capture::displays().expect("显示器列表");
        let display = displays
            .iter()
            .find(|display| display.primary)
            .unwrap_or(&displays[0]);
        let (width, height) = capture_box(display, 1280);
        let mut session = capture::open(CaptureRequest {
            display_id: Some(display.id),
            window_id: None,
            width,
            height,
            fps: 10,
            shows_cursor: true,
        })
        .expect("启动捕获");
        for codec in [Codec::H264, Codec::Jpeg] {
            let mut encoder = match Encoder::new(codec, width, height, 62, governor_bitrate(62), 10) {
                Ok(encoder) => encoder,
                Err(error) if codec == Codec::H264 => {
                    eprintln!("跳过 H.264：{error}");
                    continue;
                }
                Err(error) => panic!("{error}"),
            };
            let frame = session
                .next_frame(Duration::from_secs(5))
                .expect("5 秒内应当收到一帧");
            assert_eq!((frame.width, frame.height), (width, height));
            let mut ready = encoder.encode(&frame).expect("编码");
            assert_eq!(ready.len(), 1, "第一帧一定会被编码");
            let encoded = ready.remove(0);
            assert!(!encoded.bytes.is_empty());
            // H.264's first frame must be decodable on its own, and must carry
            // the decoder configuration the phone needs.
            if codec == Codec::H264 {
                assert!(encoded.keyframe, "第一帧必须是关键帧");
                assert!(encoded.description.is_some(), "首帧必须带解码器配置");
                assert!(
                    encoder.description().is_some(),
                    "当前解码器配置必须可随时取用，供 resync 帧携带"
                );
                // The second frame must not repeat it: the record only travels
                // when it changes.
                let again = session
                    .next_frame(Duration::from_secs(5))
                    .expect("第二帧");
                if let Some(second) = encoder.encode(&again).expect("编码").into_iter().next() {
                    assert!(
                        second.description.is_none(),
                        "配置未变化时不应重复下发"
                    );
                }
                // After a refresh (a viewer joined, or the chain broke) the
                // configuration must travel again, or a fresh decoder cannot
                // configure itself.
                encoder.refresh();
                let third = session
                    .next_frame(Duration::from_secs(5))
                    .expect("第三帧");
                if let Some(third) = encoder.encode(&third).expect("编码").into_iter().next() {
                    assert!(third.keyframe, "refresh 之后必须是关键帧");
                    assert!(
                        third.description.is_some(),
                        "resync 帧必须自带解码器配置"
                    );
                }
            }
            eprintln!(
                "{}: {}x{} -> {} 字节（关键帧 {}）",
                codec.as_str(),
                frame.width,
                frame.height,
                encoded.bytes.len(),
                encoded.keyframe
            );
        }
        session.stop();
    }

    fn frame(seq: u64) -> EncodedFrame {
        EncodedFrame {
            seq,
            captured_at_ms: 0,
            encoded_at_ms: 0,
            width: 2,
            height: 2,
            bytes: 4,
            display: display(),
            envelope: Arc::from("{}"),
        }
    }
}
