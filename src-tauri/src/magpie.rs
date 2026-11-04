//! Magpie gateway transport and setup. Each model keeps its native wire API;
//! subscription credentials and multi-account routing remain owned by Magpie.
use crate::bridge::{agent_dir, read_json_file, write_private_json};
use crate::providers::{
    load_provider_store, normalize_catalog, pi_model_from_meta, store_provider_api_key,
    stored_api_key, write_provider_store,
};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) const PROVIDER_ID: &str = "magpie";
const MAGPIE_DEFAULT_ROOT: &str = "http://127.0.0.1:3425";
const MAGPIE_DEFAULT_TOKEN: &str = "magpie";

fn normalize_magpie_root(value: Option<&str>) -> Result<String, String> {
    let raw = value.unwrap_or(MAGPIE_DEFAULT_ROOT).trim();
    let raw = if raw.is_empty() {
        MAGPIE_DEFAULT_ROOT
    } else {
        raw
    };
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let mut url =
        reqwest::Url::parse(&candidate).map_err(|_| "Magpie 地址不是有效 URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Magpie 只支持 HTTP(S) 地址".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("请在 API Key 字段填写凭据".into());
    }
    let path = url
        .path()
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string();
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

async fn fetch_magpie_json(root: &str, token: &str, path: &str) -> Result<Value, String> {
    let endpoint = format!("{}{path}", root.trim_end_matches('/'));
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?
        .get(&endpoint)
        .bearer_auth(token)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Magpie 请求失败：{e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Magpie 返回 HTTP {}", status.as_u16()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("Magpie 响应不是有效 JSON：{e}"))
}

fn magpie_token(auth: &Value, supplied: Option<&str>) -> String {
    supplied
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| stored_api_key(auth, PROVIDER_ID))
        .unwrap_or_else(|| MAGPIE_DEFAULT_TOKEN.to_string())
}

/// Probe the Magpie catalog and its cached subscription allowances.
#[tauri::command]
pub async fn magpie_status(root: Option<String>, api_key: Option<String>) -> Result<Value, String> {
    let root = normalize_magpie_root(root.as_deref())?;
    let dir = agent_dir()?;
    let auth = read_json_file(dir.join("auth.json"), "Pi auth.json").unwrap_or_else(|_| json!({}));
    let token = magpie_token(&auth, api_key.as_deref());
    let catalog = fetch_magpie_json(&root, &token, "/v1/models").await?;
    let quotas = fetch_magpie_json(&root, &token, "/v1/magpie/quotas?kept=1")
        .await
        .unwrap_or_else(|error| json!({"error": error}));
    let count = catalog["data"].as_array().map(Vec::len).unwrap_or(0);
    Ok(
        json!({"root": root, "reachable": true, "modelCount": count, "catalog": catalog, "quotas": quotas}),
    )
}

/// Pi's complete thinking ladder. Null hides unsupported levels, `off` maps
/// to Magpie's `none`; Anthropic can disable thinking independently of effort.
pub(crate) fn thinking_levels(raw: &Value, anthropic: bool) -> Option<Value> {
    let efforts = raw["supported_reasoning_levels"]
        .as_array()?
        .iter()
        .filter_map(|entry| entry["effort"].as_str())
        .collect::<Vec<_>>();
    if efforts.is_empty() {
        return None;
    }
    let mut levels = json!({});
    for level in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
        let effort = if level == "off" { "none" } else { level };
        if efforts.contains(&effort) {
            levels[level] = json!(effort);
        } else if !(anthropic && level == "off") {
            levels[level] = Value::Null;
        }
    }
    Some(levels)
}

fn adaptive_thinking(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    for family in ["opus", "sonnet", "haiku"] {
        let prefix = format!("claude-{family}-");
        let Some((_, version)) = lower.split_once(&prefix) else {
            continue;
        };
        let parts = version.split(['-', '.']).collect::<Vec<_>>();
        let major = parts[0].parse::<u32>().unwrap_or(0);
        let minor = parts
            .get(1)
            .and_then(|part| part.parse::<u32>().ok())
            .unwrap_or(0);
        return major > 4 || (major == 4 && minor >= 6);
    }
    false
}

pub(crate) fn apply_transport(model: &mut Value, raw: &Value, base_url: Option<&str>) {
    let native = raw["native_endpoints"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let root = base_url
        .unwrap_or(MAGPIE_DEFAULT_ROOT)
        .trim_end_matches('/')
        .trim_end_matches("/v1");
    let api = if native.contains(&"/v1/responses") {
        "openai-responses"
    } else if native.contains(&"/v1/messages") {
        "anthropic-messages"
    } else {
        "openai-completions"
    };
    let anthropic = api == "anthropic-messages";
    model["api"] = json!(api);
    model["baseUrl"] = json!(if anthropic {
        root.to_string()
    } else {
        format!("{root}/v1")
    });
    // A gateway catalogue has no prices; retail API prices would misrepresent
    // subscription cost, so preserve pi-magpie's zero-cost convention.
    model["cost"] = json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0});
    if let Some(levels) = thinking_levels(raw, anthropic) {
        model["thinkingLevelMap"] = levels;
        model["reasoning"] = json!(true);
    }
    if anthropic && adaptive_thinking(model["id"].as_str().unwrap_or_default()) {
        model["compat"] = json!({"forceAdaptiveThinking":true});
    }
}

