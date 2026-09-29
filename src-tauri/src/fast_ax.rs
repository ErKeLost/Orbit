//! Fast macOS accessibility observer.
//!
//! Observation is the hot path of every desktop step, so it is written directly
//! against the AX C API instead of a general-purpose binding:
//!
//! * exactly one `AXUIElementCopyMultipleAttributeValues` + one
//!   `AXUIElementCopyActionNames` per node (no follow-up probes for window
//!   state, container selection, settability, min/max, or focused window);
//! * a short per-call messaging timeout, so one slow node (Electron/WeChat
//!   cells regularly stall for >1s) cannot hold the whole walk hostage;
//! * sibling subtrees read in parallel, since AX IPC latency — not CPU — is the
//!   bottleneck;
//! * a global node budget and a wall-clock deadline, returning a partial but
//!   honest (`complete=false`) tree instead of blocking.
//!
//! The emitted JSON matches the schema produced by `ax::node` so the ledger,
//! the Node observation layer and action dispatch stay unchanged.

#![cfg(target_os = "macos")]

use serde_json::{json, Value};
use std::ffi::{c_char, c_void};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

type CFTypeRef = *const c_void;
type CFArrayRef = *const c_void;
type CFStringRef = *const c_void;
type AXUIElementRef = *const c_void;
type CFIndex = isize;
type AXError = i32;

const AX_SUCCESS: AXError = 0;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_AX_VALUE_CGPOINT: u32 = 1;
const K_AX_VALUE_CGSIZE: u32 = 2;
/// Per-message ceiling. Healthy apps answer in single-digit milliseconds;
/// anything slower than this is a stalled renderer, and waiting longer only
/// adds latency without adding information.
const PER_CALL_TIMEOUT_SECS: f32 = 0.35;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
    fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> AXError;
    fn AXUIElementSetAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) -> AXError;
    fn AXUIElementCopyMultipleAttributeValues(element: AXUIElementRef, attributes: CFArrayRef, options: u32, values: *mut CFArrayRef) -> AXError;
    fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFArrayRef) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    fn AXValueGetType(value: CFTypeRef) -> u32;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
    fn AXUIElementGetTypeID() -> usize;
    fn AXValueGetTypeID() -> usize;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeArrayCallBacks: c_void;
    fn CFArrayCreate(alloc: CFTypeRef, values: *const CFTypeRef, count: CFIndex, callbacks: *const c_void) -> CFArrayRef;
    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, index: CFIndex) -> CFTypeRef;
    fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: CFIndex, encoding: u32, external: bool) -> CFStringRef;
    fn CFStringGetLength(s: CFStringRef) -> CFIndex;
    fn CFStringGetCString(s: CFStringRef, buf: *mut c_char, size: CFIndex, encoding: u32) -> bool;
    fn CFStringGetMaximumSizeForEncoding(len: CFIndex, encoding: u32) -> CFIndex;
    fn CFGetTypeID(v: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(v: CFTypeRef) -> bool;
    static kCFBooleanTrue: CFTypeRef;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(v: CFTypeRef, kind: isize, out: *mut c_void) -> bool;
    fn CFArrayGetTypeID() -> usize;
    fn CFRetain(v: CFTypeRef) -> CFTypeRef;
    fn CFRelease(v: CFTypeRef);
}

/// Owned, retained CF object that is released on drop. AX elements are safe
/// to message from any thread.
struct Owned(CFTypeRef);
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

fn cfstr(value: &str) -> Owned {
    Owned(unsafe { CFStringCreateWithBytes(std::ptr::null(), value.as_ptr(), value.len() as CFIndex, K_CF_STRING_ENCODING_UTF8, false) })
}

