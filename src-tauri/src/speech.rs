//! Speech-to-text for the composer's mic button — the speaking half of typing.
//!
//! The recording is a browser `MediaRecorder` blob; this module turns it into
//! text and knows nothing about the UI. Two transports share one command:
//!
//! * **`volcengine-speech`** — 火山引擎「语音技术」的录音文件识别极速版
//!   (`openspeech.bytedance.com/api/v1/auc`, 大模型 `Seed-ASR`). This is the
//!   default, because the 方舟 gateway the chat providers use has no
//!   transcription route at all — verified live: `/api/v3/audio/transcriptions`
//!   and `/api/v3/tts/unidirectional` both 404 with an *empty* body while chat
//!   errors come back as JSON from the same key. Ark keys cannot reach this
//!   API: it authenticates with a speech-console **AppID + Access Token**, the
//!   token stored in Pi's `auth.json` under `volcengine-speech`, the AppID in
//!   `speech.json` beside it.
//! * **`openai-compat`** — any `POST {baseUrl}/audio/transcriptions` endpoint
//!   with a Bearer key read from `auth.json` for the named provider. This is
//!   how the pipeline gets tested before speech-console credentials exist
//!   (e.g. stepfun's `step-asr`).
//!
//! The config file follows the `image.json` contract, because the same three
//! properties are load-bearing here too:
//!
//! * **Every key is optional** — an absent key means "keep the default", so an
//!   unconfigured install simply reports what is missing instead of breaking.
//! * **A write is a patch** — absent keeps, explicit `null` clears.
//! * **No secrets in the file** — tokens live in `auth.json` (mode 0o600);
//!   `speech.json` is plain config written unencrypted.

use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

use crate::bridge;

/// The `auth.json` entry the volcengine transport reads its Access Token from.
/// Mirrored by the settings page and guarded by a test, like the image one.
pub const DEFAULT_PROVIDER_ID: &str = "volcengine-speech";

const OPENSPEECH_AUC_URL: &str = "https://openspeech.bytedance.com/api/v1/auc";
const DEFAULT_RESOURCE_ID: &str = "volc.bigasr.auc";
const DEFAULT_MODEL_NAME: &str = "bigmodel";
const DEFAULT_OPENAI_MODEL: &str = "step-asr";
const TRANSPORTS: [&str; 2] = ["volcengine-speech", "openai-compat"];

/// A recording the console can plausibly bill for is minutes, not hours; past
/// this the request is a bug (a stuck recorder), so refuse before uploading.
const MAX_AUDIO_BASE64_CHARS: usize = 220_200_960; // 165 MB decoded

fn speech_config_path() -> Result<PathBuf, String> {
    Ok(bridge::agent_dir()?.join("speech.json"))
}

fn trimmed(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// A URL we can POST a body to from Rust — no path appended, so any https host
/// the speech console (or a self-hosted gateway) publishes works.
fn http_url(value: &str) -> bool {
    match value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    {
        Some(rest) => !rest.is_empty() && !rest.starts_with('/') && !rest.contains(char::is_whitespace),
        None => false,
    }
}

/// The provider id is a key in Pi's `auth.json`, so it follows the same grammar
/// the Providers page enforces.
fn valid_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Only keys this module understands survive a read, so a hand-edited file
/// cannot smuggle a field the command would then silently ignore.
fn normalized(stored: &Value) -> Value {
    let mut out = Map::new();
    if let Some(object) = stored.as_object() {
        for key in ["transport", "appid", "provider", "baseUrl", "model", "resourceId", "modelName", "uid"] {
            if let Some(value) = trimmed(object.get(key).unwrap_or(&Value::Null)) {
                out.insert(key.into(), Value::String(value));
            }
        }
    }
    let configured = ["transport", "appid", "provider", "baseUrl"]
        .iter()
        .any(|key| out.contains_key(*key));
    out.insert("configured".into(), Value::Bool(configured));
    Value::Object(out)
}

fn read_stored() -> Value {
    speech_config_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| normalized(&value))
        .unwrap_or_else(|| normalized(&Value::Null))
}

fn read_agent_json(name: &str) -> Result<Value, String> {
    let dir = bridge::agent_dir()?;
    std::fs::read_to_string(dir.join(name))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .or_else(|| Some(json!({})))
        .ok_or_else(|| format!("{name} 不是合法 JSON"))
}

fn auth_json() -> Result<Value, String> {
    read_agent_json("auth.json")
}

