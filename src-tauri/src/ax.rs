//! Native accessibility control plane.
//!
//! The LLM/Jev layer must only see the normalized snapshot produced here. It
//! never receives native handles. The current encoded target is NOT a
//! snapshot-scoped action lease. Action delivery must remain disabled.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::thread;
use std::time::Duration;
use uuid::Uuid;
use xa11y::{App, AppExt, Element};

const MAX_NODES: usize = 2_000;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AxTarget {
    pub snapshot_id: String,
    pub path: Vec<usize>,
    pub role: String,
    pub name: Option<String>,
    pub stable_id: Option<String>,
}

fn target_ref(target: &AxTarget) -> String {
    serde_json::to_string(target).expect("AX target is serializable")
}

fn target_for(element: &Element, snapshot_id: &str, path: &[usize]) -> AxTarget {
    let d = element.data();
    AxTarget {
        snapshot_id: snapshot_id.to_string(),
        path: path.to_vec(),
        role: d.role.to_snake_case().to_string(),
        name: d.name.clone(),
        stable_id: d.stable_id.clone(),
    }
}

fn node(
    element: &Element,
    snapshot_id: &str,
    path: &mut Vec<usize>,
    depth: usize,
    remaining: &mut usize,
) -> Value {
    let d = element.data();
    let target = target_for(element, snapshot_id, path);
    let mut out = json!({
        "target": target.clone(),
        "ref_id": target_ref(&target),
        "role": d.role.to_snake_case(),
        "name": d.name,
        "description": d.description,
        "value": d.value,
        "bounds": d.bounds,
        "states": d.states,
        "actions": d.actions,
        "available_actions": d.actions,
        "stable_id": d.stable_id,
        "children_count": 0,
        "pid": d.pid,
        "children": [],
    });
    // One child fetch per node. xa11y builds full ElementData (batched
    // attributes + action names) for every child it returns, so a second
    // children() call just to count them doubled every AX round trip.
    let children = element.children();
    if let Ok(items) = &children {
        out["children_count"] = json!(items.len());
    }
    if depth >= MAX_DEPTH || *remaining == 0 {
        out["truncated"] = json!(true);
        return out;
    }
    match children {
        Ok(children) => {
            let mut result = Vec::new();
            for (index, child) in children.into_iter().enumerate() {
                if *remaining == 0 {
                    out["truncated"] = json!(true);
                    break;
                }
                *remaining -= 1;
                path.push(index);
                result.push(node(&child, snapshot_id, path, depth + 1, remaining));
                path.pop();
            }
            out["children"] = json!(result);
        }
        Err(error) => out["children_error"] = json!(error.to_string()),
    }
    out
}

fn app(app_name: &str) -> Result<App, String> {
    if app_name.is_empty() || app_name.len() > 256 {
        return Err("invalid application name".into());
    }
    #[cfg(target_os = "macos")]
    if let Some(pid) = crate::fast_ax::find_pid(app_name).and_then(|pid| u32::try_from(pid).ok()) {
        return App::by_pid(pid, Duration::ZERO).map_err(|error| error.to_string());
    }
    App::by_name(app_name, Duration::ZERO).map_err(|e| e.to_string())
}

pub fn observe(app_name: &str, max_nodes: usize) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    if let Some(pid) = crate::fast_ax::find_pid(app_name) {
        return crate::fast_ax::observe_pid(pid, app_name, max_nodes, Duration::from_millis(3_000));
    }
    let app = app(app_name)?;
    let limit = max_nodes.clamp(1, MAX_NODES);
    let snapshot_id = format!("ax:{}", Uuid::new_v4().simple());
    let windows = app.windows().map_err(|e| e.to_string())?;
    let mut remaining = limit - 1;
    let mut children_json = Vec::new();
    for (index, child) in windows.into_iter().enumerate() {
        if remaining == 0 {
            break;
        }
        remaining -= 1;
        children_json.push(node(
            &child,
            &snapshot_id,
            &mut vec![index],
            1,
            &mut remaining,
        ));
    }
    let body = json!({
        "schema": "orbit.ax.v1",
        "app": app_name,
        "pid": app.data.pid,
        "role": app.data.role.to_snake_case(),
        "name": app.data.name,
        "children": children_json,
        "node_count": limit - remaining,
        "window_count": children_json.len(),
        "truncated": remaining == 0,
    });
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    body.to_string().hash(&mut hasher);
    let fingerprint = format!("ax:{:016x}", hasher.finish());
    Ok(json!({
        "schema": "orbit.ax.snapshot.v1",
        "snapshot_id": snapshot_id,
        "app": app_name,
        "window": { "id": format!("pid:{}", app.data.pid.unwrap_or_default()), "title": app.data.name },
        "complete": remaining != 0,
        "truncated": remaining == 0,
        "ref_count": limit - remaining,
        "tree": body,
        "fingerprint": fingerprint,
    }))
}