unsafe fn to_string(value: CFTypeRef) -> Option<String> {
    if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
        return None;
    }
    let len = CFStringGetLength(value);
    let size = CFStringGetMaximumSizeForEncoding(len, K_CF_STRING_ENCODING_UTF8) + 1;
    let mut buf = vec![0u8; size as usize];
    if !CFStringGetCString(value, buf.as_mut_ptr().cast::<c_char>(), size, K_CF_STRING_ENCODING_UTF8) {
        return None;
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    buf.truncate(end);
    // Strip bidi presentation controls, matching the previous xa11y output.
    let text: String = String::from_utf8_lossy(&buf)
        .chars()
        .filter(|c| !matches!(*c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
        .collect();
    Some(text)
}

unsafe fn to_bool(value: CFTypeRef) -> Option<bool> {
    if value.is_null() || CFGetTypeID(value) != CFBooleanGetTypeID() {
        return None;
    }
    Some(CFBooleanGetValue(value))
}

unsafe fn to_number(value: CFTypeRef) -> Option<f64> {
    if value.is_null() || CFGetTypeID(value) != CFNumberGetTypeID() {
        return None;
    }
    let mut out = 0f64;
    // kCFNumberFloat64Type
    CFNumberGetValue(value, 6, &mut out as *mut f64 as *mut c_void).then_some(out)
}

unsafe fn to_pair(value: CFTypeRef, kind: u32) -> Option<(f64, f64)> {
    if value.is_null() || CFGetTypeID(value) != AXValueGetTypeID() || AXValueGetType(value) != kind {
        return None;
    }
    let mut out = [0f64; 2];
    AXValueGetValue(value, kind, out.as_mut_ptr() as *mut c_void).then_some((out[0], out[1]))
}

const ATTRS: [&str; 15] = [
    "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXHelp", "AXValue", "AXEnabled", "AXFocused",
    "AXSelected", "AXHidden", "AXExpanded", "AXPosition", "AXSize", "AXIdentifier", "AXChildren",
];
const ROLE: usize = 0;
const SUBROLE: usize = 1;
const TITLE: usize = 2;
const DESCRIPTION: usize = 3;
const HELP: usize = 4;
const VALUE: usize = 5;
const ENABLED: usize = 6;
const FOCUSED: usize = 7;
const SELECTED: usize = 8;
const HIDDEN: usize = 9;
const EXPANDED: usize = 10;
const POSITION: usize = 11;
const SIZE: usize = 12;
const IDENTIFIER: usize = 13;
const CHILDREN: usize = 14;

struct Walk {
    attrs: Owned,
    snapshot_id: String,
    pid: i64,
    remaining: AtomicUsize,
    deadline: Instant,
    incomplete: AtomicBool,
    max_depth: usize,
}
unsafe impl Sync for Walk {}

/// Read one node and its subtree. Returns `None` when the node has vanished.
type Rect = (f64, f64, f64, f64);

fn intersects(a: Rect, b: Rect) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

fn read(walk: &Walk, element: &Owned, path: Vec<usize>, depth: usize, window: Option<(&str, Option<&str>)>, clip: Option<Rect>) -> Option<Value> {
    if Instant::now() >= walk.deadline {
        walk.incomplete.store(true, Ordering::Relaxed);
        return None;
    }
    let values = unsafe {
        let mut values: CFArrayRef = std::ptr::null();
        if AXUIElementCopyMultipleAttributeValues(element.0, walk.attrs.0, 0, &mut values) != AX_SUCCESS || values.is_null() {
            walk.incomplete.store(true, Ordering::Relaxed);
            return None;
        }
        Owned(values)
    };
    let at = |index: usize| -> CFTypeRef {
        let value = unsafe { CFArrayGetValueAtIndex(values.0, index as CFIndex) };
        // Missing attributes come back as AXValue(kAXValueIllegalType) errors.
        if value.is_null() || unsafe { CFGetTypeID(value) == AXValueGetTypeID() && AXValueGetType(value) == 0 } {
            std::ptr::null()
        } else {
            value
        }
    };
    let ax_role = unsafe { to_string(at(ROLE)) }.unwrap_or_default();
    let subrole = unsafe { to_string(at(SUBROLE)) };
    let role = normalize_role(&ax_role, subrole.as_deref());
    // Keep xa11y's exact name semantics (an empty AXTitle stays `""`): action
    // dispatch re-reads the live element through xa11y and compares names.
    let title = unsafe { to_string(at(TITLE)) };
    let ax_description = unsafe { to_string(at(DESCRIPTION)) };
    let help = unsafe { to_string(at(HELP)) };
    let raw_value = at(VALUE);
    let value_text = unsafe { to_string(raw_value) }.or_else(|| unsafe { to_number(raw_value) }.map(|n| n.to_string()));
    let name = title.or_else(|| if role == "static_text" { value_text.clone() } else { ax_description.clone() });
    let description = help.or_else(|| if name != ax_description { ax_description.clone() } else { None });
    let value = if matches!(role, "check_box" | "radio_button") { None } else { value_text };
    let frame = match (unsafe { to_pair(at(POSITION), K_AX_VALUE_CGPOINT) }, unsafe { to_pair(at(SIZE), K_AX_VALUE_CGSIZE) }) {
        (Some((x, y)), Some((w, h))) if w > 0.0 || h > 0.0 => Some((x, y, w.max(0.0), h.max(0.0))),
        _ => None,
    };
    let bounds = frame.map(|(x, y, w, h)| json!({ "x": x as i32, "y": y as i32, "width": w as u32, "height": h as u32 }));
    // Rows scrolled out of a list's viewport are not on screen: keep the node
    // (so paths stay aligned and SCROLL_TO stays possible) but do not pay to
    // read its subtree.
    let clipped = matches!((frame, clip), (Some(f), Some(c)) if f.3 > 0.0 && !intersects(f, c));
    let next_clip = if matches!(ax_role.as_str(), "AXScrollArea" | "AXTable" | "AXOutline" | "AXList" | "AXWebArea") {
        frame.map(|f| match clip {
            Some(c) => {
                let x = f.0.max(c.0);
                let y = f.1.max(c.1);
                (x, y, ((f.0 + f.2).min(c.0 + c.2) - x).max(0.0), ((f.1 + f.3).min(c.1 + c.3) - y).max(0.0))
            }
            None => f,
        }).or(clip)
    } else {
        clip
    };
    let focused = unsafe { to_bool(at(FOCUSED)) };
    // AXCopyActionNames is a second IPC per node and costs as much as the
    // whole attribute batch on Electron apps. Pure text/image/layout nodes
    // never act, so only ask roles that can.
    let actions = if passive_role(role) {
        Owned(std::ptr::null())
    } else {
        let mut names: CFArrayRef = std::ptr::null();
        let _ = unsafe { AXUIElementCopyActionNames(element.0, &mut names) };
        Owned(names)
    };
    let mut action_list: Vec<String> = Vec::new();
    if !actions.0.is_null() {
        for index in 0..unsafe { CFArrayGetCount(actions.0) } {
            if let Some(raw) = unsafe { to_string(CFArrayGetValueAtIndex(actions.0, index)) } {
                let mapped = match raw.as_str() {
                    "AXPress" | "AXConfirm" => "press".to_string(),
                    "AXRaise" => "activate".to_string(),
                    other => snake(other),
                };
                if !action_list.contains(&mapped) {
                    action_list.push(mapped);
                }
            }
        }
    }
    if focused.is_some() && !action_list.iter().any(|a| a == "focus") {
        action_list.push("focus".into());
    }
    if matches!(role, "text_field" | "text_area" | "slider") && !action_list.iter().any(|a| a == "set_value") {
        action_list.push("set_value".into());
    }
    let states = json!({
        "enabled": unsafe { to_bool(at(ENABLED)) }.unwrap_or(true),
        "visible": !unsafe { to_bool(at(HIDDEN)) }.unwrap_or(false),
        "focused": focused.unwrap_or(false),
        "selected": unsafe { to_bool(at(SELECTED)) }.unwrap_or(false),
        "expanded": unsafe { to_bool(at(EXPANDED)) },
        "editable": matches!(role, "text_field" | "text_area"),
        "checked": if matches!(role, "check_box" | "radio_button") { unsafe { to_number(raw_value) }.map(|n| n > 0.5) } else { None },
    });
    let stable_id = unsafe { to_string(at(IDENTIFIER)) };

    let children_raw = at(CHILDREN);
    let children: Vec<Owned> = if !children_raw.is_null() && unsafe { CFGetTypeID(children_raw) == CFArrayGetTypeID() } {
        (0..unsafe { CFArrayGetCount(children_raw) })
            .filter_map(|i| {
                let child = unsafe { CFArrayGetValueAtIndex(children_raw, i) };
                (!child.is_null() && unsafe { CFGetTypeID(child) == AXUIElementGetTypeID() }).then(|| Owned(unsafe { CFRetain(child) }))
            })
            .collect()
    } else {
        Vec::new()
    };
    // Window chrome is never a task target; skipping it matches xa11y.
    let children: Vec<Owned> = if role == "window" {
        children.into_iter().filter(|child| !is_window_chrome(child, name.as_deref())).collect()
    } else {
        children
    };

    let (window_role, window_name) = match window {
        Some((r, n)) => (r.to_string(), n.map(str::to_string)),
        None => (role.to_string(), name.clone()),
    };
    let target = json!({ "snapshot_id": walk.snapshot_id, "path": path, "role": role, "name": name, "stable_id": stable_id });
    let mut out = json!({
        "target": target,
        "ref_id": target.to_string(),
        "role": role,
        "name": name,
        "description": description,
        "value": value,
        "bounds": bounds,
        "states": states,
        "actions": action_list,
        "available_actions": action_list,
        "stable_id": stable_id,
        "children_count": children.len(),
        "pid": walk.pid,
        "children": [],
    });
    if clipped {
        let mut states = out["states"].clone();
        states["offscreen"] = json!(true);
        out["states"] = states;
    }
    if depth >= walk.max_depth || clipped {
        if !children.is_empty() {
            out["truncated"] = json!(true);
        }
        return Some(out);
    }
    // Claim node budget for this whole child level up front so parallel
    // workers never overshoot the global cap.
    let wanted = children.len();
    let granted = claim(&walk.remaining, wanted);
    if granted < wanted {
        walk.incomplete.store(true, Ordering::Relaxed);
        out["truncated"] = json!(true);
    }
    let window_ctx = (window_role.as_str(), window_name.as_deref());
    let read_child = |(index, child): (usize, &Owned)| {
        let mut child_path = path.clone();
        child_path.push(index);
        read(walk, child, child_path, depth + 1, Some(window_ctx), next_clip)
    };
    let items: Vec<(usize, &Owned)> = children.iter().enumerate().take(granted).collect();
    let results: Vec<Option<Value>> = if items.len() > 1 {
        std::thread::scope(|scope| {
            // Bounded fan-out: each level spawns at most a few workers.
            let chunk = items.len().div_ceil(8);
            let handles: Vec<_> = items
                .chunks(chunk)
                .map(|slice| scope.spawn(move || slice.iter().map(|item| read_child(*item)).collect::<Vec<_>>()))
                .collect();
            handles.into_iter().flat_map(|handle| handle.join().unwrap_or_default()).collect()
        })
    } else {
        items.into_iter().map(read_child).collect()
    };
    // Keep path indices aligned with the live tree: a vanished child keeps its
    // slot as an inert placeholder rather than shifting its siblings' paths.
    out["children"] = Value::Array(
        results
            .into_iter()
            .map(|child| child.unwrap_or_else(|| json!({ "role": "unknown", "children": [], "children_count": 0, "actions": [], "available_actions": [], "states": { "enabled": false, "visible": false } })))
            .collect(),
    );
    Some(out)
}

/// Roles that never expose actions; skipping the action-name IPC for them
/// halves the cost of text-heavy trees. Focus stays available through the
/// AXFocused attribute.
fn passive_role(role: &str) -> bool {
    matches!(role, "static_text" | "image" | "separator" | "scroll_bar" | "scroll_thumb" | "progress_bar" | "table_row" | "heading" | "unknown")
}

fn claim(remaining: &AtomicUsize, wanted: usize) -> usize {
    let mut current = remaining.load(Ordering::Relaxed);
    loop {
        let take = current.min(wanted);
        match remaining.compare_exchange_weak(current, current - take, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return take,
            Err(actual) => current = actual,
        }
    }
}

/// Same filter xa11y applies to window children, so child indices (and
/// therefore target paths) agree with xa11y-based action dispatch.
fn is_window_chrome(child: &Owned, window_name: Option<&str>) -> bool {
    let read = |attr: &str| {
        let key = cfstr(attr);
        let mut value: CFTypeRef = std::ptr::null();
        let ok = unsafe { AXUIElementCopyAttributeValue(child.0, key.0, &mut value) } == AX_SUCCESS;
        let value = Owned(value);
        if ok { unsafe { to_string(value.0) } } else { None }
    };
    let subrole = read("AXSubrole");
    let sr = subrole.as_deref().unwrap_or("");
    if matches!(sr, "AXCloseButton" | "AXMinimizeButton" | "AXFullScreenButton" | "AXZoomButton") {
        return true;
    }
    if (sr.is_empty() || sr == "AXUnknown") && read("AXRole").as_deref() == Some("AXStaticText") {
        return window_name.is_some() && read("AXValue").as_deref() == window_name;
    }
    false
}

fn snake(ax: &str) -> String {
    let name = ax.strip_prefix("AX").unwrap_or(ax);
    let mut out = String::with_capacity(name.len() + 4);
    for (i, ch) in name.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Mirrors xa11y's role mapping so refs issued here resolve through
/// xa11y-based action dispatch.
fn normalize_role(role: &str, subrole: Option<&str>) -> &'static str {
    match subrole {
        Some("AXDialog") => return "dialog",
        Some("AXApplicationAlert" | "AXSystemAlert") => return "alert",
        Some("AXTabButton") => return "tab",
        Some("AXOutlineRow") => return "tree_item",
        Some("AXHeading") => return "heading",
        Some("AXSwitch") => return "switch",
        Some("AXLandmarkNavigation") => return "navigation",
        _ => {}
    }
    match role {
        "AXApplication" => "application",
        "AXWindow" | "AXDrawer" => "window",
        "AXSheet" | "AXDialog" => "dialog",
        "AXButton" => if subrole == Some("AXDisclosureTriangle") { "tree_item" } else { "button" },
        "AXRadioButton" => "radio_button",
        "AXCheckBox" => "check_box",
        "AXTextField" | "AXSecureTextField" => "text_field",
        "AXTextArea" => "text_area",
        "AXStaticText" => "static_text",
        "AXComboBox" | "AXPopUpButton" => "combo_box",
        "AXMenuButton" => if subrole == Some("AXSegment") { "button" } else { "combo_box" },
        "AXList" | "AXOutline" => "list",
        "AXTable" | "AXGrid" => "table",
        "AXRow" => "table_row",
        "AXCell" => "table_cell",
        "AXMenu" => "menu",
        "AXMenuItem" | "AXMenuBarItem" => "menu_item",
        "AXMenuBar" | "AXMenuBarExtra" => "menu_bar",
        "AXTabGroup" => "tab_group",
        "AXToolbar" => "toolbar",
        "AXScrollBar" => "scroll_bar",
        "AXSlider" => "slider",
        "AXImage" => "image",
        "AXLink" => "link",
        "AXGroup" | "AXScrollArea" | "AXLayoutArea" | "AXRadioGroup" | "AXBrowser" | "AXColumn" | "AXPopover" => "group",
        "AXProgressIndicator" | "AXBusyIndicator" | "AXLevelIndicator" => "progress_bar",
        "AXDisclosureTriangle" => "tree_item",
        "AXHeading" | "Heading" => "heading",
        "AXSplitGroup" => "split_group",
        "AXSplitter" => "separator",
        "AXWebArea" => "web_area",
        "AXIncrementor" => "spin_button",
        "AXToolTip" | "AXHelpTag" => "tooltip",
        "AXStatusBar" => "status",
        "AXValueIndicator" | "AXGrowArea" => "scroll_thumb",
        "AXSortButton" | "AXDockItem" => "button",
        _ => "unknown",
    }
}

/// Chromium/CEF/Electron renderers boot into a limited accessibility mode and
/// only build the full tree for an assistive client that explicitly requests
/// it. The request is the macOS-standard `AXManualAccessibility` /
/// `AXEnhancedUserInterface` write on the application element. The write is
/// sent only when the app itself advertises the attribute and it currently
/// reads as false — never blind, and never keyed on an app name. Chromium
/// applies the change behind a short debounce (measured ≈2s), so callers must
/// keep polling afterwards. Returns true when an activation write was sent.
pub fn activate_renderer_accessibility(pid: i32) -> bool {
    let app = Owned(unsafe { AXUIElementCreateApplication(pid) });
    if app.0.is_null() {
        return false;
    }
    let mut attempted = false;
    for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        let key = cfstr(name);
        let mut current: CFTypeRef = std::ptr::null();
        let error = unsafe { AXUIElementCopyAttributeValue(app.0, key.0, &mut current) };
        let readable = unsafe { to_bool(current) };
        let _read = Owned(current);
        if error != AX_SUCCESS || readable != Some(false) {
            continue;
        }
        unsafe { AXUIElementSetAttributeValue(app.0, key.0, kCFBooleanTrue) };
        attempted = true;
    }
    attempted
}

/// Observe every window of `pid`. `budget` bounds wall-clock time; a stalled
/// app returns a partial tree with `complete=false` instead of blocking.
pub fn observe_pid(pid: i32, app_name: &str, max_nodes: usize, budget: Duration) -> Result<Value, String> {
    // A TCC denial is process-wide and permanent for the task's lifetime;
    // surface it as its own failure class instead of folding it into
    // WINDOW_NOT_FOUND, which would send the caller into app-restart loops.
    if !accessibility_trusted() {
        return Err(
            "AX_PERMISSION_DENIED: this process is not trusted for Accessibility. \
             Enable the host app under System Settings → Privacy & Security → Accessibility."
                .into(),
        );
    }
    let app = Owned(unsafe { AXUIElementCreateApplication(pid) });
    if app.0.is_null() {
        return Err("target application has no observable AX window".into());
    }
    // Applies to every message sent to this application process.
    unsafe { AXUIElementSetMessagingTimeout(app.0, PER_CALL_TIMEOUT_SECS) };
    let key = cfstr("AXWindows");
    let mut windows: CFTypeRef = std::ptr::null();
    let error = unsafe { AXUIElementCopyAttributeValue(app.0, key.0, &mut windows) };
    let windows = Owned(windows);
    if error != AX_SUCCESS || windows.0.is_null() || unsafe { CFGetTypeID(windows.0) != CFArrayGetTypeID() } {
        return Err(if error == -25204 || error == -25205 {
            format!("APP_UNRESPONSIVE: application did not answer accessibility requests (AXError {error})")
        } else {
            "target application has no observable AX window".into()
        });
    }
    let names: Vec<Owned> = ATTRS.iter().map(|name| cfstr(name)).collect();
    let pointers: Vec<CFTypeRef> = names.iter().map(|name| name.0).collect();
    let attrs = Owned(unsafe { CFArrayCreate(std::ptr::null(), pointers.as_ptr(), pointers.len() as CFIndex, &kCFTypeArrayCallBacks as *const c_void) });
    let snapshot_id = format!("ax:{}", uuid::Uuid::new_v4().simple());
    let window_list: Vec<Owned> = (0..unsafe { CFArrayGetCount(windows.0) })
        .map(|i| Owned(unsafe { CFRetain(CFArrayGetValueAtIndex(windows.0, i)) }))
        .collect();
    let limit = max_nodes.clamp(1, 5_000);
    let walk = Walk {
        attrs,
        snapshot_id: snapshot_id.clone(),
        pid: pid as i64,
        remaining: AtomicUsize::new(limit.saturating_sub(1 + window_list.len())),
        deadline: Instant::now() + budget,
        incomplete: AtomicBool::new(false),
        max_depth: 32,
    };
    let children: Vec<Value> = std::thread::scope(|scope| {
        let handles: Vec<_> = window_list
            .iter()
            .enumerate()
            .map(|(index, window)| {
                let walk = &walk;
                scope.spawn(move || read(walk, window, vec![index], 1, None, None))
            })
            .collect();
        handles.into_iter().filter_map(|handle| handle.join().ok().flatten()).collect()
    });
    let complete = !walk.incomplete.load(Ordering::Relaxed);
    let node_count = limit - walk.remaining.load(Ordering::Relaxed);
    let body = json!({
        "schema": "orbit.ax.v1",
        "app": app_name,
        "pid": pid,
        "role": "application",
        "name": app_name,
        "children": children,
        "node_count": node_count,
        "window_count": children.len(),
        "truncated": !complete,
    });
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    body.to_string().hash(&mut hasher);
    Ok(json!({
        "schema": "orbit.ax.snapshot.v1",
        "snapshot_id": snapshot_id,
        "app": app_name,
        "window": { "id": format!("pid:{pid}"), "title": app_name },
        "complete": complete,
        "truncated": !complete,
        "ref_count": node_count,
        "tree": body,
        "fingerprint": format!("ax:{:016x}", hasher.finish()),
    }))
}

/// Whether the current process has macOS Accessibility trust. The production
/// broker calls AX inside Orbit itself, so this reflects Orbit's grant.
pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Resolve a running GUI application's pid by localized name, bundle name or
/// bundle identifier through NSWorkspace — one in-process call, instead of
/// building accessibility data for every running app.
pub fn find_pid(app_name: &str) -> Option<i32> {
    use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
    let wanted = app_name.trim();
    let workspace = NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();
    let mut fallback = None;
    for app in apps.iter() {
        if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
            continue;
        }
        let name = app.localizedName().map(|n| n.to_string()).unwrap_or_default();
        let bundle = app.bundleIdentifier().map(|n| n.to_string()).unwrap_or_default();
        let file = app
            .bundleURL()
            .and_then(|url| url.lastPathComponent())
            .map(|n| n.to_string().trim_end_matches(".app").to_string())
            .unwrap_or_default();
        if name == wanted || bundle == wanted {
            return Some(app.processIdentifier());
        }
        if fallback.is_none() && (file == wanted || name.eq_ignore_ascii_case(wanted) || file.eq_ignore_ascii_case(wanted)) {
            fallback = Some(app.processIdentifier());
        }
    }
    fallback
}

