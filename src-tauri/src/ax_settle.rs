//! Event-driven post-action settle.
//!
//! Instead of re-walking the whole AX tree every 60ms after an action, the
//! worker arms an `AXObserver` on the target application *before* the action
//! is dispatched, then blocks on the run loop until the application posts an
//! accessibility notification and goes quiet again (or a deadline passes).
//! The caller then observes exactly once.
//!
//! Registration is best effort per notification. When the application accepts
//! none of them, `supported=false` is reported and the caller falls back to
//! its polling loop, so behaviour never regresses on exotic apps.

#![cfg(target_os = "macos")]

use serde_json::{json, Value};
use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type AXUIElementRef = *const c_void;
type AXObserverRef = *const c_void;
type CFRunLoopRef = *const c_void;
type CFRunLoopSourceRef = *const c_void;
type AXError = i32;

const AX_SUCCESS: AXError = 0;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

type ObserverCallback = unsafe extern "C" fn(AXObserverRef, AXUIElementRef, CFStringRef, *mut c_void);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXObserverCreate(pid: i32, callback: ObserverCallback, observer: *mut AXObserverRef) -> AXError;
    fn AXObserverAddNotification(observer: AXObserverRef, element: AXUIElementRef, notification: CFStringRef, refcon: *mut c_void) -> AXError;
    fn AXObserverRemoveNotification(observer: AXObserverRef, element: AXUIElementRef, notification: CFStringRef) -> AXError;
    fn AXObserverGetRunLoopSource(observer: AXObserverRef) -> CFRunLoopSourceRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopDefaultMode: CFStringRef;
    fn CFRunLoopGetCurrent() -> CFRunLoopRef;
    fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRemoveSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
    fn CFRunLoopRunInMode(mode: CFStringRef, seconds: f64, return_after_source_handled: bool) -> i32;
    fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: isize, encoding: u32, external: bool) -> CFStringRef;
    fn CFStringGetCString(s: CFStringRef, buf: *mut std::ffi::c_char, size: isize, encoding: u32) -> bool;
    fn CFRelease(v: CFTypeRef);
}

/// Notifications that mean "the interface changed in a way the agent cares
/// about". All are standard AppKit/AX names; none is application-specific.
const NOTIFICATIONS: [&str; 15] = [
    "AXFocusedUIElementChanged",
    "AXValueChanged",
    "AXUIElementDestroyed",
    "AXCreated",
    "AXMenuOpened",
    "AXMenuClosed",
    "AXWindowCreated",
    "AXFocusedWindowChanged",
    "AXMainWindowChanged",
    "AXSelectedChildrenChanged",
    "AXSelectedTextChanged",
    "AXSelectedRowsChanged",
    "AXTitleChanged",
    "AXLayoutChanged",
    "AXRowCountChanged",
];

#[derive(Clone, Copy, Debug)]
pub struct SettleOptions {
    /// Give up waiting for the first notification after this long.
    pub timeout: Duration,
    /// After a notification, return once the app has been quiet this long.
    pub quiet: Duration,
    /// Hard cap after the first notification (animations can post forever).
    pub max_after_first: Duration,
}

impl SettleOptions {
    pub fn from_request(value: &Value) -> Option<Self> {
        if !value.is_object() {
            return None;
        }
        let ms = |key: &str, default: u64, max: u64| Duration::from_millis(value[key].as_u64().unwrap_or(default).clamp(1, max));
        Some(Self {
            timeout: ms("timeoutMs", 900, 5_000),
            quiet: ms("quietMs", 90, 1_000),
            max_after_first: ms("maxAfterFirstMs", 700, 5_000),
        })
    }
}

struct State {
    started: Instant,
    events: AtomicUsize,
    first_ns: AtomicU64,
    last_ns: AtomicU64,
    names: Mutex<Vec<String>>,
}

