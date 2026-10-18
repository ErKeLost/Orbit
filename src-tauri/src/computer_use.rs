//! Computer Use's decision backend: which model answers, where its credentials
//! live, and the one-round-trip check the settings page calls “能用么”.
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

use crate::bridge::{agent_dir, home_dir};

pub(crate) fn typesafe_key_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("typesafe-api-key"))
}

fn typesafe_api_key() -> Option<String> {
    if let Ok(key) = std::env::var("TYPESAFE_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    let mut paths = Vec::new();
    if let Ok(path) = typesafe_key_path() {
        paths.push(path);
    }
    if let Ok(home) = home_dir() {
        paths.push(home.join(".typesafe-api-key"));
        paths.push(home.join(".pi/typesafe-api-key"));
    }
    for path in paths {
        if let Ok(text) = fs::read_to_string(path) {
            let key = text.trim().to_string();
            if !key.is_empty() {
                return Some(key);
            }
        }
    }
    None
}

fn write_secret_file(path: &std::path::Path, value: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    fs::write(path, value).map_err(|e| format!("写入密钥失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
pub fn computer_use_key_status() -> Result<Value, String> {
    Ok(json!({ "hasKey": typesafe_api_key().is_some() }))
}

#[tauri::command]
pub fn save_computer_use_key(api_key: Option<String>) -> Result<Value, String> {
    let path = typesafe_key_path()?;
    match api_key.map(|value| value.trim().to_string()) {
        Some(key) if !key.is_empty() => write_secret_file(&path, &key)?,
        _ => {
            if path.exists() {
                fs::remove_file(&path).map_err(|e| format!("删除密钥失败：{e}"))?;
            }
        }
    }
    Ok(json!({ "hasKey": typesafe_api_key().is_some() }))
}

fn computer_use_config_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("computer-use.json"))
}

/// Jev's pinned model. TypeSafe takes versioned IDs even when `GET /v1/models`
/// only lists the aliases, and `jev-latest` still points at the previous stable
/// release, so the version is stored instead of the alias.
const DEFAULT_JEV_MODEL: &str = "jev-1.14.0";

pub(crate) fn cloudflare_token_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("cloudflare-api-token"))
}

/// Normalized Computer Use decision-backend config. Unknown or missing fields
/// fall back to Jev so existing installations keep working unchanged.
pub(crate) fn read_computer_use_config() -> Value {
    let mut config = json!({
        "decisionModel": "jev",
        "jevModel": DEFAULT_JEV_MODEL,
        "cloudflareAccountId": "",
        "systemoneBaseUrl": "",
    });
    if let Ok(path) = computer_use_config_path() {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(stored) = serde_json::from_str::<Value>(&text) {
                if let Some(object) = stored.as_object() {
                    for (key, value) in object {
                        config[key] = value.clone();
                    }
                }
            }
        }
    }
    config
}

pub(crate) fn computer_use_decision_model(config: &Value) -> String {
    match config.get("decisionModel").and_then(Value::as_str) {
        // The 27B `clef` variant was retired from the selector; route the old
        // value to Clef-flash so existing configs keep working.
        Some("clef") | Some("clef-flash") => "clef-flash".into(),
        _ => "jev".into(),
    }
}

