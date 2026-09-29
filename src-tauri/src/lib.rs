// The native AX engine (observation ledger, worker protocol, now-playing)
// ships for macOS in this release; other desktop platforms reject gui_task at
// the client layer instead of compiling platform-specific code.
#[cfg(target_os = "macos")]
pub mod ax;
#[cfg(target_os = "macos")]
pub mod now_playing;
#[cfg(target_os = "macos")]
pub mod fast_ax;
#[cfg(target_os = "macos")]
pub mod ax_settle;
#[cfg(target_os = "macos")]
pub mod ax_worker;
mod bridge;
mod mobile_update;
mod remote;
mod runtime;
mod splash;
use tauri::Manager;

/// Finder/Dock-launched apps inherit launchd's minimal PATH, so every shell
/// Pi spawns would miss Homebrew tools like rg and ffmpeg. Normalize once at
/// startup; all child processes inherit the corrected environment. Existing
/// entries keep their order, so user overrides always win.
#[cfg(desktop)]
fn normalize_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut entries: Vec<&str> = current.split(':').collect();
    for dir in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
        if !entries.contains(&dir) {
            entries.push(dir);
        }
    }
    std::env::set_var("PATH", entries.join(":"));
}

/// Run the user's login shell once and capture the PATH it produces, so
/// entries from ~/.zshrc & co (nvm, bun, cargo, npm globals…) reach agent
/// spawns. User dirs come first; the app-inherited PATH fills the gaps.
#[cfg(desktop)]
fn probe_login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let shell = std::env::var("SHELL").ok()?;
    if shell.ends_with("/fish") {
        return None;
    }
    const MARKER: &str = "__PIGUI_PATH__";
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &format!("printf '{MARKER}%s' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        if child
            .try_wait()
            .map(|status| status.is_some())
            .unwrap_or(false)
        {
            break;
        }
        if start.elapsed() > Duration::from_secs(4) {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let mut stdout = Vec::new();
    child.stdout.take()?.read_to_end(&mut stdout).ok()?;
    let text = String::from_utf8_lossy(&stdout);
    let line = text.lines().find(|line| line.starts_with(MARKER))?;
    let path = &line[MARKER.len()..];
    (!path.is_empty()).then(|| path.to_string())
}

#[cfg(desktop)]
fn adopt_login_shell_path() {
    let Some(login) = probe_login_shell_path() else {
        return;
    };
    let current = std::env::var("PATH").unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let merged: Vec<&str> = login
        .split(':')
        .chain(current.split(':'))
        .filter(|dir| !dir.is_empty() && seen.insert(dir.to_string()))
        .collect();
    std::env::set_var("PATH", merged.join(":"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The dependency tree enables both rustls crypto backends (ring via
    // tungstenite, aws-lc-rs via reqwest). Without an explicit default,
    // rustls panics on first use — silently killing the relay thread.
    let _ = rustls::crypto::ring::default_provider().install_default();
    #[cfg(desktop)]
    {
        normalize_path();
        // Resolve the user's tool PATH before any Pi process can start. Node
        // itself is bundled, but tools invoked by Pi still need the login PATH.
        adopt_login_shell_path();
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(mobile_update::init());
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = builder.on_web_content_process_terminate(|webview| {
        let _ = webview.reload();
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                // Transparent, undecorated splash that floats the mascot on the desktop.
                tauri::WebviewWindowBuilder::new(app, "splashscreen", tauri::WebviewUrl::App("splashscreen.html".into()))
                    .title("Orbit")
                    .inner_size(340.0, 340.0)
                    .center()
                    .resizable(false)
                    .decorations(false)
                    .transparent(true)
                    .shadow(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focused(true)
                    .build()?;
                splash::arm_failsafe(app.handle());
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            #[cfg(mobile)]
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
            }
            splash::mark(app.handle(), &app.state::<splash::SplashState>(), "backend");
            Ok(())
        })
        .manage(splash::SplashState::default())
        .manage(bridge::Bridge::default())
        .manage(remote::RemoteHost::default())
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "macos")]
            ax::ax_observe,
            runtime::runtime_environment,
            splash::splash_ready,
            bridge::discover,
            bridge::list_provider_models,
            bridge::list_provider_profiles,
            bridge::probe_provider_models,
            bridge::save_provider,
            bridge::delete_provider,
            bridge::sync_provider_models,
            bridge::set_default_model,
            bridge::get_project_trust_mode,
            bridge::set_project_trust_mode,
            bridge::computer_use_key_status,
            bridge::save_computer_use_key,
            bridge::clipboard_file_paths,
            bridge::read_file_attachment,
            bridge::pi_connect,
            bridge::pi_send,
            bridge::pi_disconnect,
            bridge::list_sessions,
            bridge::list_project_files,
            bridge::delete_session,
            bridge::clear_sessions,
            bridge::session_turn_durations,
            bridge::open_pi_terminal,
            mobile_update::mobile_update_install,
            mobile_update::mobile_update_probe,
            remote::remote_host_start,
            remote::relay_settings_status,
            remote::save_relay_settings,
            remote::remote_host_status,
            remote::remote_host_stop,
            remote::remote_host_set_theme
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<bridge::Bridge>().stop();
                window.state::<remote::RemoteHost>().stop();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Orbit");
}
