//! Standalone JSONL accessibility worker for development and diagnostics.
//! Production gui_task requests run the same protocol inside the Orbit host.

#[cfg(target_os = "macos")]
fn main() {
    use std::io;
    app_lib::ax_worker::serve(io::stdin().lock(), io::stdout().lock());
}

#[cfg(not(target_os = "macos"))]
fn main() {}
