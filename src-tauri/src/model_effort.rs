//! Effort discovery for custom OpenAI Responses providers.
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Mutex, time::Duration};

use crate::bridge::{agent_dir, read_json_file, write_private_json};
use crate::providers::stored_api_key;

const LEVELS: [(&str, &str); 7] = [
    ("off", "none"),
    ("minimal", "minimal"),
    ("low", "low"),
    ("medium", "medium"),
    ("high", "high"),
    ("xhigh", "xhigh"),
    ("max", "max"),
];
const CACHE: &str = "pi-gui-efforts.json";
const API: &str = "openai-responses";
static CACHE_WRITE: Mutex<()> = Mutex::new(());

struct Target {
    base_url: String,
    auth_header: bool,
}

impl Target {
    fn load(dir: &Path, provider: &str, model_id: &str) -> Result<Option<Self>, String> {
        let path = dir.join("models.json");
        if !path.exists() {
            return Ok(None);
        }
        let config = read_json_file(path, "Pi models.json")?;
        let provider = &config["providers"][provider];
        let Some(model) = provider["models"].as_array().and_then(|models| {
            models
                .iter()
                .find(|model| model["id"].as_str() == Some(model_id))
        }) else {
            return Ok(None);
        };
        let api = model["api"].as_str().or_else(|| provider["api"].as_str());
        if api != Some(API) || model["type"] == "image" || model_id.starts_with("gpt-image-") {
            return Ok(None);
        }
        let base_url = model["baseUrl"]
            .as_str()
            .or_else(|| provider["baseUrl"].as_str())
            .ok_or("Effort 查询失败：Provider 缺少 Base URL")?
            .trim_end_matches('/');
        let url = reqwest::Url::parse(base_url).map_err(|_| "Effort 查询失败：Base URL 无效")?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Effort 查询失败：Base URL 必须是有效的 HTTP(S) API 地址".into());
        }
        Ok(Some(Self {
            base_url: base_url.to_owned(),
            auth_header: provider["authHeader"].as_bool().unwrap_or(true),
        }))
    }

    fn matches(&self, entry: &Value) -> bool {
        entry["baseUrl"].as_str() == Some(self.base_url.as_str())
            && entry["api"] == API
            && entry["levels"].is_array()
    }
}

fn load_cache(dir: &Path) -> Result<Value, String> {
    let path = dir.join(CACHE);
    if path.exists() {
        let value = read_json_file(path, "Effort 缓存")?;
        if !value.is_object()
            || value
                .as_object()
                .is_some_and(|providers| providers.values().any(|entry| !entry.is_object()))
        {
            return Err("Effort 缓存格式不正确".into());
        }
        Ok(value)
    } else {
        Ok(json!({}))
    }
}

#[tauri::command]
pub fn get_model_effort(
    provider: String,
    model_id: String,
    base_url: String,
) -> Result<Value, String> {
    let dir = agent_dir()?;
    let Some(target) = Target::load(&dir, &provider, &model_id)? else {
        return Ok(json!({"eligible": false}));
    };
    if target.base_url != base_url.trim_end_matches('/') {
        return Ok(json!({"eligible": false}));
    }
    let cache = load_cache(&dir)?;
    let entry = &cache[&provider][&model_id];
    if target.matches(entry) {
        Ok(json!({"eligible": true, "levels": entry["levels"]}))
    } else {
        Ok(json!({"eligible": true}))
    }
}

