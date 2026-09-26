//! Session-local JSONL AX worker. Never listens on a socket.
//! macOS only in this release: the worker binary is bundled exclusively with
//! macOS packages and other platforms resolve no worker client-side.
#[cfg(target_os = "macos")]
fn is_permission_denied(message: &str) -> bool {
    message.starts_with("AX_PERMISSION_DENIED") || message.contains("Permission denied")
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
                "snapshot" => {
                    ledger.clear();
                    let snapshot = app_lib::ax::observe(app, 2000)?;
                    if snapshot["tree"]["window_count"].as_u64() == Some(0) {
                        return Err("target application has no observable AX window".into());
                    }
                    ledger.register(&snapshot).map_err(str::to_owned)?;
                    snapshot
                }
                "launch" => {
                    ledger.clear();
                    // Already running: activation is the only launch work.
                    // Otherwise open the bundle and poll the cheap NSWorkspace
                    // lookup plus a shallow AX window probe.
                    if app_lib::fast_ax::find_pid(app).is_none() {
                        let bundle = std::process::Command::new("/usr/bin/mdfind")
                            .args([&format!("kMDItemDisplayName == '{}'cd && kMDItemContentType == 'com.apple.application-bundle'", app)])
                            .output().ok()
                            .and_then(|output| String::from_utf8(output.stdout).ok())
                            .and_then(|paths| paths.lines().map(str::trim).find(|path| path.ends_with(".app")).map(str::to_owned));
                        let mut open = std::process::Command::new("/usr/bin/open");
                        if let Some(bundle) = bundle { open.arg(bundle); } else { open.args(["-a", app]); }
                        let _ = open.status();
                    }
                    // Activation must happen before the AXWindows probe. A
                    // running Electron app may have no visible AX window
                    // until NSRunningApplication is brought to the front.
                    let mut snapshot = None;
                    for _ in 0..50 {
                        if let Some(pid) = app_lib::fast_ax::find_pid(app) {
                            let _ = app_lib::fast_ax::activate_pid(pid);
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
                    let data = if operation == "press" && request["ref"].as_str() == Some("return")
                    {
                        ledger
                            .consume_focused(app, pid, operation)
                            .map_err(str::to_owned)?;
                        app_lib::ax::dispatch_focused(app, operation)?
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
                    serde_json::json!({"disposition":{"delivery":delivery,"retry":"never"},"post_state":data})
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
