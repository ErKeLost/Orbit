//! The voice gate: one SystemOne call per utterance.
//!
//! Prism owns the ears and the mouth. This decides whether what it heard is
//! small talk or something the working session should do. The Jev key stays in
//! Rust; a missing key or a timeout is a failure, and the desk then speaks and
//! does not dispatch.

use serde_json::{json, Value};

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// One SystemOne call for the voice desk. The key stays here.
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