enum Probe {
    Accepted,
    Rejected,
    NoParameter,
    Allowlist(Vec<&'static str>),
}

fn classify(status: u16, body: &Value, sent: &str) -> Result<Probe, String> {
    if (200..300).contains(&status) {
        if body["error"].is_object()
            || matches!(body["status"].as_str(), Some("failed" | "cancelled"))
        {
            return Err("Effort 查询失败：模型请求未成功执行".into());
        }
        return Ok(if body["reasoning"]["effort"].as_str() == Some(sent) {
            Probe::Accepted
        } else {
            Probe::Rejected
        });
    }
    let error = &body["error"];
    let param = error["param"].as_str().unwrap_or_default();
    let code = error["code"].as_str().unwrap_or_default();
    if matches!(status, 400 | 422) && matches!(param, "reasoning" | "reasoning.effort") {
        if matches!(code, "unsupported_parameter" | "unknown_parameter") {
            return Ok(Probe::NoParameter);
        }
        if code == "unsupported_value" && param == "reasoning.effort" {
            let message = error["message"].as_str().unwrap_or_default();
            if message.contains("model") {
                if let Some((_, tail)) = message.split_once("Supported values are:") {
                    let values = tail.split('\'').skip(1).step_by(2).collect::<Vec<_>>();
                    let levels = LEVELS
                        .iter()
                        .filter(|(_, wire)| values.contains(wire))
                        .map(|(level, _)| *level)
                        .collect::<Vec<_>>();
                    if !levels.is_empty() && levels.len() == values.len() {
                        return Ok(Probe::Allowlist(levels));
                    }
                }
            }
        }
        if matches!(code, "unsupported_value" | "invalid_value") {
            return Ok(Probe::Rejected);
        }
    }
    let detail = match (status, code) {
        (_, "model_not_found") | (404, _) => "当前账号无法调用该模型或端点",
        (401 | 403, _) => "认证失败或账号没有权限",
        (429, _) => "Provider 请求受限，请稍后重试",
        (500..=599, _) => "Provider 服务暂时不可用",
        _ => "Provider 未返回可识别的档位结果",
    };
    Err(format!("Effort 查询失败（HTTP {status}）：{detail}"))
}

async fn discover(
    target: &Target,
    model_id: &str,
    key: Option<&str>,
) -> Result<Vec<&'static str>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Effort 查询失败：无法建立 HTTP 客户端")?;
    let mut levels = Vec::new();
    for (level, wire) in LEVELS {
        let mut request = client
            .post(format!("{}/responses", target.base_url))
            .json(&json!({
                "model": model_id, "input": "Reply OK.", "max_output_tokens": 16,
                "store": false, "reasoning": {"effort": wire},
            }));
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "Effort 查询超时"
            } else {
                "Effort 查询失败：无法连接 Provider"
            }
        })?;
        let status = response.status().as_u16();
        let body = response
            .json()
            .await
            .map_err(|_| format!("Effort 查询失败（HTTP {status}）：Provider 响应无法解析"))?;
        match classify(status, &body, wire)? {
            Probe::Accepted => levels.push(level),
            Probe::Rejected => {}
            Probe::Allowlist(levels) => return Ok(levels),
            Probe::NoParameter => return Ok(Vec::new()),
        }
    }
    if levels.is_empty() {
        return Err("Effort 查询失败：接口未确认任何档位".into());
    }
    Ok(levels)
}

#[tauri::command]
pub async fn probe_model_effort(
    provider: String,
    model_id: String,
    base_url: String,
) -> Result<Value, String> {
    let dir = agent_dir()?;
    let target = Target::load(&dir, &provider, &model_id)?.ok_or("此模型暂不支持 Effort 查询")?;
    if target.base_url != base_url.trim_end_matches('/') {
        return Err("Provider 地址已变更，请重新选择模型后查询 Effort".into());
    }
    let key = if target.auth_header {
        let auth = read_json_file(dir.join("auth.json"), "Pi auth.json")?;
        Some(
            stored_api_key(&auth, &provider)
                .ok_or("Effort 查询失败：没有可用的 Provider API Key")?,
        )
    } else {
        None
    };
    let levels = tokio::time::timeout(
        Duration::from_secs(35),
        discover(&target, &model_id, key.as_deref()),
    )
    .await
    .map_err(|_| "Effort 查询超时")??;
    let _guard = CACHE_WRITE.lock().map_err(|_| "无法锁定 Effort 缓存")?;
    let current = Target::load(&dir, &provider, &model_id)?
        .ok_or("Provider 配置已变更，请重新查询 Effort")?;
    if current.base_url != target.base_url || current.auth_header != target.auth_header {
        return Err("Provider 配置已变更，请重新查询 Effort".into());
    }
    let mut cache = load_cache(&dir)?;
    cache[&provider][&model_id] = json!({"baseUrl": target.base_url, "api": API, "levels": levels});
    let tmp = dir.join(format!(".{CACHE}.{}.tmp", uuid::Uuid::new_v4()));
    let result = write_private_json(&tmp, &cache).and_then(|()| {
        fs::rename(&tmp, dir.join(CACHE)).map_err(|error| format!("保存 Effort 缓存失败：{error}"))
    });
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result?;
    Ok(json!({"eligible": true, "levels": levels}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_model_allowlist_and_does_not_promote_aliases() {
        let body = json!({"error": {
            "code": "unsupported_value", "param": "reasoning.effort",
            "message": "'none' is not supported with the 'gpt-6.2-sol' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'."
        }});
        assert!(
            matches!(classify(400, &body, "none"), Ok(Probe::Allowlist(levels)) if levels == ["low", "medium", "high", "xhigh", "max"])
        );
        assert!(matches!(
            classify(200, &json!({"reasoning":{"effort":"none"}}), "minimal"),
            Ok(Probe::Rejected)
        ));
        assert!(matches!(
            classify(200, &json!({"reasoning":{"effort":"none"}}), "none"),
            Ok(Probe::Accepted)
        ));
    }

    #[test]
    fn transport_and_generic_enum_errors_are_not_capabilities() {
        let body = json!({"error":{"code":"invalid_value","param":"reasoning.effort","message":"Supported values are: 'none', 'high'."}});
        assert!(matches!(classify(400, &body, "none"), Ok(Probe::Rejected)));
        assert!(classify(429, &body, "none").is_err());
        assert!(matches!(
            classify(
                400,
                &json!({"error":{"code":"unknown_parameter","param":"reasoning"}}),
                "none"
            ),
            Ok(Probe::NoParameter)
        ));
    }
}
