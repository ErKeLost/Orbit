Based on tauri-apps/plugins-workspace 835adce473e8f059f6ba84660dd07bcb19fb9030 (Apache-2.0 OR MIT).

CEF dispatches IPC handlers off the main thread while Tauri holds PluginStore.
Synchronous shortcut mutation waits for run_on_main_thread, while the event loop
waits for PluginStore, causing a startup deadlock. Run the three mutating IPC
commands on Tauri's blocking pool, after the plugin invoke handler returns.
