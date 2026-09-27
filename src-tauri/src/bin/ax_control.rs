//! Session-local JSONL AX worker. Never listens on a socket.
//! macOS only in this release: the worker binary is bundled exclusively with
//! macOS packages and other platforms resolve no worker client-side.
#[cfg(target_os = "macos")]
fn is_permission_denied(message: &str) -> bool {
    message.starts_with("AX_PERMISSION_DENIED") || message.contains("Permission denied")
}

/// One snapshot with a Chromium/CEF renderer-activation retry: freshly
/// launched or background processes expose an empty/shallow AX tree until an
/// assistive client requests full accessibility, so an empty result first
/// attempts the attribute-driven activation and retries once after its
/// measured debounce before reporting failure.
#[cfg(target_os = "macos")]
fn snapshot_with_renderer_activation(app: &str) -> Result<serde_json::Value, String> {
    let empty = serde_json::json!({ "tree": { "window_count": 0 } });
    let mut snapshot = match app_lib::ax::observe(app, 2000) {
        Ok(value) => value,
        Err(message) if message == "target application has no observable AX window" => empty,
        Err(message) => return Err(message),
    };
    if snapshot["tree"]["window_count"].as_u64() == Some(0) {
        if let Some(pid) = app_lib::fast_ax::find_pid(app) {
            if app_lib::fast_ax::activate_renderer_accessibility(pid) {
                // Poll through Chromium's activation debounce instead of a
                // fixed sleep: continue as soon as a window is observable.
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2_600);
                while std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    snapshot = app_lib::ax::observe(app, 2000)?;
                    if snapshot["tree"]["window_count"].as_u64() != Some(0) {
                        break;
                    }
                }
            }
        }
    }
    if snapshot["tree"]["window_count"].as_u64() == Some(0) {
        return Err("target application has no observable AX window".into());
    }
    Ok(snapshot)
}