/// Bring a running regular application to the foreground without requiring
/// an AX window to exist first. Electron apps can keep their process alive
/// while their window is hidden or still being rebuilt; querying AXWindows
/// before this activation incorrectly reports WINDOW_NOT_FOUND.
pub fn activate_pid(pid: i32) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    unsafe {
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .map(|application| {
                application.activateWithOptions(
                    NSApplicationActivationOptions::ActivateAllWindows
                        | NSApplicationActivationOptions::ActivateIgnoringOtherApps,
                )
            })
            .unwrap_or(false)
    }
}

// ------------------------------------------------------------------ menu bar
//
// The application menu bar is a declared, labeled command surface: every item
// carries its title, enabled state and (often) a keyboard shortcut. It lets
// the agent reach commands that toolbars expose only as unlabeled icons.

const MENU_MAX_ITEMS: usize = 400;
const MENU_MAX_DEPTH: usize = 3;

fn attr(element: &Owned, name: &str) -> Owned {
    let key = cfstr(name);
    let mut value: CFTypeRef = std::ptr::null();
    let error = unsafe { AXUIElementCopyAttributeValue(element.0, key.0, &mut value) };
    if error != AX_SUCCESS {
        return Owned(std::ptr::null());
    }
    Owned(value)
}

fn children_of(element: &Owned) -> Vec<Owned> {
    let children = attr(element, "AXChildren");
    if children.0.is_null() || unsafe { CFGetTypeID(children.0) != CFArrayGetTypeID() } {
        return Vec::new();
    }
    (0..unsafe { CFArrayGetCount(children.0) })
        .filter_map(|i| {
            let child = unsafe { CFArrayGetValueAtIndex(children.0, i) };
            (!child.is_null() && unsafe { CFGetTypeID(child) == AXUIElementGetTypeID() }).then(|| Owned(unsafe { CFRetain(child) }))
        })
        .collect()
}

