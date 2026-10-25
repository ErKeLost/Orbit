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
pub mod browser;
pub mod browser_view;
mod cookie_import;
// Pi bridge split by domain: `bridge` keeps the shared worker registry and
// runtime discovery; each command lives with the data it reads and writes.
mod attachments;
mod bridge;
mod computer_use;
mod gui_settings;
mod mcp;
mod pi_session;
mod providers;
mod sessions;
mod sessions_cmd;
mod history;
mod git;
mod github_inbox;
mod gitlab;
mod image_config;
mod web_search;
mod speech;
mod media;
mod pty_term;
mod search;
mod artifacts;
mod notes;
mod quick_composer;
mod automations;
mod mobile_background;
mod mobile_update;
mod power;
mod remote;
mod remote_ops;
mod runtime;
mod splash;
#[cfg(windows)]
mod windows;
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

/// Hide the console window that Windows allocates for GUI-spawned children.
#[allow(dead_code)]
pub(crate) fn hide_window_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(WINDOWS_BACKGROUND_CREATION_FLAGS);
    }
    let _ = cmd;
}

#[cfg(windows)]
const WINDOWS_BACKGROUND_CREATION_FLAGS: u32 = 0x0800_0000; // CREATE_NO_WINDOW

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
    let builder = builder.plugin(mobile_update::init()).plugin(mobile_background::init());
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
        // 产物沙箱：`orbitartifact://localhost/<id>` 只服务 html 产物，
        // 响应带 CSP（sandbox allow-scripts），页面在 opaque origin 里跑。
        .register_uri_scheme_protocol(artifacts::HTML_SCHEME, |ctx, request| {
            artifacts::serve_html(ctx.app_handle(), &request)
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
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
            // The column's view is this process's; the agent's loop is another.
            // This is the socket between them (`browser_view::serve`).
            browser_view::serve(app.handle().clone());
            splash::mark(app.handle(), &app.state::<splash::SplashState>(), "backend");
            // 历史图片抽出来的文件是个缓存；超预算时在后台按修改时间清掉最旧的，
            // 不挡启动（缺的图下次装载时会重新抽）。
            if let Some(dir) = media::session_media_dir(app.handle()) {
                std::thread::spawn(move || media::prune_session_media(&dir));
            }
            Ok(())
        })
        .manage(splash::SplashState::default())
        .manage(bridge::Bridge::default())
        .manage(remote::RemoteHost::default())
        .manage(power::KeepAwake::new())
        .manage(pty_term::PtyHost::new())
        .manage(screen::ScreenHost::default())
        .manage(browser::BrowserHost::default())
        .manage(browser_view::BrowserViewHost::default())
        .invoke_handler(tauri::generate_handler![
            #[cfg(target_os = "macos")]
            ax::ax_observe,
            runtime::runtime_environment,
            power::set_keep_awake,
            splash::splash_ready,
            providers::discover,
            providers::list_provider_models,
            providers::list_provider_profiles,
            providers::probe_provider_models,
            providers::save_provider,
            providers::delete_provider,
            providers::sync_provider_models,
            providers::set_default_model,
            gui_settings::get_project_trust_mode,
            gui_settings::set_project_trust_mode,
            mcp::list_mcp_servers,
            mcp::save_mcp_server,
            mcp::delete_mcp_server,
            mcp::set_mcp_auto_codemode,
            mcp::mcp_config_location,
            gui_settings::get_gui_settings,
            gui_settings::set_gui_setting,
            gui_settings::get_request_budget,
            gui_settings::save_request_budget,
            computer_use::computer_use_key_status,
            // Browser Use (`docs/BROWSER_USE.md`): the third column's Chrome.
            // Screencast frames and input forwarding are CDP work and live in
            // the webview; these commands own the process and the session file.
            browser::browser_open,
            browser::browser_status,
            browser::browser_close,
            browser::browser_client_report,
            browser::browser_import_sources,
            browser::browser_import_session,
            browser::browser_import_state,
            // The column's engine view: a real child web view, not a frame
            // stream. See `browser_view.rs`.
            browser_view::browser_view_sync,
            browser_view::browser_view_activate,
            browser_view::browser_view_navigate,
            browser_view::browser_view_go,
            browser_view::browser_view_reload,
            browser_view::browser_view_stop,
            browser_view::browser_view_eval,
            browser_view::browser_view_status,
            browser_view::browser_view_page,
            browser_view::browser_view_close,
            browser_view::browser_view_reconcile,
            computer_use::save_computer_use_key,
            computer_use::computer_use_config,
            computer_use::save_computer_use_config,
            computer_use::save_computer_use_cloudflare_token,
            computer_use::test_computer_use_decision,
            attachments::clipboard_file_paths,
            attachments::read_file_attachment,
            attachments::save_media_file,
            media::copy_media_file,
            pi_session::pi_oneshot,
            pi_session::pi_connect,
            pi_session::pi_send,
            pi_session::pi_disconnect,
            sessions_cmd::list_sessions,
            sessions_cmd::list_project_files,
            sessions_cmd::delete_session,
            sessions_cmd::rename_session,
            sessions_cmd::clear_sessions,
            sessions_cmd::session_turn_durations,
            sessions_cmd::session_stamp,
            sessions_cmd::session_project,
            sessions_cmd::session_image,
            pi_session::open_pi_terminal,
            git::git_diff_stats,
            git::git_changed_files,
            git::git_diff_index,
            git::git_diff_files,
            git::git_file_diff,
            git::git_history,
            git::git_commit_files,
            git::git_commit_file_diff,
            git::git_stage_file,
            git::git_stage_contents,
            git::git_unstage_file,
            git::git_discard_file,
            git::git_discard_all,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_head_message,
            git::git_push,
            git::git_pull,
            git::git_sync,
            git::git_staged_context,
            git::git_range_context,
            git::git_pr_status,
            git::git_pr_create,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git::list_dir,
            git::read_text_file,
            git::file_meta,
            git::write_text_file,
            git::create_dir,
            git::rename_path,
            git::delete_path,
            github_inbox::git_github_status,
            github_inbox::git_github_repo,
            github_inbox::git_github_repositories,
            github_inbox::git_github_work_items,
            github_inbox::git_github_work_item,
            github_inbox::git_github_work_item_details,
            github_inbox::git_github_work_item_thread,
            github_inbox::git_github_work_item_comment,
            github_inbox::git_github_pr_action,
            github_inbox::git_github_pr_diff,
            github_inbox::git_github_pr_checks,
            github_inbox::git_github_check_details,
            gitlab::gitlab_status,
            gitlab::gitlab_set_config,
            gitlab::gitlab_repo,
            gitlab::gitlab_list_work_items,
            gitlab::gitlab_list_todos,
            gitlab::gitlab_work_item_details,
            gitlab::gitlab_work_item_thread,
            gitlab::gitlab_work_item_comment,
            gitlab::gitlab_mr_diff,
            image_config::image_config,
            image_config::save_image_config,
            image_config::save_image_api_key,
            web_search::web_search_config,
            web_search::save_web_search_config,
            web_search::save_web_search_api_key,
            speech::speech_config,
            speech::save_speech_config,
            speech::save_speech_api_key,
            speech::transcribe_audio,
            media::media_meta,
            media::read_media_file,
            pty_term::pty_spawn,
            pty_term::pty_write,
            pty_term::pty_resize,
            pty_term::pty_status,
            pty_term::pty_kill,
            pty_term::pty_kill_all,
            search::search_files,
            search::search_sessions,
            quick_composer::quick_toggle,
            quick_composer::quick_hide,
            quick_composer::quick_send,
            quick_composer::quick_scope,
            artifacts::artifacts_list,
            artifacts::artifacts_get,
            artifacts::artifacts_upsert,
            artifacts::artifacts_delete,
            notes::notes_list,
            notes::notes_get,
            notes::notes_upsert,
            notes::notes_delete,
            notes::notes_save_image,
            notes::notes_save_image_data,
            notes::notes_image_path,
            automations::automations_list,
            automations::automations_upsert,
            automations::automations_delete,
            automations::automation_runs_list,
            automations::automation_runs_recover,
            automations::automation_run_now,
            automations::automations_claim_due,
            automations::automation_run_update,
            mobile_background::background_connection_status,
            mobile_background::set_background_connection,
            mobile_update::mobile_update_install,
            mobile_update::mobile_update_probe,
            remote::remote_host_start,
            remote::publish_projects,
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
            if hid_the_window_instead_of_closing(window, event) {
                return;
            }
            if let tauri::WindowEvent::Destroyed = event {
                // Only the main window's destruction is teardown. The splash
                // window closes as part of a *normal* startup — a second or
                // two after bootstrap has restored the Host — and stopping the
                // Host there would kill the mobile access this launch had just
                // brought back, which looks on the phone like the Mac going
                // away. The bridge and PTYs belong to the main window's
                // lifetime in the same way.
                if window.label() != "main" {
                    return;
                }
                window.state::<pty_term::PtyHost>().kill_all();
                window.state::<bridge::Bridge>().stop();
                window.state::<remote::RemoteHost>().stop();
                // The owned Chrome is Orbit's, not the user's: it goes away with
                // the window that hosts the column showing it. The child web view
                // is part of the window and dies with it.
                let _ = browser::close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Orbit")
        .run(|app, event| {
            let exit = matches!(event, tauri::RunEvent::Exit);
            #[cfg(target_os = "macos")]
            reopen_main_window(app, event);
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
            if exit {
                let _ = browser::close();
            }
        });
}

/// Closing the main window hides it instead of quitting — as long as the Host
/// is running.
///
/// The mobile Host lives in this process, so a closed window takes every
/// attached phone with it, and from the phone "the Mac stopped answering" is
/// indistinguishable from the Mac being off. Hiding keeps the Host serving and
/// the window comes back from the Dock, the show/hide hotkey, or a second
/// launch; `⌘Q` still quits. With mobile access off, closing the window means
/// what it has always meant.
///
/// macOS only, deliberately: the Dock icon and `⌘Q` are always there to bring
/// the window back or quit, while a Windows/Linux window that hides itself has
/// no tray and no menu behind it — it would leave a process the user cannot
/// find, let alone quit.
///
/// Returns whether the close request was consumed.
#[cfg(target_os = "macos")]
fn hid_the_window_instead_of_closing(window: &tauri::Window, event: &tauri::WindowEvent) -> bool {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return false;
    };
    if window.label() != "main" {
        return false;
    }
    if !window.state::<remote::RemoteHost>().is_running() {
        return false;
    }
    api.prevent_close();
    let _ = window.hide();
    true
}

#[cfg(not(target_os = "macos"))]
fn hid_the_window_instead_of_closing(_window: &tauri::Window, _event: &tauri::WindowEvent) -> bool {
    false
}

/// Clicking the Dock icon while no window is visible asks the app to reopen,
/// not to launch. That is the way back from close-to-hide, whose whole point is
/// that the process — and the mobile Host inside it — outlives the window.
#[cfg(target_os = "macos")]
fn reopen_main_window(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::Reopen { .. } = event {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
