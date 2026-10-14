//! Configuration and credentials for the Expand-backed `web_search` tool.
//!
//! The JSON file contains only endpoint preferences. The API key is kept in
//! Pi's shared auth.json so it follows the same storage and permissions as
//! every other provider credential.

use serde_json::{Value, json};
use std::path::PathBuf;

use crate::bridge;

pub const DEFAULT_BASE_URL: &str = "https://api.expand.ai";
pub const DEFAULT_PROVIDER_ID: &str = "expand";
pub const DEFAULT_SEARCH_URL: &str = "https://www.bing.com/search?q=";

fn config_path() -> Result<PathBuf, String> {
    Ok(bridge::agent_dir()?.join("web-search.json"))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn valid_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && !value.chars().any(char::is_whitespace)
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn stored() -> Value {
    config_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_else(|| json!({}))
}

fn provider_id(value: &Value) -> String {
    text(value.get("providerId"))
        .filter(|value| valid_id(value))
        .unwrap_or_else(|| DEFAULT_PROVIDER_ID.into())
}

fn normalized(value: &Value) -> Value {
    let provider = provider_id(value);
    let base_url = text(value.get("baseUrl"))
        .filter(|value| valid_url(value))
        .unwrap_or_else(|| DEFAULT_BASE_URL.into());
    let search_url = text(value.get("searchUrl"))
        .filter(|value| valid_url(value))
        .unwrap_or_else(|| DEFAULT_SEARCH_URL.into());
    json!({
        "enabled": value.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "baseUrl": base_url.trim_end_matches('/'),
        "providerId": provider,
        "searchUrl": search_url,
    })
}

fn has_key(provider: &str) -> bool {
    bridge::agent_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("auth.json")).ok())
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|auth| bridge::stored_api_key(&auth, provider))
        .is_some()
}

fn response(value: Value) -> Value {
    let provider = provider_id(&value);
    let mut result = normalized(&value);
    result["hasApiKey"] = Value::Bool(has_key(&provider));
    result["defaultBaseUrl"] = Value::String(DEFAULT_BASE_URL.into());
    result["defaultProviderId"] = Value::String(DEFAULT_PROVIDER_ID.into());
    result
}

#[tauri::command]
pub async fn web_search_config() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(response(stored())))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_web_search_config(config: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let object = config
            .as_object()
            .ok_or_else(|| "Web Search 配置必须是对象".to_string())?;
        if let Some(value) = object.get("enabled") {
            if !value.is_boolean() {
                return Err("enabled 必须是布尔值".into());
            }
        }
        for key in ["baseUrl", "searchUrl"] {
            if let Some(value) = object.get(key) {
                let text = text(Some(value)).ok_or_else(|| format!("{key} 不能为空"))?;
                if !valid_url(&text) {
                    return Err(format!("{key} 必须是 http(s) URL"));
                }
            }
        }
        if let Some(value) = object.get("providerId") {
            let id = text(Some(value)).ok_or_else(|| "providerId 不能为空".to_string())?;
            if !valid_id(&id) {
                return Err("providerId 只能包含字母、数字、-、_、.".into());
            }
        }
        let previous = stored();
        let mut merged = normalized(&previous)
            .as_object()
            .cloned()
            .unwrap_or_default();
        for key in ["enabled", "baseUrl", "providerId", "searchUrl"] {
            if let Some(value) = object.get(key) {
                merged.insert(key.into(), value.clone());
            }
        }
        let value = normalized(&Value::Object(merged));
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 Pi 配置目录失败：{e}"))?;
        }
        if path.exists() {
            let _ = std::fs::copy(&path, path.with_extension("json.bak"));
        }
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("写入 Web Search 配置失败：{e}"))?;
        Ok(response(value))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_web_search_api_key(
    provider: String,
    api_key: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let provider = provider.trim().to_owned();
        if !valid_id(&provider) {
            return Err("providerId 只能包含字母、数字、-、_.".into());
        }
        bridge::store_provider_api_key(&provider, api_key.as_deref())?;
        Ok(json!({"provider": provider, "hasApiKey": has_key(&provider)}))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_enabled_and_non_sensitive() {
        let config = response(json!({}));
        assert_eq!(config["enabled"], true);
        assert_eq!(config["providerId"], DEFAULT_PROVIDER_ID);
        assert_eq!(config["baseUrl"], DEFAULT_BASE_URL);
        assert!(config.get("apiKey").is_none());
    }

    #[test]
    fn invalid_values_fall_back_when_reading() {
        let config = normalized(&json!({"baseUrl":"file:///tmp/key", "providerId":"bad id"}));
        assert_eq!(config["baseUrl"], DEFAULT_BASE_URL);
        assert_eq!(config["providerId"], DEFAULT_PROVIDER_ID);
    }
}