/// Activate an application without consuming a snapshot-scoped element ref.
/// Foregrounding is a prerequisite for later content actions, so it must be
/// robust to a process/window identity change caused by app activation.
pub fn activate_application(app_name: &str) -> Result<Value, String> {
    let root = app(app_name)?;
    #[cfg(target_os = "macos")]
    if let Some(pid) = root.data.pid.and_then(|pid| i32::try_from(pid).ok()) {
        // AXRaise is window-local. AppKit's NSRunningApplication activation is
        // the process-level primitive that can move a background app in front
        // of the Orbit host.
        unsafe {
            use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
            if let Some(application) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
                let options = NSApplicationActivationOptions::ActivateAllWindows
                    | NSApplicationActivationOptions::ActivateIgnoringOtherApps;
                let _ = application.activateWithOptions(options);
            }
        }
    }
    let windows = root.windows().map_err(|e| e.to_string())?;
    let window = windows.first().ok_or("target application has no observable AX window")?;
    window.activate().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if !App::foreground(Duration::ZERO)
        .map(|foreground| foreground.data.pid == root.data.pid)
        .unwrap_or(false)
    {
        // Some Electron/AppKit apps expose AXRaise but do not honor
        // AXFrontmost when activated from a background process. `open -a` is
        // the platform activation primitive here, and this command has no
        // snapshot ref or content mutation attached to it.
        let _ = Command::new("/usr/bin/open").args(["-a", app_name]).status();
    }
    let mut foreground = false;
    for _ in 0..12 {
        foreground = App::foreground(Duration::ZERO)
            .map(|app| app.data.pid == root.data.pid)
            .unwrap_or(false);
        if foreground {
            break;
        }
        thread::sleep(Duration::from_millis(80));
    }
    if !foreground {
        return Err("FOREGROUND_REQUIRED: application activation was not observed".into());
    }
    let current = app(app_name)?;
    let current_window = current
        .windows()
        .map_err(|e| e.to_string())?
        .first()
        .and_then(|window| window.data().name.clone());
    Ok(json!({
        "app": app_name,
        "pid": current.data.pid,
        "foreground": true,
        "window_title": current_window,
    }))
}