/// Children of a menu-bar item or menu item, looking through the AXMenu
/// container that holds the actual items.
fn menu_items(element: &Owned) -> Vec<Owned> {
    let mut out = Vec::new();
    for child in children_of(element) {
        if unsafe { to_string(attr(&child, "AXRole").0) }.as_deref() == Some("AXMenu") {
            out.extend(children_of(&child));
        } else {
            out.push(child);
        }
    }
    out
}

fn shortcut(item: &Owned) -> Option<String> {
    let key = unsafe { to_string(attr(item, "AXMenuItemCmdChar").0) }?.trim().to_string();
    if key.is_empty() {
        return None;
    }
    // kAXMenuItemModifier bits: 1=shift, 2=option, 4=control, 8=no command.
    let modifiers = unsafe { to_number(attr(item, "AXMenuItemCmdModifiers").0) }.unwrap_or(0.0) as i64;
    let mut out = String::new();
    if modifiers & 4 != 0 { out.push('⌃'); }
    if modifiers & 2 != 0 { out.push('⌥'); }
    if modifiers & 1 != 0 { out.push('⇧'); }
    if modifiers & 8 == 0 { out.push('⌘'); }
    out.push_str(&key.to_uppercase());
    Some(out)
}

fn app_menu_bar(pid: i32) -> Result<Owned, String> {
    let app = Owned(unsafe { AXUIElementCreateApplication(pid) });
    if app.0.is_null() {
        return Err("target application is unavailable".into());
    }
    unsafe { AXUIElementSetMessagingTimeout(app.0, 0.5) };
    let bar = attr(&app, "AXMenuBar");
    if bar.0.is_null() {
        return Err("target application exposes no menu bar".into());
    }
    Ok(bar)
}