/// The model actually sent to TypeSafe. Unknown or malformed values fall back
/// to the pinned default, so a hand-edited config cannot send an arbitrary
/// string as the model.
pub(crate) fn computer_use_jev_model(config: &Value) -> String {
    config
        .get("jevModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        })
        .unwrap_or(DEFAULT_JEV_MODEL)
        .to_string()
}

fn cloudflare_api_token() -> Option<String> {
    if let Ok(token) = std::env::var("CLOUDFLARE_API_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Some(token);
        }
    }
    if let Ok(path) = cloudflare_token_path() {
        if let Ok(text) = fs::read_to_string(path) {
            let token = text.trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

/// The config the settings page reads: normalized selection, non-secret
/// fields, and which credentials currently resolve. Both the read and write
/// commands return this same shape so the UI can replace its state wholesale.
fn computer_use_config_view() -> Value {
    let config = read_computer_use_config();
    json!({
        "decisionModel": computer_use_decision_model(&config),
        "jevModel": computer_use_jev_model(&config),
        "cloudflareAccountId": config.get("cloudflareAccountId").and_then(Value::as_str).unwrap_or(""),
        "systemoneBaseUrl": config.get("systemoneBaseUrl").and_then(Value::as_str).unwrap_or(""),
        "keys": {
            "jev": typesafe_api_key().is_some(),
            "cloudflare": cloudflare_api_token().is_some(),
        },
    })
}

#[tauri::command]
pub fn computer_use_config() -> Result<Value, String> {
    Ok(computer_use_config_view())
}

/// Persist the non-secret Computer Use config. Only known keys are accepted;
/// values are trimmed so a pasted Account ID cannot carry whitespace.
#[tauri::command]
pub fn save_computer_use_config(config: Value) -> Result<Value, String> {
    let mut current = read_computer_use_config();
    if let Some(object) = config.as_object() {
        for key in ["decisionModel", "jevModel", "cloudflareAccountId", "systemoneBaseUrl"] {
            if let Some(value) = object.get(key) {
                current[key] = match value {
                    Value::String(text) => Value::String(text.trim().to_string()),
                    other => other.clone(),
                };
            }
        }
    }
    let path = computer_use_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let serialized = serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?;
    fs::write(&path, serialized).map_err(|e| format!("写入电脑操作配置失败：{e}"))?;
    Ok(computer_use_config_view())
}

#[tauri::command]
pub fn save_computer_use_cloudflare_token(token: Option<String>) -> Result<Value, String> {
    let path = cloudflare_token_path()?;
    match token.map(|value| value.trim().to_string()) {
        Some(value) if !value.is_empty() => write_secret_file(&path, &value)?,
        _ => {
            if path.exists() {
                fs::remove_file(&path).map_err(|e| format!("删除密钥失败：{e}"))?;
            }
        }
    }
    Ok(json!({ "hasToken": cloudflare_api_token().is_some() }))
}

/// One real round trip against the selected backend. This is the "能用么"
/// button: it exercises the exact request shape gui_task sends (SystemOne
/// questions) and reports latency, model, answer and token usage.
#[tauri::command]
pub async fn test_computer_use_decision() -> Result<Value, String> {
    let config = read_computer_use_config();
    let model = computer_use_decision_model(&config);
    let state = json!({
        "goal": "Connectivity check for the Orbit Computer Use decision backend",
        "note": "A yes answer means the request reached the model.",
    });
    let questions = json!({
        "reachable": {
            "type": "noul",
            "instructions": "Does this connection test reach the decision model?",
        },
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    if model == "jev" {
        let key = typesafe_api_key().ok_or("未找到 Jev Key，请先在设置中保存")?;
        let base = config
            .get("systemoneBaseUrl")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("https://api.typesafe.ai")
            .trim_end_matches('/')
            .to_string();
        let response = client
            .post(format!("{base}/v1/systemone"))
            .bearer_auth(key)
            .json(&json!({ "model": computer_use_jev_model(&config), "state": state, "questions": questions }))
            .send()
            .await
            .map_err(|e| format!("Jev 请求失败：{e}"))?;
        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|e| format!("Jev 响应不是有效 JSON：{e}"))?;
        if !status.is_success() {
            let message = body
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("请求被拒绝");
            return Err(format!("Jev 返回 {status}：{message}"));
        }
        return Ok(json!({
            "ok": true,
            "provider": "jev",
            "model": body.get("model").cloned().unwrap_or(json!(computer_use_jev_model(&config))),
            "latencyMs": started.elapsed().as_millis() as u64,
            "answer": body.get("answers").cloned(),
            "usage": body.get("usage").cloned(),
        }));
    }
    let account = config
        .get("cloudflareAccountId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("未配置 Cloudflare Account ID")?;
    let token = cloudflare_api_token().ok_or("未找到 Cloudflare API Token，请先在设置中保存")?;
    let endpoint = format!(
        "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}"
    );
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .json(&json!({ "model": model, "state": state, "questions": questions }))
        .send()
        .await
        .map_err(|e| format!("Clef 请求失败：{e}"))?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|e| format!("Clef 响应不是有效 JSON：{e}"))?;
    if !status.is_success() || payload.get("success").and_then(Value::as_bool) == Some(false) {
        let message = payload
            .pointer("/errors/0/message")
            .and_then(Value::as_str)
            .unwrap_or("请求被拒绝");
        return Err(format!("Clef 返回 {status}：{message}"));
    }
    let result = payload.get("result").cloned().unwrap_or(Value::Null);
    Ok(json!({
        "ok": true,
        "provider": "clef",
        "model": result.get("model").cloned().unwrap_or_else(|| json!(model)),
        "latencyMs": started.elapsed().as_millis() as u64,
        "answer": result.get("answers").cloned(),
        "usage": result.get("usage").cloned(),
    }))
}
