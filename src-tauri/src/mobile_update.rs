#[cfg(target_os = "android")]
mod android {
    use serde::Serialize;
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        AppHandle, Manager, Runtime, Wry,
    };

    const PLUGIN_IDENTIFIER: &str = "ai.pi.gui";

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InstallRequest {
        url: String,
        version: String,
    }

    pub struct MobileUpdate(PluginHandle<Wry>);

    pub fn init() -> TauriPlugin<Wry> {
        Builder::new("mobile-update")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin(PLUGIN_IDENTIFIER, "MobileUpdatePlugin")?;
                app.manage(MobileUpdate(handle));
                Ok(())
            })
            .build()
    }

    pub async fn install(app: AppHandle, url: String, version: String) -> Result<(), String> {
        let expected = format!(
            "https://github.com/ErKeLost/Orbit/releases/download/v{version}/orbit-android-arm64-v{version}.apk"
        );
        if url != expected
            || !version
                .chars()
                .all(|character| character.is_ascii_digit() || character == '.')
        {
            return Err("Android 更新地址无效".into());
        }
        let handle = app.state::<MobileUpdate>().0.clone();
        handle
            .run_mobile_plugin_async::<()>("install", InstallRequest { url, version })
            .await
            .map_err(|error| error.to_string())
    }

    /// Probe the latest version via the releases/latest redirect (no API rate
    /// limit) when the anonymous api.github.com quota is exhausted.
    pub async fn probe() -> Result<Option<String>, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get("https://github.com/ErKeLost/Orbit/releases/latest")
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let Some(location) = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
        else {
            return Ok(None);
        };
        let version = location
            .rsplit('/')
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches('v');
        let plausible = version.contains('.')
            && version.split('.').all(|part| {
                !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
            });
        Ok(plausible.then(|| version.to_string()))
    }
}

#[cfg(target_os = "android")]
pub use android::init;

#[tauri::command]
pub async fn mobile_update_probe() -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        android::probe().await
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("更新探测只能在 Android 设备上使用".into())
    }
}

#[tauri::command]
pub async fn mobile_update_install(
    app: tauri::AppHandle,
    url: String,
    version: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android::install(app, url, version).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, url, version);
        Err("Android 更新只能在 Android 设备上安装".into())
    }
}