/// Read the application's menu bar as `{path, enabled, shortcut, checked}`
/// leaves. The Apple menu (first item) is skipped: it belongs to the system.
pub fn read_menu_bar(pid: i32) -> Result<Value, String> {
    let bar = app_menu_bar(pid)?;
    let mut items = Vec::new();
    fn visit(element: &Owned, path: &mut Vec<String>, depth: usize, items: &mut Vec<Value>) {
        for item in menu_items(element) {
            if items.len() >= MENU_MAX_ITEMS {
                return;
            }
            let title = unsafe { to_string(attr(&item, "AXTitle").0) }.unwrap_or_default().trim().to_string();
            if title.is_empty() {
                continue; // separators
            }
            let enabled = unsafe { to_bool(attr(&item, "AXEnabled").0) }.unwrap_or(true);
            path.push(title);
            let sub = if depth < MENU_MAX_DEPTH { menu_items(&item) } else { Vec::new() };
            if sub.is_empty() || depth >= MENU_MAX_DEPTH {
                let checked = unsafe { to_string(attr(&item, "AXMenuItemMarkChar").0) }.map(|mark| !mark.trim().is_empty()).unwrap_or(false);
                items.push(json!({ "path": path.clone(), "enabled": enabled, "shortcut": shortcut(&item), "checked": checked }));
            } else if enabled {
                visit(&item, path, depth + 1, items);
            }
            path.pop();
        }
    }
    let top = children_of(&bar);
    for (index, menu) in top.iter().enumerate() {
        if index == 0 {
            continue;
        }
        let title = unsafe { to_string(attr(menu, "AXTitle").0) }.unwrap_or_default().trim().to_string();
        if title.is_empty() {
            continue;
        }
        let mut path = vec![title];
        visit(menu, &mut path, 1, &mut items);
    }
    Ok(json!({ "items": items, "truncated": items.len() >= MENU_MAX_ITEMS }))
}