pub fn dispatch_observed(
    app_name: &str,
    target: &computer_use_core::ObservedTarget,
    operation: &str,
    value: Option<&str>,
    headed: bool,
) -> Result<Value, String> {
    let root = app(app_name)?;
    // Window activation is the explicit bridge from the agent's foreground
    // (Orbit) to the target app. It must be allowed while the target is in the
    // background; every other mutation remains foreground-gated.
    let activation_only = operation == "activate";
    // Semantic context-menu (AXShowMenu) and clearing a field (AXValue="")
    // are AX actions like press/set-value: safe without the foreground.
    let background_safe = (matches!(operation, "press" | "set-value" | "type" | "right-click" | "clear") && !headed) || operation == "scroll-to";
    if !activation_only && !background_safe {
        let foreground = App::foreground(Duration::ZERO).map_err(|e| e.to_string())?;
        if foreground.data.pid != root.data.pid {
            return Err(
                "FOREGROUND_REQUIRED: target application is not the active foreground process".into(),
            );
        }
    }
    let (first, rest) = target
        .path
        .split_first()
        .ok_or("empty observed target path")?;
    let mut element = root
        .windows()
        .map_err(|e| e.to_string())?
        .get(*first)
        .cloned()
        .ok_or("live window missing")?;
    let window_data = element.data();
    let window_role = window_data.role.to_snake_case().to_string();
    let window_name = window_data.name.clone();
    for index in rest {
        element = element
            .children()
            .map_err(|e| e.to_string())?
            .get(*index)
            .cloned()
            .ok_or("live element missing")?;
    }
    let d = element.data();
    let live_actions: Vec<String> = d.actions.iter().map(ToString::to_string).collect();
    if !target.matches_live(
        &target.path,
        &window_role,
        window_name.as_deref(),
        &d.role.to_snake_case(),
        d.name.as_deref(),
        d.stable_id.as_deref(),
        &live_actions,
    ) {
        return Err("live target identity changed".into());
    }
    if operation == "scroll-to" {
        return scroll_into_viewport(&root, &target.path);
    }
    if matches!(operation, "scroll-up" | "scroll-down") {
        let ax_action = if operation == "scroll-up" { "scroll_up_by_page" } else { "scroll_down_by_page" };
        if !live_actions.iter().any(|action| action == ax_action || action == "scroll") {
            return Err("target does not advertise requested scroll action".into());
        }
        if element.perform_action(ax_action).is_err() {
            // The native accessibility tree can advertise page scrolling yet
            // reject the action. Wheel fallback is bounded to the observed
            // scroll container, never an arbitrary screen coordinate.
            let bounds = d.bounds.ok_or("scroll target has no bounds")?;
            if bounds.width == 0 || bounds.height == 0 {
                return Err("scroll target has no visible bounds".into());
            }
            let point = xa11y::Point {
                x: bounds.x + bounds.width as i32 / 2,
                y: bounds.y + bounds.height as i32 / 2,
            };
            let ticks = if operation == "scroll-down" { -5 } else { 5 };
            xa11y::input_sim().map_err(|e| e.to_string())?
                .mouse().scroll(point, xa11y::ScrollDelta::new(0, ticks))
                .map_err(|e| e.to_string())?;
        }
        return Ok(json!({"operation": operation, "role": d.role.to_snake_case()}));
    }
    if operation == "right-click" {
        if !live_actions.iter().any(|action| action == "show_menu") {
            return Err("target does not advertise a context menu (AXShowMenu)".into());
        }
        element.show_menu().map_err(|e| e.to_string())?;
        return Ok(json!({"operation": operation, "role": d.role.to_snake_case()}));
    }
    if operation == "clear" {
        if !live_actions.iter().any(|action| action == "set_value") {
            return Err("target does not advertise a settable value".into());
        }
        element.set_value("").map_err(|e| e.to_string())?;
        let post = element.data();
        return Ok(json!({"role":post.role.to_snake_case(),"name":post.name,"value":post.value,"operation":operation}));
    }
    let ax_operation = match operation {
        "click" | "focus" | "press" | "double-click" | "activate" => operation,
        "set-value" => "set_value",
        "type" => "type_text",
        _ => return Err(format!("unsupported AX action: {operation}")),
    };
    if !live_actions.iter().any(|action| {
        action == ax_operation
            || ((ax_operation == "click" || ax_operation == "double-click" || ax_operation == "activate")
                && (action == "activate"
                    || action == "press"
                    || action == "focus"))
            || (ax_operation == "press" && (action == "activate" || action == "focus"))
            || (ax_operation == "type_text" && action == "set_value")
    }) {
        return Err("target does not advertise requested AX action".into());
    }
    match ax_operation {
        "focus" => element.focus().map_err(|e| e.to_string())?,
        "click" => {
            let input = xa11y::input_sim().map_err(|e| e.to_string())?;
            input.mouse().click(&element).map_err(|e| e.to_string())?;
        }
        "double-click" => {
            let input = xa11y::input_sim().map_err(|e| e.to_string())?;
            input.mouse().double_click(&element).map_err(|e| e.to_string())?;
        }
        "press" => element.press().map_err(|e| e.to_string())?,
        "activate" => {
            // Element::activate performs the platform-native AXFrontmost plus
            // AXRaise sequence. Do not relaunch with `open -a` here: an
            // Electron single-instance app can replace its process identity,
            // invalidating the snapshot-scoped target lease.
            element.activate().map_err(|e| e.to_string())?;
            let mut foreground = false;
            for _ in 0..10 {
                foreground = App::foreground(Duration::ZERO)
                    .map(|app| app.data.pid == root.data.pid)
                    .unwrap_or(false);
                if foreground {
                    break;
                }
                thread::sleep(Duration::from_millis(80));
            }
            if !foreground {
                return Err("FOREGROUND_REQUIRED: target window activation was not observed".into());
            }
        }
        "set_value" => element
            .set_value(value.ok_or("missing value")?)
            .map_err(|e| e.to_string())?,
        "type_text" if headed => {
            element.focus().map_err(|e| e.to_string())?;
            let input = xa11y::input_sim().map_err(|e| e.to_string())?;
            input.keyboard().chord(xa11y::Key::Char('a'), &[xa11y::Key::Meta]).map_err(|e| e.to_string())?;
            input.keyboard().type_text(value.ok_or("missing value")?).map_err(|e| e.to_string())?;
        }
        "type_text" => element
            .type_text(value.ok_or("missing value")?)
            .map_err(|e| e.to_string())?,
        _ => unreachable!(),
    }
    let post = element.data();
    Ok(
        json!({"role":post.role.to_snake_case(),"name":post.name,"value":post.value,"states":post.states,"operation":operation}),
    )
}

