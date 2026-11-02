// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// CEF owns the process entry point on the platforms that use it. Linux keeps the
// platform WebKit runtime (see `lib::run`), so it must not get CEF's entry point.
#[cfg_attr(all(desktop, not(target_os = "linux")), tauri_runtime_cef::cef_entry_point)]
fn main() {
    // Must run before any app setup: this invocation only execs the Pi runtime.
    #[cfg(target_os = "macos")]
    app_lib::disclaim::exec_if_requested();
    app_lib::run();
}