/// Press a menu item by exact title path, resolving every hop from the live
/// menu bar (opening a menu can replace its AX objects). Each segment must
/// match exactly one enabled item.
pub fn press_menu_path(pid: i32, path: &[String]) -> Result<Value, String> {
    if path.len() < 2 {
        return Err("menu path needs a top-level menu and an item".into());
    }
    let press = |element: &Owned, final_segment: bool| -> Result<(), String> {
        let order: &[&str] = if final_segment { &["AXPress", "AXPick", "AXConfirm"] } else { &["AXPress", "AXPick", "AXShowMenu", "AXOpen"] };
        let mut names: CFArrayRef = std::ptr::null();
        unsafe { AXUIElementCopyActionNames(element.0, &mut names) };
        let names = Owned(names);
        let mut available = Vec::new();
        if !names.0.is_null() {
            for i in 0..unsafe { CFArrayGetCount(names.0) } {
                if let Some(name) = unsafe { to_string(CFArrayGetValueAtIndex(names.0, i)) } {
                    available.push(name);
                }
            }
        }
        let action = order.iter().find(|name| available.iter().any(|a| a == *name)).ok_or("menu item has no usable native action")?;
        let key = cfstr(action);
        let error = unsafe { AXUIElementPerformAction(element.0, key.0) };
        if error != AX_SUCCESS {
            return Err(format!("menu action failed (AXError {error})"));
        }
        Ok(())
    };
    for depth in 1..path.len() {
        let bar = app_menu_bar(pid)?;
        let mut current: Option<Owned> = None;
        for (index, segment) in path[..=depth].iter().enumerate() {
            let pool = match &current { None => children_of(&bar), Some(parent) => menu_items(parent) };
            let mut matches: Vec<Owned> = pool.into_iter().filter(|item| unsafe { to_string(attr(item, "AXTitle").0) }.map(|t| t.trim() == segment).unwrap_or(false)).collect();
            if matches.len() != 1 {
                return Err(format!("menu path segment {index} {}", if matches.is_empty() { "was not found" } else { "is ambiguous" }));
            }
            current = matches.pop();
        }
        let target = current.ok_or("empty menu path")?;
        if unsafe { to_bool(attr(&target, "AXEnabled").0) } == Some(false) {
            return Err(format!("menu path segment {depth} is disabled"));
        }
        press(&target, depth + 1 == path.len())?;
        if depth + 1 != path.len() {
            std::thread::sleep(Duration::from_millis(80));
        }
    }
    Ok(json!({ "operation": "menu-press", "path": path }))
}
