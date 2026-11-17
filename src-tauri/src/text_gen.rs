//! A cheap text model for titles, commit messages, pull requests and voice cleanup.
//!
//! This is not a coding session. One chat-completions call, no tools, no Pi
//! process. When it is off, callers fall back to the existing Pi one-shot.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone)]
struct TextGen {
    enabled: bool,
    base_url: String,
    model: String,
    api_key: String,
    api_key_ref: String,
}

fn config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "找不到用户目录".to_string())?;
    Ok(PathBuf::from(home).join(".pi").join("agent").join("text.json"))
}

fn read_config() -> TextGen {
    let Ok(path) = config_path() else {
        return TextGen { enabled: false, base_url: String::new(), model: String::new(), api_key: String::new(), api_key_ref: String::new() };
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return TextGen { enabled: false, base_url: String::new(), model: String::new(), api_key: String::new(), api_key_ref: String::new() };
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return TextGen { enabled: false, base_url: String::new(), model: String::new(), api_key: String::new(), api_key_ref: String::new() };
    };
    TextGen {
        enabled: value.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        base_url: value.get("baseUrl").and_then(Value::as_str).unwrap_or("").trim().trim_end_matches('/').to_string(),
        model: value.get("model").and_then(Value::as_str).unwrap_or("").trim().to_string(),
        api_key: value.get("apiKey").and_then(Value::as_str).unwrap_or("").to_string(),
        api_key_ref: value.get("apiKeyRef").and_then(Value::as_str).unwrap_or("").to_string(),
    }
}

fn public_config(config: &TextGen) -> Value {
    json!({
        "enabled": config.enabled,
        "baseUrl": config.base_url,
        "model": config.model,
        "hasApiKey": !config.api_key.is_empty(),
        "secretRef": if config.api_key_ref.is_empty() { Value::Null } else { json!(config.api_key_ref) },
    })
}

#[tauri::command]
pub fn text_gen_config() -> Value {
    public_config(&read_config())
}

#[tauri::command]
pub fn save_text_gen(enabled: bool, base_url: String, model: String, api_key: Option<String>) -> Result<Value, String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let previous = read_config();
    let (key, key_ref) = match api_key.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        Some(value) if crate::secrets::is_op_reference(&value) => (crate::secrets::read_op(&value)?, value),
        Some(value) => (value, String::new()),
        None => (previous.api_key, previous.api_key_ref),
    };
    let next = TextGen {
        enabled,
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        model: model.trim().to_string(),
        api_key: key,
        api_key_ref: key_ref,
    };
    if next.enabled && (next.base_url.is_empty() || next.model.is_empty()) {
        return Err("启用文本模型时需要 Base URL 和模型名".into());
    }
    if !next.base_url.is_empty() && !(next.base_url.starts_with("http://") || next.base_url.starts_with("https://")) {
        return Err("Base URL 需要以 http:// 或 https:// 开头".into());
    }
    let body = json!({
        "enabled": next.enabled,
        "baseUrl": next.base_url,
        "model": next.model,
        "apiKey": next.api_key,
        "apiKeyRef": next.api_key_ref,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&body).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(public_config(&next))
}

/// `Err("unconfigured")` means the caller should use Pi. Any other error is a failed call.
pub async fn generate(prompt: String) -> Result<String, String> {
    let config = read_config();
    if !config.enabled || config.base_url.is_empty() || config.model.is_empty() {
        return Err("unconfigured".into());
    }
    let url = format!("{}/chat/completions", config.base_url);
    let body = json!({
        "model": config.model,
        "temperature": 0.2,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.post(url).json(&body);
    if !config.api_key.is_empty() {
        request = request.bearer_auth(&config.api_key);
    }
    let response = request.send().await.map_err(|error| format!("文本模型没有连上：{error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let detail = text.chars().take(240).collect::<String>();
        return Err(format!("文本模型返回 {status}：{detail}"));
    }
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    let text = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "文本模型没有返回文字".to_string())?;
    Ok(text.to_string())
}

#[tauri::command]
pub async fn text_generate(prompt: String) -> Result<String, String> {
    generate(prompt).await
}
