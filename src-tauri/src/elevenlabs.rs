//! ElevenLabs Speech Engine: calls, not audio plumbing.
//!
//! ElevenLabs owns the call — microphone capture, speech-to-text, turn-taking,
//! interruption and text-to-speech all run on their side. This app only needs to
//! (a) keep the API key out of the webview, (b) hold the engine id, and (c) mint the
//! short-lived WebRTC conversation token the page uses to join a call.
//!
//! The desktop decides what to say. Speech Engine only forwards the transcript.
//! This process does not start a Pi session.

use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::bridge;

/// Provider id used in `auth.json`; shared with the other credentials.
pub const DEFAULT_PROVIDER_ID: &str = "elevenlabs";
const API: &str = "https://api.elevenlabs.io";

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(bridge::agent_dir()?.join("eleven.json"))
}

fn auth_json() -> Result<Value, String> {
    let dir = bridge::agent_dir()?;
    let text = std::fs::read_to_string(dir.join("auth.json")).unwrap_or_else(|_| "{}".into());
    serde_json::from_str::<Value>(&text).map_err(|_| "Pi 的 auth.json 不是合法 JSON".to_string())
}

fn api_key() -> Result<String, String> {
    let auth = auth_json()?;
    bridge::stored_api_key(&auth, DEFAULT_PROVIDER_ID)
        .ok_or_else(|| "还没有配置 ElevenLabs API Key（在语音设置里填一次即可）".to_string())
}

/// A Speech Engine id is `seng_…`; older accounts may point at an `agent_…` id.
fn valid_engine(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return false;
    }
    let known = trimmed.starts_with("seng_") || trimmed.starts_with("agent_");
    known && trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn read_stored() -> Value {
    std::fs::read_to_string(config_path().unwrap_or_default())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null)
}

fn normalized(value: &Value) -> Value {
    let engine = value.get("engineId").and_then(Value::as_str).unwrap_or("").trim().to_owned();
    json!({
        "engineId": engine,
        "configured": !engine.is_empty(),
    })
}

fn config_for_ui(config: Value) -> Value {
    let mut config = config;
    config["hasCredential"] =
        json!(auth_json().ok().and_then(|auth| bridge::stored_api_key(&auth, DEFAULT_PROVIDER_ID)).is_some());
    config
}

#[tauri::command]
pub async fn speech_engine_config() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(config_for_ui(normalized(&read_stored()))))
        .await
        .map_err(|error| error.to_string())?
}