fn resolve_path(root: &App, path: &[usize]) -> Result<Vec<Element>, String> {
    let (first, rest) = path.split_first().ok_or("empty observed target path")?;
    let mut chain = vec![root
        .windows()
        .map_err(|e| e.to_string())?
        .get(*first)
        .cloned()
        .ok_or("live window missing")?];
    for index in rest {
        let next = chain
            .last()
            .unwrap()
            .children()
            .map_err(|e| e.to_string())?
            .get(*index)
            .cloned()
            .ok_or("live element missing")?;
        chain.push(next);
    }
    Ok(chain)
}

/// Bring an element inside its nearest scrollable ancestor's viewport using
/// the container's semantic page-scroll actions. AX reports list rows below
/// the fold as "visible", so pointer delivery would land outside the list;
/// this is app-agnostic and needs no pointer or foreground.
fn scroll_into_viewport(root: &App, path: &[usize]) -> Result<Value, String> {
    let is_scroller = |element: &Element| {
        element
            .data()
            .actions
            .iter()
            .any(|action| action.to_string() == "scroll_down_by_page")
    };
    let mut pages = 0;
    for _ in 0..40 {
        let chain = resolve_path(root, path)?;
        let target = chain.last().unwrap().data();
        let container = chain[..chain.len() - 1]
            .iter()
            .rev()
            .find(|element| is_scroller(element))
            .ok_or("target has no scrollable ancestor")?;
        let (Some(t), Some(c)) = (target.bounds, container.data().bounds) else {
            return Err("scroll target has no bounds".into());
        };
        let center = t.y + t.height as i32 / 2;
        let action = if center < c.y {
            "scroll_up_by_page"
        } else if center > c.y + c.height as i32 {
            "scroll_down_by_page"
        } else {
            return Ok(json!({ "operation": "scroll-to", "pages": pages, "in_viewport": true }));
        };
        if container.perform_action(action).is_err() {
            // Some native lists (WeChat) reject page-scroll actions. Fall back
            // to scroll-wheel ticks at the container centre; wheel events are
            // routed by pointer position, so the target app must be frontmost.
            let foreground = App::foreground(Duration::ZERO)
                .map(|app| app.data.pid == root.data.pid)
                .unwrap_or(false);
            if !foreground {
                return Err("FOREGROUND_REQUIRED: wheel scrolling needs the target application in front".into());
            }
            let input = xa11y::input_sim().map_err(|e| e.to_string())?;
            let point = xa11y::Point { x: c.x + c.width as i32 / 2, y: c.y + c.height as i32 / 2 };
            let ticks = if action == "scroll_down_by_page" { -5 } else { 5 };
            input.mouse().scroll(point, xa11y::ScrollDelta::new(0, ticks)).map_err(|e| e.to_string())?;
        }
        pages += 1;
        thread::sleep(Duration::from_millis(150));
    }
    Err("target did not enter the scroll viewport".into())
}