#[cfg(target_os = "macos")]
fn main() {
    use std::io::{self, BufRead, Write};
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut ledger = computer_use_core::ObservationLedger::default();
    for line in stdin.lock().lines() {
        let raw_line = match line {
            Ok(value) => value,
            Err(error) => {
                eprintln!("{error}");
                break;
            }
        };
        let response = (|| {
            let request: serde_json::Value =
                serde_json::from_str(&raw_line).map_err(|e| e.to_string())?;
            let command = request["command"].as_str().ok_or("missing command")?;
            let app = request["app"].as_str().ok_or("missing app")?;
            let data = match command {
                "activate-app" => app_lib::ax::activate_application(app)?,
                "now-playing" => app_lib::now_playing::now_playing(),
                "menubar" => {
                    let pid = app_lib::fast_ax::find_pid(app).ok_or("target application has no observable AX window")?;
                    app_lib::fast_ax::read_menu_bar(pid)?
                }
                "snapshot" => {
                    ledger.clear();
                    let snapshot = snapshot_with_renderer_activation(app)?;
                    ledger.register(&snapshot).map_err(str::to_owned)?;
                    snapshot
                }
                "launch" => {
                    ledger.clear();
                    // Resolve the bundle once so both the initial open and the
                    // reopen retries below use the same launch target.
                    let bundle = std::process::Command::new("/usr/bin/mdfind")
                        .args([&format!("kMDItemDisplayName == '{}'cd && kMDItemContentType == 'com.apple.application-bundle'", app)])
                        .output().ok()
                        .and_then(|output| String::from_utf8(output.stdout).ok())
                        .and_then(|paths| paths.lines().map(str::trim).find(|path| path.ends_with(".app")).map(str::to_owned));
                    let open_bundle = || {
                        let mut open = std::process::Command::new("/usr/bin/open");
                        if let Some(bundle) = &bundle { open.arg(bundle); } else { open.args(["-a", app]); }
                        let _ = open.status();
                    };
                    // Already running: activation is the only launch work.
                    // Otherwise open the bundle and poll the cheap NSWorkspace
                    // lookup plus a shallow AX window probe.
                    if app_lib::fast_ax::find_pid(app).is_none() {
                        open_bundle();
                    }
                    // Activation must happen before the AXWindows probe. A
                    // running Electron app may have no visible AX window
                    // until NSRunningApplication is brought to the front.
                    let mut snapshot = None;
                    // Chromium/CEF/Electron apps keep their renderer AX in a
                    // limited mode until an assistive client requests full
                    // accessibility; ask once per launch (attribute-driven,
                    // no app-name rule) and keep polling through the
                    // renderer's activation debounce.
                    let mut nudged = false;
                    // Electron apps such as SodaMusic can create the helper
                    // processes first and expose the main AX window several
                    // seconds later. Keep activating and polling long enough
                    // for the real window to appear before returning
                    // WINDOW_NOT_FOUND.
                    // A process can also be alive with no window at all
                    // (closed to a tray, or the window torn down after an
                    // earlier session). `open` on a running bundle delivers
                    // the standard macOS reopen event, which AppKit/Electron
                    // apps answer by rebuilding their main window; retry it a
                    // few times, spaced out, before giving up.
                    let mut reopens = 0;
                    for iteration in 0..300 {
                        if let Some(pid) = app_lib::fast_ax::find_pid(app) {
                            let _ = app_lib::fast_ax::activate_pid(pid);
                            if !nudged {
                                nudged = app_lib::fast_ax::activate_renderer_accessibility(pid);
                            }
                            if reopens < 3 && iteration >= 40 && (iteration - 40) % 80 == 0 {
                                open_bundle();
                                reopens += 1;
                            }
                        }
                        match app_lib::ax::observe(app, 2) {
                            Ok(candidate) => {
                                if candidate["tree"]["window_count"].as_u64() != Some(0) {
                                    snapshot = Some(candidate);
                                    break;
                                }
                            }
                            Err(message) => {
                                // Missing Accessibility trust never resolves by
                                // polling; fail immediately with the distinct code.
                                if is_permission_denied(&message) {
                                    return Err(message);
                                }
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    let snapshot = snapshot.ok_or("target application has no observable AX window")?;
                    serde_json::json!({ "app": app, "pid": snapshot["tree"]["pid"], "window": snapshot["window"], "snapshot_id": snapshot["snapshot_id"] })
                }
                "action" => {
                    let operation = request["operation"].as_str().ok_or("missing operation")?;
                    let value = request["value"].as_str();
                    let headed = request["headed"].as_bool().unwrap_or(false);
                    let pid = ledger.process_id().ok_or("no active process identity")?;
                    // Arm the AX observer before dispatch so no notification
                    // posted by the action itself can be missed.
                    let settle_options = app_lib::ax_settle::SettleOptions::from_request(&request["settle"]);
                    let armed = settle_options.and_then(|_| app_lib::ax_settle::Armed::arm(pid as i32));
                    let focused_key = match request["ref"].as_str() {
                        Some(key @ ("return" | "escape")) if operation == "press" => Some(key),
                        _ => None,
                    };
                    let menu_path: Option<Vec<String>> = if operation == "menu-press" {
                        Some(request["path"].as_array().ok_or("missing menu path")?.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                    } else {
                        None
                    };
                    let data = if let Some(path) = menu_path {
                        // Menu items live outside the window snapshot; the
                        // observation is still consumed so no stale ref can
                        // act after the menu command changed the app.
                        ledger.consume_focused(app, pid, "press").map_err(str::to_owned)?;
                        app_lib::fast_ax::press_menu_path(pid as i32, &path)?
                    } else if let Some(key) = focused_key {
                        ledger
                            .consume_focused(app, pid, operation)
                            .map_err(str::to_owned)?;
                        app_lib::ax::dispatch_focused(app, operation, key)?
                    } else {
                        let reference = request["ref"].as_str().ok_or("missing ref")?;
                        let target = ledger
                            .authorize(app, pid, reference, operation)
                            .map_err(str::to_owned)?
                            .clone();
                        let _ = ledger
                            .consume(app, pid, reference, operation)
                            .map_err(str::to_owned)?;
                        app_lib::ax::dispatch_observed(app, &target, operation, value, headed)?
                    };
                    // The consumed ledger authorizes nothing further; the
                    // caller's next snapshot issues the successor refs. An
                    // extra full walk here doubled per-action latency.
                    let delivery = if operation == "set-value"
                        && value.is_some()
                        && data["value"].as_str() == value
                    {
                        "delivered_verified"
                    } else {
                        "delivered_unverified"
                    };
                    let settle = match (armed, settle_options) {
                        (Some(armed), Some(options)) => armed.wait(options),
                        (None, Some(_)) => serde_json::json!({ "supported": false, "changed": false, "events": 0, "ms": 0 }),
                        _ => serde_json::Value::Null,
                    };
                    serde_json::json!({"disposition":{"delivery":delivery,"retry":"never"},"post_state":data,"settle":settle})
                }
                _ => return Err(format!("unsupported command: {command}")),
            };
            Ok::<_, String>(
                serde_json::json!({ "version": "orbit.ax.v1", "id": request["id"], "ok": true, "command": command, "data": data }),
            )
        })();
        let value = match response {
            Ok(value) => value,
            Err(message) => {
                let id = serde_json::from_str::<serde_json::Value>(&raw_line)
                    .ok()
                    .and_then(|request| request.get("id").cloned());
                let code = if message == "target application has no observable AX window" {
                    "WINDOW_NOT_FOUND"
                } else if is_permission_denied(&message) {
                    "PERM_DENIED"
                } else if message.starts_with("APP_UNRESPONSIVE") {
                    "APP_UNRESPONSIVE"
                } else if message.starts_with("FOREGROUND_REQUIRED") {
                    "FOREGROUND_REQUIRED"
                } else {
                    "AX_ERROR"
                };
                serde_json::json!({ "version": "orbit.ax.v1", "id": id, "ok": false, "error": { "code": code, "message": message, "disposition": { "delivery": "not_delivered", "retry": "never" } } })
            }
        };
        if writeln!(stdout, "{value}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {}