/// `null` clears the id; anything else must look like a real engine id.
#[tauri::command]
pub async fn save_speech_engine_config(config: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let patch = config.as_object().ok_or_else(|| "语音配置必须是一个对象".to_string())?;
        let engine = match patch.get("engineId") {
            None => read_stored().get("engineId").and_then(Value::as_str).unwrap_or("").to_owned(),
            Some(Value::Null) => String::new(),
            Some(value) => {
                let text = value.as_str().map(str::trim).unwrap_or_default();
                if !valid_engine(text) {
                    return Err("Speech Engine ID 必须形如 seng_xxx".to_string());
                }
                text.to_owned()
            }
        };
        let stored = {
            // `eleven.json` also carries the tunnel address written by `up.sh`; keep it.
            let mut stored = read_stored();
            if !stored.is_object() {
                stored = json!({});
            }
            stored["engineId"] = json!(engine);
            stored
        };
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("无法创建 Pi 配置目录：{error}"))?;
        }
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())? + "\n",
        )
        .map_err(|error| format!("写入 {} 失败：{error}", path.display()))?;
        Ok(config_for_ui(normalized(&stored)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_speech_engine_api_key(api_key: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        bridge::store_provider_api_key(DEFAULT_PROVIDER_ID, api_key.as_deref())?;
        let has_credential = auth_json()
            .ok()
            .and_then(|auth| bridge::stored_api_key(&auth, DEFAULT_PROVIDER_ID))
            .is_some();
        Ok(json!({"hasCredential": has_credential}))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Short-lived WebRTC token. The API key never leaves this process.
#[tauri::command]
pub async fn speech_engine_token() -> Result<Value, String> {
    let key = api_key()?;
    let engine = normalized(&read_stored())["engineId"].as_str().unwrap_or_default().to_owned();
    if engine.is_empty() {
        return Err("还没有配置 Speech Engine ID（在语音设置里填一次即可）".into());
    }
    let response = client()
        .get(format!("{API}/v1/convai/conversation/token?agent_id={engine}"))
        .header("xi-api-key", key)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("连接 ElevenLabs 失败：{error}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(detail(status.as_u16(), &body));
    }
    let token = body.get("token").and_then(Value::as_str).unwrap_or_default();
    if token.is_empty() {
        return Err("ElevenLabs 没有返回会话 token".into());
    }
    Ok(json!({"token": token, "engineId": engine}))
}

/// Free-plan quota is what makes a call fail mid-sentence, so show it up front.
#[tauri::command]
pub async fn speech_engine_check() -> Result<Value, String> {
    let key = api_key()?;
    let response = client()
        .get(format!("{API}/v1/user/subscription"))
        .header("xi-api-key", key)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| format!("连接 ElevenLabs 失败：{error}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(detail(status.as_u16(), &body));
    }
    Ok(json!({
        "ok": true,
        "tier": body.get("tier").cloned().unwrap_or(Value::Null),
        "characterCount": body.get("character_count").cloned().unwrap_or(Value::Null),
        "characterLimit": body.get("character_limit").cloned().unwrap_or(Value::Null),
    }))
}

/// One SystemOne call for the voice desk. The key stays here. A missing key
/// or a timeout is a failure; the desk then speaks and does not dispatch.
#[tauri::command]
pub async fn voice_classify(request: Value) -> Result<Value, String> {
    let key = crate::computer_use::typesafe_api_key().ok_or_else(|| "没有 Jev Key".to_string())?;
    let config = crate::computer_use::read_computer_use_config();
    let base = config
        .get("systemoneBaseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.typesafe.ai")
        .trim_end_matches('/')
        .to_string();
    let mut body = request;
    if !body.is_object() {
        return Err("语音分类必须是一个对象".into());
    }
    body["model"] = json!(crate::computer_use::computer_use_jev_model(&config));
    let response = client()
        .post(format!("{base}/v1/systemone"))
        .bearer_auth(key)
        .json(&body)
        .timeout(std::time::Duration::from_millis(800))
        .send()
        .await
        .map_err(|error| format!("Jev 请求失败：{error}"))?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("请求被拒绝");
        return Err(format!("Jev 返回 {status}：{message}"));
    }
    Ok(payload)
}

/// Speak one sentence after the call has ended. Same key, flash model, the
/// engine's own voice. Does not open a session and does not start Pi.
#[tauri::command]
pub async fn speech_engine_speak(text: String) -> Result<Value, String> {
    let sentence = text.trim().to_string();
    if sentence.is_empty() || sentence.chars().count() > 400 {
        return Err("播报只能是一两句".into());
    }
    let key = api_key()?;
    let engine = normalized(&read_stored())["engineId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if engine.is_empty() {
        return Err("还没有配置 Speech Engine ID".into());
    }
    let voice = engine_voice(&key, &engine).await?;
    let response = client()
        .post(format!("{API}/v1/text-to-speech/{voice}?output_format=mp3_22050_32"))
        .header("xi-api-key", key)
        .json(&json!({
            "text": sentence,
            "model_id": "eleven_flash_v2_5",
        }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|error| format!("合成失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body: Value = response.json().await.unwrap_or(Value::Null);
        return Err(detail(status.as_u16(), &body));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("合成没有返回声音：{error}"))?;
    Ok(json!({
        "audioBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "mime": "audio/mpeg",
    }))
}

async fn engine_voice(key: &str, engine: &str) -> Result<String, String> {
    let response = client()
        .get(format!("{API}/v1/speech-engine/{engine}"))
        .header("xi-api-key", key)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| format!("读取声音失败：{error}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(detail(status.as_u16(), &body));
    }
    body.pointer("/tts/voice_id")
        .or_else(|| body.pointer("/tts/voiceId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Speech Engine 没有声音".to_string())
}

fn detail(status: u16, body: &Value) -> String {
    let message = body
        .pointer("/detail/message")
        .or_else(|| body.pointer("/detail"))
        .and_then(Value::as_str)
        .unwrap_or("请求失败");
    format!("ElevenLabs {status}：{message}")
}