pub fn dispatch_focused(app_name: &str, operation: &str, key: &str) -> Result<Value, String> {
    let root = app(app_name)?;
    if !App::foreground(Duration::ZERO)
        .map_err(|e| e.to_string())?
        .data
        .pid
        .eq(&root.data.pid)
    {
        return Err("FOREGROUND_REQUIRED: target application is not foreground".into());
    }
    if operation != "press" {
        return Err("unsupported focused action".into());
    }
    // Return is a keyboard action, not an AX action on an arbitrary focused
    // wrapper. Deliver it through the platform keyboard after foreground/PID
    // validation; the successor snapshot is the only delivery evidence.
    // Escape is the platform-generic dismiss for menus, popovers and sheets.
    let (key, label) = match key {
        "return" => (xa11y::Key::Enter, "enter"),
        "escape" => (xa11y::Key::Escape, "escape"),
        _ => return Err("unsupported focused key".into()),
    };
    let input = xa11y::input_sim().map_err(|e| e.to_string())?;
    input.keyboard().press(key).map_err(|e| e.to_string())?;
    Ok(json!({"operation":operation,"keyboard":label}))
}

fn target_from_ref(value: &str) -> Result<AxTarget, String> {
    serde_json::from_str(value).map_err(|_| "invalid AX target ref".to_string())
}

fn resolve(root: &App, target: &AxTarget) -> Result<Element, String> {
    let (first, rest) = target.path.split_first().ok_or("empty AX target path")?;
    let mut current = root
        .windows()
        .map_err(|e| e.to_string())?
        .get(*first)
        .cloned()
        .ok_or("stale AX window path")?;
    for index in rest {
        current = current
            .children()
            .map_err(|e| e.to_string())?
            .get(*index)
            .cloned()
            .ok_or("stale AX element path")?;
    }
    let d = current.data();
    if d.role.to_snake_case() != target.role
        || d.name != target.name
        || d.stable_id != target.stable_id
    {
        return Err("action target changed since observation".into());
    }
    Ok(current)
}

#[allow(dead_code)] // Prototype only: the worker does not expose action delivery.
fn execute_action(
    app_name: &str,
    snapshot_id: &str,
    operation: &str,
    reference: &str,
    value: Option<&str>,
) -> Result<Value, String> {
    let target = if operation == "press" && reference == "return" {
        None
    } else {
        Some(target_from_ref(reference)?)
    };
    if let Some(target) = &target {
        if target.snapshot_id != snapshot_id {
            return Err("stale AX snapshot lease".into());
        }
    }
    let root = app(app_name)?;
    if !root.is_foreground() {
        return Err("target application is not foreground".into());
    }
    let element = if operation == "press" && reference == "return" {
        fn find_focused(element: &Element) -> Result<Option<Element>, String> {
            if element.data().states.focused {
                return Ok(Some(element.clone()));
            }
            for child in element.children().map_err(|e| e.to_string())? {
                if let Some(found) = find_focused(&child)? {
                    return Ok(Some(found));
                }
            }
            Ok(None)
        }
        let mut focused = None;
        for window in root.windows().map_err(|e| e.to_string())? {
            if let Some(found) = find_focused(&window)? {
                focused = Some(found);
                break;
            }
        }
        focused.ok_or("no focused AX element")?
    } else {
        resolve(&root, target.as_ref().ok_or("missing action target")?)?
    };
    let data = element.data();
    let advertised = |name: &str| data.actions.iter().any(|action| action == name);
    match operation {
        "focus" => {
            if !advertised("focus") {
                return Err("target does not advertise focus".into());
            }
            element.focus().map_err(|e| e.to_string())?;
        }
        "press" => {
            if !advertised("press") && !advertised("activate") {
                return Err("target does not advertise press".into());
            }
            element.press().map_err(|e| e.to_string())?;
        }
        "set-value" => {
            if !advertised("set_value") {
                return Err("target does not advertise set_value".into());
            }
            element
                .set_value(value.ok_or("missing value")?)
                .map_err(|e| e.to_string())?;
        }
        "type" => {
            if !advertised("type_text") {
                return Err("target does not advertise type_text".into());
            }
            element
                .type_text(value.ok_or("missing value")?)
                .map_err(|e| e.to_string())?;
        }
        _ => return Err(format!("unsupported AX action: {operation}")),
    }
    let post = element.data();
    let verified = operation == "set-value" && value.is_some() && post.value.as_deref() == value;
    Ok(
        json!({ "disposition": { "delivery": if verified { "delivered_verified" } else { "delivered_unverified" }, "retry": "never" }, "post_state": { "role": post.role.to_snake_case(), "name": post.name, "value": post.value, "states": post.states }, "verification_scope": if verified { "element_value" } else { "unavailable" } }),
    )
}