unsafe extern "C" fn on_notification(_observer: AXObserverRef, _element: AXUIElementRef, notification: CFStringRef, refcon: *mut c_void) {
    if refcon.is_null() {
        return;
    }
    let state = &*(refcon as *const State);
    let now = state.started.elapsed().as_nanos() as u64;
    if state.events.fetch_add(1, Ordering::SeqCst) == 0 {
        state.first_ns.store(now, Ordering::SeqCst);
    }
    state.last_ns.store(now, Ordering::SeqCst);
    let mut buf = [0 as std::ffi::c_char; 64];
    if !notification.is_null() && CFStringGetCString(notification, buf.as_mut_ptr(), buf.len() as isize, K_CF_STRING_ENCODING_UTF8) {
        let name = std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().trim_start_matches("AX").to_string();
        if let Ok(mut names) = state.names.lock() {
            if names.len() < 8 && !names.contains(&name) {
                names.push(name);
            }
        }
    }
}

fn cfstr(value: &str) -> CFStringRef {
    unsafe { CFStringCreateWithBytes(std::ptr::null(), value.as_ptr(), value.len() as isize, K_CF_STRING_ENCODING_UTF8, false) }
}

/// An armed observer. Create it before dispatching the action, then call
/// [`Armed::wait`]. Dropping it unregisters everything.
pub struct Armed {
    app: AXUIElementRef,
    observer: AXObserverRef,
    source: CFRunLoopSourceRef,
    run_loop: CFRunLoopRef,
    registered: Vec<CFStringRef>,
    state: Box<State>,
}

impl Armed {
    pub fn arm(pid: i32) -> Option<Self> {
        unsafe {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                return None;
            }
            let mut observer: AXObserverRef = std::ptr::null();
            if AXObserverCreate(pid, on_notification, &mut observer) != AX_SUCCESS || observer.is_null() {
                CFRelease(app);
                return None;
            }
            let state = Box::new(State {
                started: Instant::now(),
                events: AtomicUsize::new(0),
                first_ns: AtomicU64::new(0),
                last_ns: AtomicU64::new(0),
                names: Mutex::new(Vec::new()),
            });
            let refcon = &*state as *const State as *mut c_void;
            let mut registered = Vec::new();
            for name in NOTIFICATIONS {
                let key = cfstr(name);
                if AXObserverAddNotification(observer, app, key, refcon) == AX_SUCCESS {
                    registered.push(key);
                } else {
                    CFRelease(key);
                }
            }
            let source = AXObserverGetRunLoopSource(observer);
            let run_loop = CFRunLoopGetCurrent();
            if !source.is_null() {
                CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
            }
            Some(Self { app, observer, source, run_loop, registered, state })
        }
    }

    pub fn supported(&self) -> bool {
        !self.registered.is_empty() && !self.source.is_null()
    }

    /// Block on the run loop until the app settles. Returns a JSON report.
    pub fn wait(self, options: SettleOptions) -> Value {
        let started = Instant::now();
        if !self.supported() {
            return json!({ "supported": false, "changed": false, "events": 0, "ms": 0 });
        }
        loop {
            let elapsed = started.elapsed();
            let events = self.state.events.load(Ordering::SeqCst);
            if events == 0 {
                if elapsed >= options.timeout {
                    break;
                }
            } else {
                let now = self.state.started.elapsed().as_nanos() as u64;
                let last = self.state.last_ns.load(Ordering::SeqCst);
                let first = self.state.first_ns.load(Ordering::SeqCst);
                if Duration::from_nanos(now.saturating_sub(last)) >= options.quiet
                    || Duration::from_nanos(now.saturating_sub(first)) >= options.max_after_first
                {
                    break;
                }
            }
            // Short slices keep the quiet-window check responsive.
            unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, true) };
        }
        let events = self.state.events.load(Ordering::SeqCst);
        let names = self.state.names.lock().map(|names| names.clone()).unwrap_or_default();
        json!({
            "supported": true,
            "changed": events > 0,
            "events": events,
            "notifications": names,
            "ms": started.elapsed().as_millis() as u64,
        })
    }
}

impl Drop for Armed {
    fn drop(&mut self) {
        unsafe {
            for key in &self.registered {
                AXObserverRemoveNotification(self.observer, self.app, *key);
                CFRelease(*key);
            }
            if !self.source.is_null() {
                CFRunLoopRemoveSource(self.run_loop, self.source, kCFRunLoopDefaultMode);
            }
            CFRelease(self.observer);
            CFRelease(self.app);
        }
    }
}
