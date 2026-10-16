// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must run before any app setup: this invocation only execs the Pi runtime.
    #[cfg(target_os = "macos")]
    app_lib::disclaim::exec_if_requested();
    // Same idea for the browser helper: `Orbit --browser-ensure [--url <url>]`
    // lets the Pi extension start the same Chrome the dock shows, without a
    // second copy of the launch flags anywhere. Exits before Tauri boots.
    if let Some(code) = app_lib::browser::exec_if_requested() {
        std::process::exit(code);
    }
    app_lib::run();
}