/* legacy action implementation retained below as design reference; action delivery is disabled.
fn legacy_action(operation: &str) -> Result<&str, String> {
    match operation {
        "focus" | "set-value" | "type" | "press" => Ok(operation),
        _ => Err(format!("unsupported AX operation: {operation}")),
    }
}

fn focused_element(root: &App) -> Result<Element, String> {
    fn walk(element: &Element) -> Result<Option<Element>, String> {
        if element.data().states.focused {
            return Ok(Some(element.clone()));
        }
        for child in element.children().map_err(|e| e.to_string())? {
            if let Some(found) = walk(&child)? {
                return Ok(Some(found));
            }
        }
        Ok(None)
    }
    for child in root.children().map_err(|e| e.to_string())? {
        if let Some(found) = walk(&child)? {
            return Ok(found);
        }
    }
    Err("no focused AX element".into())
}

pub(crate) fn execute_ref(
    app_name: &str,
    operation: &str,
    reference: &str,
    value: Option<String>,
) -> Result<Value, String> {
    let operation = legacy_action(operation)?;
    let root = app(app_name)?;
    if !root.is_foreground() {
        return Err("target application is not foreground; refusing desktop mutation".into());
    }
    let element = if operation == "press" && reference == "return" {
        focused_element(&root)?
    } else {
        let target = target_from_ref(reference)?;
        resolve(&root, &target)?
    };
    if !element.data().actions.iter().any(|item| {
        item == operation
            || (operation == "set-value" && item == "set_value")
            || (operation == "type" && item == "type_text")
            || (operation == "press" && item == "press")
    }) {
        return Err("target does not advertise the requested AX action".into());
    }
    match operation {
        "focus" => element.focus().map_err(|e| e.to_string())?,
        "set-value" => element
            .set_value(value.as_deref().ok_or("missing value")?)
            .map_err(|e| e.to_string())?,
        "type" => element
            .type_text(value.as_deref().ok_or("missing value")?)
            .map_err(|e| e.to_string())?,
        "press" => element.press().map_err(|e| e.to_string())?,
        _ => unreachable!(),
    }
    Ok(json!({ "disposition": { "delivery": "delivered_unverified", "retry": "never" } }))
}

fn resolve(root: &App, target: &AxTarget) -> Result<Element, String> {
    let (first, rest) = target.path.split_first().ok_or("empty AX target path")?;
    let mut current = root
        .children()
        .map_err(|e| e.to_string())?
        .get(*first)
        .cloned()
        .ok_or("stale AX window path")?;
    for index in rest {
        let children = current.children().map_err(|e| e.to_string())?;
        current = children.get(*index).cloned().ok_or("stale action path")?;
    }
    let d = current.data();
    if d.role.to_snake_case() != target.role
        || d.name != target.name
        || d.stable_id != target.stable_id
    {
        return Err("action target changed since observation".into());
    }
    Ok(current)
}
*/

#[tauri::command]
pub async fn ax_observe(app_name: String, max_nodes: usize) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || observe(&app_name, max_nodes))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_token_rejects_empty_app_names() {
        assert!(app("").is_err());
    }
}