/// Validate the live catalog before writing a profile. This never installs or
/// starts Magpie; its own application remains the account manager.
#[tauri::command]
pub async fn connect_magpie(
    root: Option<String>,
    api_key: Option<String>,
) -> Result<Value, String> {
    let root = normalize_magpie_root(root.as_deref())?;
    let dir = agent_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let auth_path = dir.join("auth.json");
    let auth = if auth_path.exists() {
        read_json_file(auth_path, "Pi auth.json")?
    } else {
        json!({})
    };
    let token = magpie_token(&auth, api_key.as_deref());
    let raw = fetch_magpie_json(&root, &token, "/v1/models").await?;
    let catalog = normalize_catalog(&raw, None, PROVIDER_ID, &root, None);
    let models = catalog["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| pi_model_from_meta(entry, PROVIDER_ID, Some(&root)))
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Err("Magpie 已连接，但没有可用模型".into());
    }
    let path = dir.join("models.json");
    let mut config = if path.exists() {
        read_json_file(path.clone(), "Pi models.json")?
    } else {
        json!({"providers":{}})
    };
    let providers = config["providers"]
        .as_object_mut()
        .ok_or("Pi models.json 缺少 providers 对象")?;
    let previous = providers
        .get(PROVIDER_ID)
        .and_then(|item| item["models"].as_array())
        .map(Vec::len)
        .unwrap_or(0);
    providers.insert(PROVIDER_ID.into(), json!({
        "name":"Magpie", "baseUrl":format!("{root}/v1"), "api":"openai-completions", "authHeader":true, "models":models,
    }));
    let mut store = load_provider_store(&dir)?;
    let entries = store["providers"]
        .as_object_mut()
        .ok_or("Orbit Provider 配置格式不正确")?;
    let mut profile = entries
        .get(PROVIDER_ID)
        .cloned()
        .unwrap_or_else(|| json!({}));
    profile["name"] = json!("Magpie");
    profile["baseUrl"] = json!(format!("{root}/v1"));
    profile["modelsUrl"] = json!(format!("{root}/v1/models"));
    profile["api"] = json!("openai-completions");
    profile["authHeader"] = json!(true);
    // Never duplicate gateway credentials in Orbit's presentation config.
    profile
        .as_object_mut()
        .ok_or("Magpie 配置格式不正确")?
        .remove("apiKey");
    entries.insert(PROVIDER_ID.into(), profile);
    store_provider_api_key(PROVIDER_ID, Some(&token))?;
    write_private_json(&path, &config)?;
    write_provider_store(&dir, &store)?;
    Ok(
        json!({"root":root,"provider":PROVIDER_ID,"synced":{"provider":PROVIDER_ID,"count":models.len(),"previous":previous,"firstModelId":models[0]["id"]}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn models_keep_native_protocol_and_only_supported_efforts() {
        let mut claude = json!({"id":"antigravity/claude-sonnet-4.6"});
        apply_transport(
            &mut claude,
            &json!({"native_endpoints":["/v1/messages"],"supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]}),
            Some("http://localhost:3425/v1"),
        );
        assert_eq!(claude["baseUrl"], "http://localhost:3425");
        assert_eq!(claude["api"], "anthropic-messages");
        assert_eq!(claude["compat"]["forceAdaptiveThinking"], true);
        assert_eq!(claude["thinkingLevelMap"]["high"], "high");
        assert!(claude["thinkingLevelMap"]["medium"].is_null());
        assert!(claude["thinkingLevelMap"].get("off").is_none());
        let mut codex = json!({"id":"codex/gpt"});
        apply_transport(
            &mut codex,
            &json!({"native_endpoints":["/v1/responses","/v1/messages"],"supported_reasoning_levels":[{"effort":"none"},{"effort":"high"}]}),
            Some("http://localhost:3425"),
        );
        assert_eq!(codex["api"], "openai-responses");
        assert_eq!(codex["baseUrl"], "http://localhost:3425/v1");
        assert_eq!(codex["thinkingLevelMap"]["off"], "none");
        let mut group = json!({"id":"group/smart"});
        apply_transport(&mut group, &json!({}), None);
        assert_eq!(group["api"], "openai-completions");
    }
    #[test]
    fn gateway_root_and_adaptive_versions() {
        assert_eq!(
            normalize_magpie_root(Some(" localhost:3425/v1/ ")).unwrap(),
            "http://localhost:3425"
        );
        assert_eq!(
            normalize_magpie_root(Some("https://example.com/gateway/v1")).unwrap(),
            "https://example.com/gateway"
        );
        assert!(normalize_magpie_root(Some("file:///tmp/key")).is_err());
        assert!(!adaptive_thinking("claude-opus-4-5"));
        assert!(adaptive_thinking("claude-opus-4-7"));
        assert!(adaptive_thinking("claude-sonnet-5"));
    }
}
