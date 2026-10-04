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
#[cfg(target_os = "macos")]
pub mod disclaim;
/// Screen channel (`docs/SCREEN.md`). The bus, protocol, encoder, and
/// subscription logic are platform independent; only the capture backend and
/// input injection have per-platform implementations, and non-macOS targets
/// report that they are unavailable instead of failing to build.
mod screen;
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
#[cfg(unix)]
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
#[cfg(unix)]
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

#[cfg(unix)]
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
    #[cfg(unix)]
    {
        // Finder/Dock launch inherits launchd's minimal PATH and stores dirs in
        // a login shell, so both fixes are POSIX-only: Windows keeps its own
        // PATH semantics (';' separators, no login shell) and is left alone.
        normalize_path();
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
    // Desktop integration. single-instance must be registered before every other
    // plugin: a second launch focuses the running window instead of starting a
    // second bundled Pi runtime and accessibility grant.
    // Skipped in debug builds so a dev instance can run next to the installed
    // app, which shares its identifier.
    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // The screen channel pushes status changes to the UI instead of
            // being polled, and the pipeline thread — not the webview — is what
            // knows them.
            #[cfg(target_os = "macos")]
            app.state::<screen::ScreenHost>().attach(app.handle().clone());
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
        .manage(screen::ScreenHost::default())
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
            bridge::list_mcp_servers,
            bridge::save_mcp_server,
            bridge::delete_mcp_server,
            bridge::mcp_config_location,
            bridge::get_gui_settings,
            bridge::set_gui_setting,
            bridge::computer_use_key_status,
            bridge::save_computer_use_key,
            bridge::computer_use_config,
            bridge::save_computer_use_config,
            bridge::save_computer_use_cloudflare_token,
            bridge::image_config,
            bridge::save_image_config,
            bridge::test_computer_use_decision,
            bridge::clipboard_file_paths,
            bridge::read_file_attachment,
            bridge::save_media_file,
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
            remote::remote_host_set_theme,
            screen::screen_status,
            screen::screen_displays,
            screen::screen_request_permission,
            screen::screen_stop
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
