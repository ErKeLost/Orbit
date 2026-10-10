//! Keeping the pairing connection alive across a backgrounded app.
//!
//! The phone's socket to the desktop is a `WebSocket` inside the WebView, and a
//! backgrounded app loses it twice over: the activity pauses the WebView and its
//! JavaScript timers, and Doze closes what is left. Android has exactly one
//! mechanism that keeps a process out of both — a foreground service — and it
//! requires a notification the user cannot dismiss, which is why this is a
//! setting rather than the default.
//!
//! The Kotlin half is `ConnectionService.kt` and `ConnectionPlugin.kt`. This half
//! is the command surface: it reports what the service is actually doing rather
//! than what was asked of it, because an Android start can be refused (a missing
//! prerequisite permission, a start from the background) and a toggle that reads
//! "on" while nothing holds the connection is worse than one that reads "failed".

use serde_json::Value;

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        AppHandle, Manager, Wry,
    };

    const PLUGIN_IDENTIFIER: &str = "ai.pi.gui";

    pub struct Connection(PluginHandle<Wry>);

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("mobile-background")
            .setup(|app, api| {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ConnectionPlugin")?;
                app.manage(Connection(handle));
                Ok(())
            })
            .build()
    }

    pub async fn status(app: AppHandle) -> Result<Value, String> {
        let handle = app.state::<Connection>().0.clone();
        let value = handle
            .run_mobile_plugin_async::<Value>("status", ())
            .await
            .map_err(|error| error.to_string())?;
        Ok(supported(value))
    }

    pub async fn set(app: AppHandle, enabled: bool) -> Result<Value, String> {
        let handle = app.state::<Connection>().0.clone();
        let command = if enabled { "start" } else { "stop" };
        // No arguments: the Kotlin side reads the command name, and the two
        // commands it can be are the whole payload.
        let value = handle
            .run_mobile_plugin_async::<Value>(command, ())
            .await
            .map_err(|error| error.to_string())?;
        Ok(supported(value))
    }
}

/// Registered only where the service exists; `lib.rs` adds the plugin under the
/// same `cfg`, which is why this is a re-export rather than a stub.
#[cfg(target_os = "android")]
pub use android::init;

/// The Kotlin side knows whether the service runs and why it does not; only this
/// side knows whether the platform has one at all, so the field is added here and
/// the shape is the same on every platform.
#[cfg(target_os = "android")]
fn supported(mut value: Value) -> Value {
    value["supported"] = Value::Bool(true);
    value
}

/// Whether the connection service is running, and why not if it is not.
///
/// Only Android has one. The desktop *is* the machine being connected to, and
/// every other platform keeps the process on its own terms.
#[tauri::command]
pub async fn background_connection_status(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        android::status(app).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({"running": false, "supported": false, "error": null}))
    }
}

#[tauri::command]
pub async fn set_background_connection(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        android::set(app, enabled).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
        Err("后台保持连接只在 Android 上存在".into())
    }
}