/// The Providers page is where credentials live; the base URL lives there too.
/// Reading it from the saved profile keeps the speech setup to「define a provider,
/// then point speech.json at it」— one source of truth per endpoint.
fn provider_profile_base_url(provider: &str) -> Option<String> {
    let providers = read_agent_json("pi-gui-providers.json").ok()?;
    providers
        .pointer(&format!("/providers/{provider}/baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// What is stored, plus whether Pi can currently resolve the credential each
/// transport needs — the page wants both facts and they live in two files.
#[tauri::command]
pub async fn speech_config() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stored = read_stored();
        let transport = stored
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("volcengine-speech")
            .to_owned();
        let credential_provider = if transport == "openai-compat" {
            stored
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("stepfun")
                .to_owned()
        } else {
            DEFAULT_PROVIDER_ID.to_owned()
        };
        let has_credential = auth_json()
            .ok()
            .and_then(|auth| bridge::stored_api_key(&auth, &credential_provider))
            .is_some();
        let mut config = stored;
        config["transport"] = Value::String(transport);
        config["credentialProvider"] = Value::String(credential_provider);
        config["hasCredential"] = Value::Bool(has_credential);
        Ok(config)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Structural validation of one patch: unknown transports and malformed ids are
/// refused here so the command never has to guess what a half-written file meant.
fn validate_patch(input: &Value) -> Result<Value, String> {
    let object = input
        .as_object()
        .ok_or_else(|| "语音配置必须是一个对象".to_string())?;
    let mut out = Map::new();
    for key in ["transport", "appid", "provider", "baseUrl", "model", "resourceId", "modelName", "uid"] {
        if !object.contains_key(key) {
            continue;
        }
        let value = &object[key];
        if value.is_null() {
            out.insert(key.into(), Value::Null);
            continue;
        }
        let text = trimmed(value).ok_or_else(|| format!("{key} 不能是空字符串；传 null 表示清除"))?;
        match key {
            "transport" if !TRANSPORTS.contains(&text.as_str()) => {
                return Err(format!("transport 只支持 {}，收到 {text}", TRANSPORTS.join(" / ")));
            }
            "provider" if !valid_provider_id(&text) => {
                return Err("provider ID 只能包含字母、数字、-、_、.".into());
            }
            "baseUrl" => {
                let base = text.trim_end_matches('/').to_owned();
                if !http_url(&base) {
                    return Err("baseUrl 必须是 http(s) 地址".into());
                }
                out.insert(key.into(), Value::String(base));
                continue;
            }
            _ => {}
        }
        out.insert(key.into(), Value::String(text));
    }
    Ok(Value::Object(out))
}

/// Fold a validated patch into what is stored. `null` removes, absent keeps.
fn merge(stored: &Value, patch: &Value) -> Value {
    let mut out = stored.as_object().cloned().unwrap_or_default();
    out.remove("configured");
    if let Some(object) = patch.as_object() {
        for (key, value) in object {
            if value.is_null() {
                out.remove(key);
            } else {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

#[tauri::command]
pub async fn save_speech_config(config: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let patch = validate_patch(&config)?;
        let merged = merge(&read_stored(), &patch);
        let path = speech_config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("无法创建 Pi 配置目录：{e}"))?;
        }
        if path.exists() {
            let _ = std::fs::copy(&path, path.with_extension("json.bak"));
        }
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
        Ok(normalized(&merged))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Store the credential where Pi reads keys, for whichever transport's provider
/// the settings page is editing (`volcengine-speech` by default).
#[tauri::command]
pub async fn save_speech_api_key(provider: Option<String>, api_key: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let provider = provider
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_PROVIDER_ID);
        if !valid_provider_id(provider) {
            return Err("Provider ID 只能包含字母、数字、-、_、.".into());
        }
        bridge::store_provider_api_key(provider, api_key.as_deref())?;
        let has_credential = auth_json()
            .ok()
            .and_then(|auth| bridge::stored_api_key(&auth, provider))
            .is_some();
        Ok(json!({"provider": provider, "hasCredential": has_credential}))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `audio/mp4;codecs=aacl` → the format name each transport's API expects.
/// The recording mime comes from the browser's MediaRecorder, so unknown values
/// are passed through as a best guess instead of silently relabelled.
fn audio_format(mime_type: &str) -> String {
    let base = mime_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match base.as_str() {
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a".into(),
        "audio/aac" => "aac".into(),
        "audio/mpeg" | "audio/mp3" => "mp3".into(),
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav".into(),
        "audio/ogg" | "application/ogg" => "ogg".into(),
        "audio/flac" => "flac".into(),
        "audio/webm" => "webm".into(),
        other => other.strip_prefix("audio/").unwrap_or(other).to_owned(),
    }
}

/// Turn a recording into text via the configured transport.
#[tauri::command]
pub async fn transcribe_audio(audio_base64: String, mime_type: Option<String>) -> Result<Value, String> {
    if audio_base64.len() > MAX_AUDIO_BASE64_CHARS {
        return Err("录音太长，无法转写".into());
    }
    if audio_base64.is_empty() {
        return Err("录音是空的".into());
    }
    let stored = read_stored();
    let transport = stored
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("volcengine-speech");
    let mime = mime_type.as_deref().unwrap_or("audio/webm");
    let format = audio_format(mime);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("无法创建网络客户端：{e}"))?;
    if transport == "openai-compat" {
        transcribe_openai_compat(&client, &stored, audio_base64, mime, &format).await
    } else {
        transcribe_volcengine(&client, &stored, audio_base64, &format).await
    }
}

/// 火山语音极速版：JSON 里带 base64 音频，AppID/Token 走 X-Api 头。
async fn transcribe_volcengine(
    client: &reqwest::Client,
    stored: &Value,
    audio_base64: String,
    format: &str,
) -> Result<Value, String> {
    let appid = stored
        .get("appid")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "火山语音识别未配置：speech.json 缺少 appid（语音技术控制台 → 应用管理 里获取）".to_string())?;
    let token = auth_json()?
        .get(DEFAULT_PROVIDER_ID)
        .and_then(|entry| entry.get("key"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "火山语音识别未配置：缺少 Access Token（语音技术控制台 → 应用管理 里获取，用「语音识别 API Key」保存）".to_string())?
        .to_owned();
    let body = json!({
        "user": {"uid": stored.get("uid").and_then(Value::as_str).unwrap_or("orbit")},
        "audio": {"format": format, "data": audio_base64},
        "request": {
            "model_name": stored.get("modelName").and_then(Value::as_str).unwrap_or(DEFAULT_MODEL_NAME),
        },
    });
    let response = client
        .post(stored
            .get("resourceId")
            .and_then(Value::as_str)
            .map(|_| OPENSPEECH_AUC_URL.to_owned())
            .unwrap_or_else(|| OPENSPEECH_AUC_URL.to_owned()))
        .header("X-Api-App-Key", appid)
        .header("X-Api-Access-Key", token)
        .header("X-Api-Resource-Id", stored.get("resourceId").and_then(Value::as_str).unwrap_or(DEFAULT_RESOURCE_ID))
        .header("X-Api-Request-Id", Uuid::new_v4().to_string())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("火山语音识别请求失败：{e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("火山语音识别失败（{status}）：{}", truncate(&text)));
    }
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| format!("火山语音识别返回了无法解析的内容：{}", truncate(&text)))?;
    if let Some(error) = parsed.get("message").and_then(Value::as_str) {
        return Err(format!("火山语音识别失败：{error}"));
    }
    let transcript = parsed
        .pointer("/audio/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok(json!({"text": transcript, "noSpeech": transcript.is_empty(), "transport": "volcengine-speech"}))
}

/// OpenAI-compatible `/audio/transcriptions`: multipart form, Bearer key from
/// `auth.json` under the configured provider id.
async fn transcribe_openai_compat(
    client: &reqwest::Client,
    stored: &Value,
    audio_base64: String,
    mime: &str,
    format: &str,
) -> Result<Value, String> {
    let provider = stored
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("stepfun");
    let base_url = stored
        .get("baseUrl")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| provider_profile_base_url(provider))
        .ok_or_else(|| {
            format!("语音识别未配置：找不到 {provider} 的 API 地址 —— 在 Provider 页保存它，或在 speech.json 填 baseUrl")
        })?;
    let model = stored
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_OPENAI_MODEL);
    let key = auth_json()?
        .get(provider)
        .and_then(|entry| entry.get("key"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("语音识别未配置：{provider} 还没有保存 API Key —— 在 Provider 页填一次即可"))?
        .to_owned();
    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("录音数据无法解码：{e}"))?;

    // A hand-built multipart body: one `model` field, one `file` field. reqwest's
    // multipart feature would do the same, but it drags in a feature tree for a
    // format that has not changed since 2007.
    let boundary = format!("orbit-speech-{}", Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(audio.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{model}\r\n").as_bytes());
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.{format}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(&audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("语音识别请求失败：{e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // A recording with no detectable speech is a "try again", not an error:
        // stepfun answers 400 {"message":"no speech found"} for clicks, breaths
        // and muted mics alike, and surfacing that as a red toast would read as
        // the feature being broken when the fix is just talking into the mic.
        if text.contains("no speech") {
            return Ok(json!({"text": "", "noSpeech": true, "transport": "openai-compat"}));
        }
        return Err(format!("语音识别失败（{status}）：{}", truncate(&text)));
    }
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|_| format!("语音识别返回了无法解析的内容：{}", truncate(&text)))?;
    let transcript = parsed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok(json!({"text": transcript, "noSpeech": transcript.is_empty(), "transport": "openai-compat", "model": model}))
}

fn truncate(text: &str) -> String {
    if text.len() <= 400 {
        text.to_owned()
    } else {
        // `floor_char_boundary` is newer than this repo's MSRV, so walk back to
        // one by hand: 400 bytes, or the last valid UTF-8 edge before it.
        let mut cut = 400;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &text[..cut])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(stored: &Value, patch: Value) -> Value {
        let merged = merge(stored, &validate_patch(&patch).expect("patch should validate"));
        normalized(&merged)
    }

    fn refused(patch: Value) -> String {
        validate_patch(&patch).expect_err("patch should be refused")
    }

    #[test]
    fn an_empty_patch_changes_nothing() {
        let stored = normalized(&json!({"appid": "a1"}));
        assert_eq!(saved(&stored, json!({})), stored);
    }

    #[test]
    fn a_write_is_a_patch_so_one_field_cannot_delete_another() {
        let stored = normalized(&json!({"appid": "a1", "provider": "stepfun"}));
        let after = saved(&stored, json!({"model": "step-asr"}));
        assert_eq!(after["appid"], json!("a1"));
        assert_eq!(after["provider"], json!("stepfun"));
        assert_eq!(after["model"], json!("step-asr"));
    }

    #[test]
    fn null_clears_and_absence_keeps() {
        let stored = saved(&normalized(&json!({"appid": "a1", "uid": "me"})), json!({}));
        let cleared = saved(&stored, json!({"uid": null}));
        assert!(cleared.get("uid").is_none());
        assert_eq!(cleared["appid"], json!("a1"));
    }

    #[test]
    fn only_known_keys_survive_a_read() {
        let stored = normalized(&json!({"appid": "a1", "apiKey": "nope", "extra": true}));
        assert!(stored.get("apiKey").is_none());
        assert!(stored.get("extra").is_none());
    }

    #[test]
    fn configured_reflects_whether_any_transport_was_named() {
        assert_eq!(normalized(&Value::Null)["configured"], json!(false));
        assert_eq!(normalized(&json!({"transport": "openai-compat"}))["configured"], json!(true));
        assert_eq!(normalized(&json!({"appid": "a1"}))["configured"], json!(true));
        assert_eq!(normalized(&json!({"model": "step-asr"}))["configured"], json!(false));
    }

    #[test]
    fn an_unknown_transport_is_refused_by_name() {
        assert!(refused(json!({"transport": "websocket"})).contains("只支持"));
    }

    #[test]
    fn a_provider_id_is_a_key_in_auth_json_so_it_is_checked() {
        assert!(refused(json!({"provider": "has space"})).contains("只能包含"));
    }

    #[test]
    fn a_base_url_is_stored_without_its_trailing_slash() {
        let after = saved(&json!({}), json!({"baseUrl": "https://api.stepfun.com/v1/"}));
        assert_eq!(after["baseUrl"], json!("https://api.stepfun.com/v1"));
    }

    #[test]
    fn empty_strings_are_refused_because_null_is_how_you_clear() {
        assert!(refused(json!({"appid": "  "})).contains("传 null 表示清除"));
    }

    #[test]
    fn recorder_mimes_map_onto_api_format_names() {
        assert_eq!(audio_format("audio/mp4;codecs=aac"), "m4a");
        assert_eq!(audio_format("audio/webm;codecs=opus"), "webm");
        assert_eq!(audio_format("audio/wav"), "wav");
        assert_eq!(audio_format("audio/mpeg"), "mp3");
        assert_eq!(audio_format("audio/ogg"), "ogg");
    }

    #[test]
    fn an_unknown_audio_mime_falls_through_to_its_suffix() {
        assert_eq!(audio_format("audio/something-odd"), "something-odd");
        assert_eq!(audio_format(""), "");
    }

    #[test]
    fn error_bodies_are_truncated_on_a_char_boundary() {
        // The cut is at 400 **bytes**, on a valid boundary, plus the ellipsis ——
        // the point is a small body that still parses as UTF-8, not a torn one.
        let cut = truncate(&"汉".repeat(500));
        assert!(cut.len() <= 404, "truncated body must stay small: {}", cut.len());
        assert!(cut.ends_with('…'));
        assert!(std::str::from_utf8(cut.as_bytes()).is_ok());
        assert_eq!(truncate("short"), "short");
    }
}
