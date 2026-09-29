// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must run before any app setup: this invocation only execs the Pi runtime.
    #[cfg(target_os = "macos")]
    app_lib::disclaim::exec_if_requested();
    app_lib::run();
}
