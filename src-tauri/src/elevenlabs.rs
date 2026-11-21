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
        .header("xi-api-key", key.clone())
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
    let signed_url = signed_url(&key, &engine).await.unwrap_or_default();
    // The mouth lives on the engine resource, not in this process. A failed
    // upgrade must not block the call; the next `up.sh` writes the same default.
    let _ = ensure_turbo(&key, &engine).await;
    Ok(json!({"token": token, "signedUrl": signed_url, "engineId": engine}))
}

/// Point the existing engine at v4 Turbo without dropping its voice.
async fn ensure_turbo(key: &str, engine: &str) -> Result<(), String> {
    let response = client()
        .get(format!("{API}/v1/speech-engine/{engine}"))
        .header("xi-api-key", key)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err("read engine".into());
    }
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let current = body
        .pointer("/tts/model_id")
        .or_else(|| body.pointer("/tts/modelId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if current == "eleven_v4_turbo" {
        return Ok(());
    }
    let mut tts = json!({
        "model_id": "eleven_v4_turbo",
        "expressive_mode": false,
    });
    if let Some(voice) = body
        .pointer("/tts/voice_id")
        .or_else(|| body.pointer("/tts/voiceId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        tts["voice_id"] = json!(voice);
    }
    let updated = client()
        .patch(format!("{API}/v1/speech-engine/{engine}"))
        .header("xi-api-key", key)
        .json(&json!({ "tts": tts }))
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if updated.status().is_success() {
        Ok(())
    } else {
        Err("upgrade".into())
    }
}

/// WebSocket fallback. WebRTC is UDP and dies on a VPN; this URL is TCP.
async fn signed_url(key: &str, engine: &str) -> Result<String, String> {
    let response = client()
        .get(format!("{API}/v1/convai/conversation/get-signed-url?agent_id={engine}"))
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
    body.get("signed_url")
        .or_else(|| body.get("signedUrl"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| value.starts_with("wss://") || value.starts_with("ws://"))
        .ok_or_else(|| "ElevenLabs 没有返回 WebSocket 地址".to_string())
}

/// The speech engine lives on this computer. A phone cannot see 127.0.0.1:3001.
#[tauri::command]
pub async fn speech_engine_health() -> Result<Value, String> {
    let response = match client()
        .get("http://127.0.0.1:3001/health")
        .timeout(std::time::Duration::from_millis(1500))
        .send()
        .await
    {
        Err(_) => {
            return Ok(json!({
                "running": false,
                "reason": "语音服务没在运行（电脑上 127.0.0.1:3001 没人接）。在 tools/speech-engine 里跑一次 ./up.sh。"
            }))
        }
        Ok(response) => response,
    };
    if !response.status().is_success() {
        return Ok(json!({
            "running": false,
            "reason": format!("语音服务回了 {}，不是它该有的应答。", response.status())
        }));
    }
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if body.get("ok") != Some(&Value::Bool(true)) {
        return Ok(json!({
            "running": false,
            "reason": "127.0.0.1:3001 上有东西在听，但不是 speech-engine。"
        }));
    }
    Ok(json!({
        "running": true,
        "ok": true,
        "engineId": body.get("engineId").cloned().unwrap_or(Value::Null),
        "cwd": body.get("cwd").cloned().unwrap_or(json!("")),
        "calls": body.get("calls").cloned().unwrap_or(json!(0)),
        "inFlight": body.get("inFlight").cloned().unwrap_or(json!(0)),
        "desk": body.get("desk").cloned().unwrap_or(json!(false)),
        "rssMb": body.get("rssMb").cloned().unwrap_or(json!(0)),
        "uptimeSec": body.get("uptimeSec").cloned().unwrap_or(json!(0)),
    }))
}

/// Proxy the local speech-engine desk. The phone holds the microphone; the
/// desk still has to reach 127.0.0.1:3001, which only exists on this computer.
/// `action` is a closed set so this cannot be turned into an open proxy.
#[tauri::command]
pub async fn speech_engine_desk(
    action: String,
    owner: Option<String>,
    id: Option<String>,
    text: Option<String>,
    timeout: Option<u64>,
) -> Result<Value, String> {
    let timeout = timeout.unwrap_or(20).clamp(1, 20);
    match action.trim() {
        "hello" => desk_exchange("POST", "/desk/hello", Some(json!({})), 3).await,
        "claim" => {
            let owner = checked_owner(owner)?;
            desk_exchange("POST", "/desk/claim", Some(json!({ "owner": owner })), 3).await
        }
        "release" => {
            let owner = checked_owner(owner)?;
            desk_exchange("POST", "/desk/release", Some(json!({ "owner": owner })), 3).await
        }
        "chunk" => {
            let id = id.unwrap_or_default();
            if !valid_turn(&id) {
                return Err("缺少回合 id".into());
            }
            desk_exchange(
                "POST",
                "/desk/chunk",
                Some(json!({ "id": id, "text": text.unwrap_or_default() })),
                3,
            )
            .await
        }
        "end" => {
            let id = id.unwrap_or_default();
            if !valid_turn(&id) {
                return Err("缺少回合 id".into());
            }
            desk_exchange("POST", "/desk/end", Some(json!({ "id": id })), 3).await
        }
        "next" => {
            let owner = checked_owner(owner)?;
            // The speech engine reads this as milliseconds. `timeout` here is seconds.
            desk_exchange(
                "GET",
                &format!("/desk/next?timeout={}&owner={owner}", timeout * 1000),
                None,
                timeout + 2,
            )
            .await
        }
        "spoken" => desk_exchange("GET", "/desk/spoken", None, 3).await,
        _ => Err("未知的语音桌子动作".into()),
    }
}

fn checked_owner(owner: Option<String>) -> Result<String, String> {
    let owner = owner.unwrap_or_default();
    if !valid_owner(&owner) {
        return Err("语音桌子的 owner 无效".into());
    }
    Ok(owner)
}

fn valid_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_turn(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

async fn desk_exchange(
    method: &str,
    path: &str,
    body: Option<Value>,
    timeout_secs: u64,
) -> Result<Value, String> {
    let url = format!("http://127.0.0.1:3001{path}");
    let request = match method {
        "GET" => client().get(url),
        "POST" => client().post(url),
        _ => return Err("内部错误".into()),
    };
    let request = request.timeout(std::time::Duration::from_secs(timeout_secs));
    let request = match body {
        Some(body) => request.json(&body),
        None => request,
    };
    let response = request.send().await.map_err(|_| {
        "语音服务没在运行（电脑上 127.0.0.1:3001 没人接）。在 tools/speech-engine 里跑一次 ./up.sh。"
            .to_string()
    })?;
    let status = response.status().as_u16();
    if status == 204 {
        return Ok(json!({ "status": 204 }));
    }
    let payload: Value = response.json().await.unwrap_or(Value::Null);
    Ok(json!({ "status": status, "body": payload }))
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
        .timeout(std::time::Duration::from_millis(2000))
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

/// Speak one sentence after the call has ended. Same key, same voice as the
/// call, v4 Turbo so the hung-up mouth does not sound like a different person.
/// Does not open a session and does not start Pi.
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
            "model_id": "eleven_v4_turbo",
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
