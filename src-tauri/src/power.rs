//! Keeps the machine awake for as long as Orbit is running.
//!
//! The mobile Host lives in this process: the phone reaches it through a
//! WebSocket this app owns, and a sleeping computer simply stops answering. The
//! display going dark is the visible half of that timeout and the system idle
//! timer is the half that drops the socket, so both assertions are held — the
//! same pair `caffeinate -d -i` creates.
//!
//! The assertion belongs to the app, not to a window, and it is the process
//! that releases it on exit (IOKit does that for us), which is exactly the
//! lifetime the feature is about.
//!
//! macOS is the release platform here; other desktops fall through to the
//! operating system's own power settings instead of shipping a
//! platform-specific implementation nobody can validate on this release.

use std::sync::Mutex;
use tauri::State;

/// Whether the app currently holds a "do not sleep" assertion.
#[derive(Default)]
pub struct KeepAwake {
    held: Mutex<Option<mac::Assertion>>,
}

impl KeepAwake {
    pub fn new() -> Self {
        Self::default()
    }

    /// Request or drop the assertion; reports whether it is held afterwards, so
    /// a caller can tell "off" from "this platform refused".
    pub fn set(&self, enabled: bool) -> bool {
        let mut held = self.held.lock().unwrap();
        if enabled {
            // A second request while one is held must not leak a second
            // assertion: the kernel keeps them until each is released.
            if held.is_none() {
                *held = mac::acquire();
            }
        } else {
            // Dropping the guard releases every assertion it holds.
            *held = None;
        }
        held.is_some()
    }
}

#[tauri::command]
pub fn set_keep_awake(state: State<'_, KeepAwake>, enabled: bool) -> bool {
    state.set(enabled)
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void, CString};

    type CFTypeRef = *const c_void;

    /// `kIOReturnSuccess`.
    const SUCCESS: i32 = 0;
    /// `kIOPMAssertionLevelOn`.
    const LEVEL_ON: u32 = 255;
    /// `kCFStringEncodingUTF8`.
    const UTF8: u32 = 0x0800_0100;

    // The framework surface is declared by hand, like the MediaRemote probe in
    // `now_playing.rs`: the two functions needed here are older than any crate
    // that wraps them, and pulling a dependency for them would be the larger
    // change.
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, enc: u32) -> CFTypeRef;
        fn CFRelease(value: CFTypeRef);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFTypeRef,
            level: u32,
            name: CFTypeRef,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    /// The IOKit assertion types, spelled exactly as the framework's constants
    /// expand. A typo here is not a compile error: the call returns an error
    /// code and the machine sleeps exactly as if the feature did not exist.
    pub const ASSERTIONS: [&str; 2] = [
        "PreventUserIdleDisplaySleep",
        "PreventUserIdleSystemSleep",
    ];

    /// Why the assertion is held, shown by `pmset -g assertions` and any other
    /// tool that lists who is keeping the machine up.
    const REASON: &str = "Orbit 正在运行";

    pub struct Assertion(Vec<u32>);

    impl Drop for Assertion {
        fn drop(&mut self) {
            unsafe {
                for id in self.0.drain(..) {
                    IOPMAssertionRelease(id);
                }
            }
        }
    }

    unsafe fn cfstring(value: &str) -> Option<CFTypeRef> {
        let text = CString::new(value).ok()?;
        let string = CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8);
        (!string.is_null()).then_some(string)
    }

    /// Create the assertions; `None` when the kernel refused every one of them.
    pub fn acquire() -> Option<Assertion> {
        unsafe {
            let mut ids = Vec::new();
            for assertion in ASSERTIONS {
                let (Some(kind), Some(reason)) = (cfstring(assertion), cfstring(REASON)) else {
                    continue;
                };
                let mut id = 0u32;
                let status = IOPMAssertionCreateWithName(kind, LEVEL_ON, reason, &mut id);
                CFRelease(kind);
                CFRelease(reason);
                if status == SUCCESS {
                    ids.push(id);
                }
            }
            (!ids.is_empty()).then(|| Assertion(ids))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    /// No implementation on this platform: the operating system's power
    /// settings stay in charge, and the caller learns that from `set` returning
    /// `false`.
    pub struct Assertion;

    pub fn acquire() -> Option<Assertion> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_without_an_assertion() {
        let keep_awake = KeepAwake::new();
        assert!(!keep_awake.set(false));
    }

    /// The assertion type strings are data, not identifiers: a typo compiles and
    /// silently disables the feature, so the names are pinned here.
    #[cfg(target_os = "macos")]
    #[test]
    fn names_the_io_kit_assertion_types() {
        assert_eq!(
            mac::ASSERTIONS,
            ["PreventUserIdleDisplaySleep", "PreventUserIdleSystemSleep"]
        );
    }

    /// Releasing twice must not be a leak, and asking twice must not double up.
    #[test]
    fn repeated_requests_stay_idempotent() {
        let keep_awake = KeepAwake::new();
        let first = keep_awake.set(true);
        assert_eq!(first, keep_awake.set(true));
        assert!(!keep_awake.set(false));
    }
}
