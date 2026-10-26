//! Provider catalogues: the models a configured provider exposes, the metadata
//! normalisation that turns every vendor's shape into one, and the writes into
//! Pi's own `models.json` / `auth.json`.
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};
use tauri::AppHandle;

use crate::bridge::{
    agent_dir, home_dir, read_json_file, settings_path, write_private_json, RuntimePaths,
};

fn valid_provider_id(provider: &str) -> bool {
    !provider.is_empty()
        && provider
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn complete_model_cost(model: &mut Value) -> usize {
    let Some(cost) = model.get_mut("cost").and_then(Value::as_object_mut) else {
        return 0;
    };
    let mut changed = 0;
    for field in ["input", "output", "cacheRead", "cacheWrite"] {
        if !cost.contains_key(field) {
            cost.insert(field.into(), Value::from(0.0));
            changed += 1;
        }
    }
    if let Some(tiers) = cost.get_mut("tiers").and_then(Value::as_array_mut) {
        for tier in tiers {
            let Some(tier) = tier.as_object_mut() else {
                continue;
            };
            for field in ["input", "output", "cacheRead", "cacheWrite"] {
                if !tier.contains_key(field) {
                    tier.insert(field.into(), Value::from(0.0));
                    changed += 1;
                }
            }
        }
    }
    changed
}

pub(crate) fn repair_custom_model_costs(dir: &std::path::Path) -> Result<usize, String> {
    let path = dir.join("models.json");
    if !path.exists() {
        return Ok(0);
    }
    let mut config = read_json_file(path.clone(), "Pi models.json")?;
    let mut changed = 0;
    if let Some(providers) = config.get_mut("providers").and_then(Value::as_object_mut) {
        for provider in providers.values_mut() {
            if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
                for model in models {
                    changed += complete_model_cost(model);
                }
            }
        }
    }
    if changed > 0 {
        let backup = dir.join("models.json.pi-gui.bak");
        if !backup.exists() {
            fs::copy(&path, backup).map_err(|e| format!("备份 Pi models.json 失败：{e}"))?;
        }
        fs::write(
            &path,
            serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("写入 Pi models.json 失败：{e}"))?;
    }
    Ok(changed)
}

async fn fetch_model_catalog(
    base_url: &str,
    models_url: Option<&str>,
    api_key: &str,
    api: &str,
    auth_header: bool,
) -> Result<Value, String> {
    let base_url = base_url.trim_end_matches('/');
    if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
        return Err("Base URL 必须是 HTTP(S) 地址".into());
    }
    let endpoint = models_url
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| format!("{base_url}/models"));
    if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
        return Err("模型列表接口必须是 HTTP(S) 地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let request = client.get(endpoint);
    let request = if api_key.is_empty() || !auth_header {
        request
    } else if api == "anthropic-messages" {
        request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(api_key)
    };
    let response = request
        .send()
        .await
        .map_err(|e| format!("模型目录请求失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("模型目录返回错误：{e}"))?;
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("模型目录响应不是有效 JSON：{e}"))
}

// ==================== 模型元数据归一化 ====================
// 单一管道：models.dev 目录是基础事实层，provider 接口返回的字段直接覆盖其上。
// 各家目录格式的字段别名（OpenRouter、Vercel Gateway、OpenAI/Anthropic 官方、各类中转站）
// 只在 normalize_provider_model 一处处理；价格统一为美元/百万 tokens。

#[derive(Default)]
struct ModelMeta {
    name: Option<String>,
    context_window: Option<u64>,
    max_output_tokens: Option<u64>,
    input_modalities: Option<Vec<String>>,
    output_modalities: Option<Vec<String>>,
    reasoning: Option<bool>,
    thinking_levels: Option<Vec<(String, String)>>,
    pricing: Option<serde_json::Map<String, Value>>,
}

fn meta_strings(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    })?;
    (!items.is_empty()).then_some(items)
}

/// 十进制字面量精确移位："0.0000001" ×1e6 → 0.1（f64 乘法会产生 0.09999999999999999）。
/// 返回 None 表示不是纯十进制字面量，调用方回退到 parse + 乘法。
fn decimal_scaled(text: &str, places: usize) -> Option<f64> {
    let text = text.trim();
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (int_part, frac_part) = match text.split_once('.') {
        Some((int_part, frac_part)) => (int_part, frac_part),
        None => (text, ""),
    };
    if !int_part
        .bytes()
        .chain(frac_part.bytes())
        .all(|byte| byte.is_ascii_digit())
        || int_part.is_empty() && frac_part.is_empty()
    {
        return None;
    }
    let mut digits = String::with_capacity(int_part.len() + frac_part.len() + places);
    digits.push_str(int_part);
    digits.push_str(frac_part);
    let point = int_part.len() + places;
    while digits.len() < point {
        digits.push('0');
    }
    let value = if point >= digits.len() {
        digits.parse::<f64>().ok()?
    } else {
        let (head, tail) = digits.split_at(point);
        format!("{head}.{tail}").parse::<f64>().ok()?
    };
    Some(if negative { -value } else { value })
}

/// pricing/cost 对象 → 统一「美元/百万 tokens」费率。
/// 字符串价格是 per-token 十进制字面量（OpenRouter），直接移位 ×1e6；
/// 数字价格已是 per-M（models.dev）或按 scale 放大。
fn meta_pricing(
    pricing: &Value,
    rates: &[(&str, &str)],
    scale: f64,
) -> Option<serde_json::Map<String, Value>> {
    let object = pricing.as_object()?;
    let mut cost = serde_json::Map::from_iter(
        ["input", "output", "cacheRead", "cacheWrite"]
            .map(|field| (field.to_string(), Value::from(0.0))),
    );
    let mut known = false;
    for (source, target) in rates {
        let Some(raw) = object.get(*source) else {
            continue;
        };
        let value = match raw {
            Value::Number(number) => number.as_f64().map(|value| value * scale),
            Value::String(text) => decimal_scaled(text, 6)
                .or_else(|| text.parse::<f64>().ok().map(|value| value * scale)),
            _ => None,
        };
        if let Some(value) = value {
            cost.insert((*target).to_string(), Value::from(value));
            known = true;
        }
    }
    known.then_some(cost)
}

/// 目录条目里的模态字段：OpenRouter 用 architecture.{dir}_modalities，
/// 部分目录用顶层 {dir}_modalities 或 modalities.{dir}。
fn meta_modalities(item: &Value, direction: &str) -> Option<Vec<String>> {
    meta_strings(
        item.get("architecture")
            .and_then(|value| value.get(format!("{direction}_modalities"))),
    )
    .or_else(|| meta_strings(item.get(format!("{direction}_modalities"))))
    .or_else(|| {
        meta_strings(
            item.get("modalities")
                .and_then(|value| value.get(direction)),
        )
    })
}

/// capability_tags（部分中转站只提供 tags）推导模态。
fn meta_modalities_from_tags(item: &Value, direction: &str) -> Option<Vec<String>> {
    let tags = meta_strings(item.get("capability_tags"))?;
    let mut modalities = Vec::new();
    if tags
        .iter()
        .any(|tag| matches!(tag.as_str(), "chat" | "text" | "completion"))
    {
        modalities.push("text".to_string());
    }
    let image = if direction == "input" {
        tags.iter()
            .any(|tag| matches!(tag.as_str(), "vision" | "image" | "image_input"))
    } else {
        tags.iter().any(|tag| tag == "image_generation")
    };
    if image {
        modalities.push("image".to_string());
    }
    (!modalities.is_empty()).then_some(modalities)
}

/// provider 目录条目 → 规范元数据。
fn normalize_provider_model(item: &Value) -> ModelMeta {
    let mut meta = ModelMeta {
        name: item
            .get("name")
            .or_else(|| item.get("display_name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        context_window: item
            .get("context_length")
            .or_else(|| item.get("context_window"))
            .and_then(Value::as_u64),
        max_output_tokens: item
            .get("max_output_tokens")
            .or_else(|| item.get("max_tokens"))
            .and_then(Value::as_u64),
        input_modalities: meta_modalities(item, "input")
            .or_else(|| meta_modalities_from_tags(item, "input")),
        output_modalities: meta_modalities(item, "output")
            .or_else(|| meta_modalities_from_tags(item, "output")),
        reasoning: item.get("reasoning").and_then(Value::as_bool),
        thinking_levels: None,
        pricing: item.get("pricing").and_then(|pricing| {
            meta_pricing(
                pricing,
                &[
                    ("prompt", "input"),
                    ("completion", "output"),
                    ("input_cache_read", "cacheRead"),
                    ("input_cache_write", "cacheWrite"),
                ],
                1_000_000.0,
            )
        }),
    };
    if meta.reasoning.is_none() {
        if let Some(levels) = meta_strings(
            item.get("reasoning")
                .and_then(|value| value.get("supported_efforts")),
        ) {
            meta.reasoning = Some(true);
            meta.thinking_levels = Some(
                levels
                    .into_iter()
                    .map(|level| (level.clone(), level))
                    .collect(),
            );
        }
    }
    meta
}

/// models.dev 条目 → 规范元数据（cost 本身就是美元/百万 tokens）。
fn normalize_modelsdev_model(entry: &Value) -> ModelMeta {
    ModelMeta {
        name: entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        context_window: entry
            .get("limit")
            .and_then(|limit| limit.get("context"))
            .and_then(Value::as_u64),
        max_output_tokens: entry
            .get("limit")
            .and_then(|limit| limit.get("output"))
            .and_then(Value::as_u64),
        input_modalities: meta_strings(
            entry.get("modalities").and_then(|value| value.get("input")),
        ),
        output_modalities: meta_strings(
            entry
                .get("modalities")
                .and_then(|value| value.get("output")),
        ),
        reasoning: entry.get("reasoning").and_then(Value::as_bool),
        thinking_levels: None,
        pricing: entry.get("cost").and_then(|cost| {
            meta_pricing(
                cost,
                &[
                    ("input", "input"),
                    ("output", "output"),
                    ("cache_read", "cacheRead"),
                    ("cache_write", "cacheWrite"),
                ],
                1.0,
            )
        }),
    }
}

/// 用 models.dev 的数据填充接口未返回的字段。
fn merge_meta(base: &mut ModelMeta, fill: ModelMeta) {
    base.name = base.name.take().or(fill.name);
    base.context_window = base.context_window.take().or(fill.context_window);
    base.max_output_tokens = base.max_output_tokens.take().or(fill.max_output_tokens);
    base.input_modalities = base.input_modalities.take().or(fill.input_modalities);
    base.output_modalities = base.output_modalities.take().or(fill.output_modalities);
    base.reasoning = base.reasoning.take().or(fill.reasoning);
    base.thinking_levels = base.thinking_levels.take().or(fill.thinking_levels);
    base.pricing = base.pricing.take().or(fill.pricing);
}

impl ModelMeta {
    fn to_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        if let Some(name) = &self.name {
            value.insert("name".into(), Value::from(name.as_str()));
        }
        if let Some(context_window) = self.context_window {
            value.insert("context_window".into(), Value::from(context_window));
        }
        if let Some(max_output_tokens) = self.max_output_tokens {
            value.insert("max_output_tokens".into(), Value::from(max_output_tokens));
        }
        if let Some(inputs) = &self.input_modalities {
            value.insert("input_modalities".into(), json!(inputs));
        }
        if let Some(outputs) = &self.output_modalities {
            value.insert("output_modalities".into(), json!(outputs));
        }
        if let Some(reasoning) = self.reasoning {
            value.insert("reasoning".into(), Value::from(reasoning));
        }
        if let Some(levels) = &self.thinking_levels {
            value.insert(
                "thinking_levels".into(),
                Value::Object(
                    levels
                        .iter()
                        .map(|(key, level)| (key.clone(), Value::from(level.as_str())))
                        .collect(),
                ),
            );
        }
        if let Some(pricing) = &self.pricing {
            value.insert("pricing".into(), Value::Object(pricing.clone()));
        }
        Value::Object(value)
    }
}

/// models.dev 目录的进程内缓存（TTL 1 小时）。拉取失败时元数据留空，不阻塞模型列表。
static MODELSDEV_CACHE: Mutex<Option<(std::time::Instant, Value)>> = Mutex::new(None);

const MODELSDEV_TTL: Duration = Duration::from_secs(60 * 60);

async fn modelsdev_catalog() -> Option<Value> {
    if let Some((at, catalog)) = MODELSDEV_CACHE.lock().ok().and_then(|guard| guard.clone()) {
        if at.elapsed() < MODELSDEV_TTL {
            return Some(catalog);
        }
    }
    let catalog = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?
        .get("https://models.dev/api.json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Value>()
        .await
        .ok()?;
    if catalog.as_object().is_some() {
        if let Ok(mut guard) = MODELSDEV_CACHE.lock() {
            *guard = Some((std::time::Instant::now(), catalog.clone()));
        }
        return Some(catalog);
    }
    None
}

fn modelsdev_model<'a>(models: &'a Value, id: &str) -> Option<&'a Value> {
    if let Some(entry) = models.get(id) {
        return Some(entry);
    }
    // OpenRouter 等目录用 "z-ai/glm-4.6" 这类带前缀的 id，models.dev 按 "glm-4.6" 索引
    let short = id.rsplit('/').next()?;
    (short != id).then(|| models.get(short)).flatten()
}

fn normalized_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn normalized_endpoint(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// 只根据运行时配置和目录自身的数据定位模型，不维护厂商或域名映射表。
fn modelsdev_lookup<'a>(
    catalog: &'a Value,
    provider: &str,
    base_url: &str,
    id: &str,
) -> Option<&'a Value> {
    let providers = catalog.as_object()?;
    let endpoint = normalized_endpoint(base_url);
    let provider_id = normalized_identifier(provider);
    let namespace = id
        .split_once('/')
        .map(|(prefix, _)| normalized_identifier(prefix));
    let matches_identity = |key: &str, item: &Value, expected: &str| {
        normalized_identifier(key) == expected
            || item
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|value| normalized_identifier(value) == expected)
    };
    let model = |item: &'a Value| {
        item.get("models")
            .and_then(|models| modelsdev_model(models, id))
    };

    providers
        .iter()
        .find_map(|(_, item)| {
            item.get("api")
                .and_then(Value::as_str)
                .filter(|api| normalized_endpoint(api) == endpoint)
                .and_then(|_| model(item))
        })
        .or_else(|| {
            providers.iter().find_map(|(key, item)| {
                matches_identity(key, item, &provider_id)
                    .then(|| model(item))
                    .flatten()
            })
        })
        .or_else(|| {
            namespace.as_deref().and_then(|namespace| {
                providers.iter().find_map(|(key, item)| {
                    matches_identity(key, item, namespace)
                        .then(|| model(item))
                        .flatten()
                })
            })
        })
}

/// 模型目录归一化管道：provider 接口字段优先，缺失字段由 models.dev 补齐，
/// 输出统一规范条目（id + 元数据 + raw 原始条目）。
async fn normalized_model_catalog(
    provider: &str,
    base_url: &str,
    models_url: Option<&str>,
    api_key: &str,
    api: &str,
    auth_header: bool,
    context_window: Option<u64>,
) -> Result<Value, String> {
    let raw = fetch_model_catalog(base_url, models_url, api_key, api, auth_header).await?;
    let dev = modelsdev_catalog().await;
    let Some(items) = raw.get("data").and_then(Value::as_array) else {
        return Ok(raw);
    };
    let mut data = Vec::with_capacity(items.len());
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let mut meta = normalize_provider_model(item);
        let context = meta.context_window.filter(|value| *value > 0).or(context_window).unwrap_or(128000);
        if let Some(entry) = dev
            .as_ref()
            .and_then(|dev| modelsdev_lookup(dev, provider, base_url, id))
        {
            merge_meta(&mut meta, normalize_modelsdev_model(entry));
        }
        meta.context_window = Some(context);
        let mut entry = meta.to_json();
        entry["id"] = Value::from(id);
        entry["raw"] = item.clone();
        data.push(entry);
    }
    Ok(json!({"object": "list", "data": data}))
}

/// 规范条目 → Pi models.json 模型条目（sync 用）。Pi 会据此驱动上下文窗口与 token 预算。
fn pi_model_from_meta(entry: &Value) -> Option<Value> {
    let id = entry.get("id").and_then(Value::as_str)?.to_string();
    let mut model = json!({"id": id});
    if let Some(name) = entry.get("name").and_then(Value::as_str) {
        model["name"] = Value::from(name);
    }
    let input = entry
        .get("input_modalities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| *value == "text" || *value == "image")
                .map(Value::from)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !input.is_empty() {
        model["input"] = Value::Array(input);
    }
    if let Some(context) = entry
        .get("context_window")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
    {
        model["contextWindow"] = Value::from(context);
    }
    if let Some(max_tokens) = entry
        .get("max_output_tokens")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
    {
        model["maxTokens"] = Value::from(max_tokens);
    }
    if let Some(reasoning) = entry.get("reasoning").and_then(Value::as_bool) {
        model["reasoning"] = Value::from(reasoning);
    }
    if let Some(levels) = entry
        .get("thinking_levels")
        .and_then(Value::as_object)
        .filter(|levels| !levels.is_empty())
    {
        model["reasoning"] = Value::from(true);
        model["thinkingLevelMap"] = Value::Object(levels.clone());
    }
    if let Some(pricing) = entry.get("pricing").and_then(Value::as_object) {
        let mut cost = serde_json::Map::from_iter(
            ["input", "output", "cacheRead", "cacheWrite"]
                .map(|field| (field.to_string(), Value::from(0.0))),
        );
        for (key, value) in pricing {
            cost.insert(key.clone(), value.clone());
        }
        model["cost"] = Value::Object(cost);
    }
    Some(model)
}

/// Fill missing model capabilities without overriding explicit server metadata.
fn apply_provider_defaults(model: &mut Value, defaults: &Value) {
    if model.get("contextWindow").is_none() {
        model["contextWindow"] = json!(defaults["contextWindow"].as_u64().unwrap_or(128000));
    }
    // Effort levels are per model: a provider can serve models with very
    // different ladders, so nothing is inferred from the provider alone.
    let Some(levels) = model
        .get("id")
        .and_then(Value::as_str)
        .and_then(|id| defaults["modelEfforts"].get(id))
        .and_then(|entry| entry.get("levels"))
        .and_then(Value::as_array)
        .filter(|levels| !levels.is_empty())
    else {
        return;
    };
    // Explicit configuration is authoritative. Null disables every unselected
    // level; omitting keys would let Pi fall back to inferred defaults.
    let mut map = json!({"off":null,"minimal":null,"low":null,"medium":null,"high":null,"xhigh":null,"max":null});
    if let Some(existing) = model.get("thinkingLevelMap").and_then(Value::as_object) {
        for (key, value) in existing {
            map[key] = value.clone();
        }
    }
    for level in levels.iter().filter_map(Value::as_str) {
        map[level] = json!(level);
    }
    model["reasoning"] = json!(true);
    model["thinkingLevelMap"] = map;
}

fn provider_store_path(dir: &std::path::Path) -> PathBuf {
    dir.join("pi-gui-providers.json")
}

fn load_provider_store(dir: &std::path::Path) -> Result<Value, String> {
    let path = provider_store_path(dir);
    if path.exists() {
        read_json_file(path, "Orbit Provider 配置")
    } else {
        Ok(json!({"providers": {}}))
    }
}

fn write_provider_store(dir: &std::path::Path, store: &Value) -> Result<(), String> {
    write_private_json(&provider_store_path(dir), store)
}

/// Write, or clear, one provider's key in Pi's `auth.json`.
///
/// The location, the entry shape and the file mode are one decision, so they
/// live in one function: the Providers page and the image page both store keys
/// here, and neither should be able to disagree with the other about what Pi
/// will later read.
///
/// `None` or blank deletes the entry. Callers that mean "leave it alone" say so
/// themselves — `save_provider` does, because clearing a key there is what
/// deleting the provider is for.
pub(crate) fn store_provider_api_key(provider: &str, api_key: Option<&str>) -> Result<(), String> {
    let dir = agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 Pi 配置目录：{e}"))?;
    let auth_path = dir.join("auth.json");
    let mut auth = if auth_path.exists() {
        read_json_file(auth_path.clone(), "Pi auth.json")?
    } else {
        json!({})
    };
    match api_key.map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => {
            auth[provider] = json!({"type":"api_key","key":key});
        }
        None => {
            let Some(object) = auth.as_object_mut() else {
                return Err("Pi auth.json 不是对象".into());
            };
            object.remove(provider);
        }
    }
    write_private_json(&auth_path, &auth)
}

pub(crate) fn stored_api_key(auth: &Value, provider: &str) -> Option<String> {
    auth.get(provider)
        .and_then(|item| item.get("key"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn supported_api(api: &str) -> bool {
    matches!(
        api,
        "openai-completions"
            | "openai-responses"
            | "anthropic-messages"
            | "google-generative-ai"
            | "azure-openai-responses"
            | "mistral-conversations"
    )
}

#[tauri::command]
pub async fn discover(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home_dir()?;
        let runtime = RuntimePaths::resolve(&app, &home)?;
        Ok(runtime.diagnostics(&home))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Query the OpenAI-compatible provider catalog configured in Pi's own files.
/// The API key is read and used only inside this process and is never returned.
#[tauri::command]
pub async fn list_provider_models(provider: String) -> Result<Value, String> {
    let dir = agent_dir()?;
    let models = read_json_file(dir.join("models.json"), "Pi models.json")?;
    let provider_config = models
        .get("providers")
        .and_then(|items| items.get(&provider))
        .ok_or_else(|| format!("Pi 未配置 provider：{provider}"))?;
    let base_url = provider_config
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or("该 provider 没有 baseUrl")?;
    let auth = read_json_file(dir.join("auth.json"), "Pi auth.json").unwrap_or_else(|_| json!({}));
    let api = provider_config
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    let auth_header = provider_config
        .get("authHeader")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let models_url = provider_config.get("modelsUrl").and_then(Value::as_str);
    let store = load_provider_store(&dir)?;
    let context_window = store["providers"][&provider]["contextWindow"].as_u64();
    normalized_model_catalog(
        &provider,
        base_url,
        models_url,
        &stored_api_key(&auth, &provider).unwrap_or_default(),
        api,
        auth_header,
        context_window,
    )
    .await
}

#[tauri::command]
pub async fn list_provider_profiles() -> Result<Value, String> {
    let dir = agent_dir()?;
    let models = read_json_file(dir.join("models.json"), "Pi models.json")
        .unwrap_or_else(|_| json!({"providers": {}}));
    let auth = read_json_file(dir.join("auth.json"), "Pi auth.json").unwrap_or_else(|_| json!({}));
    let settings =
        read_json_file(dir.join("settings.json"), "Pi settings.json").unwrap_or_else(|_| json!({}));
    let default_provider = settings.get("defaultProvider").and_then(Value::as_str);
    let default_model = settings.get("defaultModel").and_then(Value::as_str);
    let store = load_provider_store(&dir).unwrap_or_else(|_| json!({"providers": {}}));
    let mut ids = std::collections::BTreeSet::new();
    if let Some(providers) = models.get("providers").and_then(Value::as_object) {
        ids.extend(providers.keys().cloned());
    }
    if let Some(providers) = store.get("providers").and_then(Value::as_object) {
        ids.extend(providers.keys().cloned());
    }
    let profiles = ids.into_iter().map(|id| {
        let config = models.get("providers").and_then(|items| items.get(&id)).unwrap_or(&Value::Null);
        let saved = store.get("providers").and_then(|items| items.get(&id)).unwrap_or(&Value::Null);
        json!({
            "id": id,
            "name": saved.get("name").and_then(Value::as_str).or_else(|| config.get("name").and_then(Value::as_str)),
            "baseUrl": saved.get("baseUrl").and_then(Value::as_str).or_else(|| config.get("baseUrl").and_then(Value::as_str)),
            "modelsUrl": saved.get("modelsUrl").and_then(Value::as_str).or_else(|| config.get("modelsUrl").and_then(Value::as_str)),
            "api": saved.get("api").and_then(Value::as_str).or_else(|| config.get("api").and_then(Value::as_str)),
            "authHeader": saved.get("authHeader").and_then(Value::as_bool).or_else(|| config.get("authHeader").and_then(Value::as_bool)),
            "contextWindow": saved.get("contextWindow"),
            "modelEfforts": saved.get("modelEfforts"),
            "isDefault": default_provider == Some(id.as_str()),
            "defaultModel": if default_provider == Some(id.as_str()) { default_model } else { saved.get("defaultModel").and_then(Value::as_str) },
            "models": config.get("models").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "hasApiKey": stored_api_key(&auth, &id).is_some(),
            "modelCount": config.get("models").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
        })
    }).collect::<Vec<_>>();
    Ok(Value::Array(profiles))
}

#[tauri::command]
pub async fn probe_provider_models(
    provider: String,
    base_url: String,
    api: String,
    api_key: Option<String>,
    auth_header: bool,
    models_url: Option<String>,
    context_window: Option<u64>,
) -> Result<Value, String> {
    if !valid_provider_id(&provider) {
        return Err("Provider ID 只能包含字母、数字、-、_、.".into());
    }
    if !supported_api(&api) {
        return Err("不支持的 Pi API 类型".into());
    }
    let dir = agent_dir()?;
    let auth = read_json_file(dir.join("auth.json"), "Pi auth.json").unwrap_or_else(|_| json!({}));
    let key = api_key
        .filter(|value| !value.trim().is_empty())
        .or_else(|| stored_api_key(&auth, &provider))
        .unwrap_or_default();
    normalized_model_catalog(
        &provider,
        &base_url,
        models_url.as_deref(),
        &key,
        &api,
        auth_header,
        context_window.filter(|value| *value > 0),
    )
    .await
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "the Tauri command mirrors the provider form field by field"
)]
pub async fn save_provider(
    provider: String,
    name: Option<String>,
    base_url: String,
    models_url: Option<String>,
    api: String,
    api_key: Option<String>,
    auth_header: bool,
    context_window: Option<u64>,
    default_effort: Option<String>,
    model_efforts: Option<Value>,
) -> Result<Value, String> {
    if context_window == Some(0) {
        return Err("上下文长度必须大于 0".into());
    }
    let model_efforts = model_efforts.unwrap_or_else(|| json!({}));
    if !model_efforts.is_object() && !model_efforts.is_null() {
        return Err("模型 Effort 配置格式不正确".into());
    }
    if let Some(models) = model_efforts.as_object() {
        for (id, entry) in models {
            let levels = entry
                .get("levels")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            if levels.iter().any(|level| !matches!(*level, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")) {
                return Err(format!("{id} 包含不支持的 Effort 档位"));
            }
            if let Some(level) = entry.get("default").and_then(Value::as_str) {
                if !levels.contains(&level) {
                    return Err(format!("{id} 的默认 Effort 不在其支持档位中"));
                }
            }
        }
    }
    let _ = default_effort;
    if !valid_provider_id(&provider) {
        return Err("Provider ID 只能包含字母、数字、-、_、.".into());
    }
    if !supported_api(&api) {
        return Err("不支持的 Pi API 类型".into());
    }
    let dir = agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 Pi 配置目录：{e}"))?;
    let path = dir.join("models.json");
    let mut config = if path.exists() {
        read_json_file(path.clone(), "Pi models.json")?
    } else {
        json!({"providers": {}})
    };
    let providers = config
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or("Pi models.json 缺少 providers 对象")?;
    let mut provider_config = providers
        .get(&provider)
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !provider_config.is_object() {
        provider_config = json!({});
    }
    provider_config["baseUrl"] = Value::from(base_url.trim_end_matches('/'));
    if let Some(value) = models_url.as_ref().filter(|value| !value.trim().is_empty()) {
        provider_config["modelsUrl"] = Value::from(value.trim_end_matches('/'));
    } else {
        provider_config
            .as_object_mut()
            .map(|object| object.remove("modelsUrl"));
    }
    provider_config["api"] = Value::from(api.clone());
    provider_config["authHeader"] = Value::from(auth_header);
    if let Some(value) = name.as_ref().filter(|value| !value.trim().is_empty()) {
        provider_config["name"] = Value::from(value.as_str());
    }
    providers.insert(provider.clone(), provider_config);
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Pi models.json 失败：{e}"))?;
    if let Some(key) = api_key.as_ref().filter(|value| !value.trim().is_empty()) {
        // Deliberately not `store_provider_api_key(&provider, None)` for a blank
        // key: an empty field on the Providers page means "leave the stored key
        // alone", and clearing one there is what deleting the provider is for.
        store_provider_api_key(&provider, Some(key))?;
    }
    let mut store = load_provider_store(&dir)?;
    let providers = store
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or("Provider 配置缺少 providers 对象")?;
    let previous_key = providers
        .get(&provider)
        .and_then(|value| value.get("apiKey"))
        .cloned();
    let previous_default_model = providers
        .get(&provider)
        .and_then(|value| value.get("defaultModel"))
        .cloned();
    let normalized_models_url = models_url
        .as_deref()
        .map(|value| value.trim().trim_end_matches('/'))
        .filter(|value| !value.is_empty());
    let mut entry = json!({"name":name,"baseUrl":base_url.trim_end_matches('/'),"modelsUrl":normalized_models_url,"api":api,"authHeader":auth_header});
    entry["contextWindow"] = json!(context_window);
    entry["modelEfforts"] = model_efforts;
    if let Some(key) = api_key
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| Value::from(value.as_str()))
        .or(previous_key)
    {
        entry["apiKey"] = key;
    }
    if let Some(model) = previous_default_model {
        entry["defaultModel"] = model;
    }
    providers.insert(provider.clone(), entry);
    write_provider_store(&dir, &store)?;
    Ok(
        json!({"id":provider,"hasApiKey": read_json_file(dir.join("auth.json"), "Pi auth.json").ok().and_then(|auth| stored_api_key(&auth, &provider)).is_some()}),
    )
}

#[tauri::command]
pub fn delete_provider(provider: String) -> Result<Value, String> {
    if !valid_provider_id(&provider) {
        return Err("Provider ID 只能包含字母、数字、-、_.".into());
    }
    let dir = agent_dir()?;
    let models_path = dir.join("models.json");
    let auth_path = dir.join("auth.json");
    let settings_path = settings_path(&dir);
    let mut models = models_path.exists().then(|| read_json_file(models_path.clone(), "Pi models.json")).transpose()?;
    let mut auth = auth_path.exists().then(|| read_json_file(auth_path.clone(), "Pi auth.json")).transpose()?;
    let mut store = load_provider_store(&dir)?;
    let mut settings = settings_path.exists().then(|| read_json_file(settings_path.clone(), "Pi settings.json")).transpose()?;
    let models_removed = models.as_mut().and_then(|value| value.get_mut("providers")).and_then(Value::as_object_mut).and_then(|items| items.remove(&provider)).is_some();
    let auth_removed = auth.as_mut().and_then(Value::as_object_mut).and_then(|items| items.remove(&provider)).is_some();
    let store_removed = store.get_mut("providers").and_then(Value::as_object_mut).and_then(|items| items.remove(&provider)).is_some();
    let default_removed = settings.as_ref().and_then(|value| value.get("defaultProvider")).and_then(Value::as_str) == Some(provider.as_str());
    if !(models_removed || auth_removed || store_removed || default_removed) {
        return Err(format!("Provider 不存在：{provider}"));
    }
    if default_removed {
        if let Some(object) = settings.as_mut().and_then(Value::as_object_mut) {
            object.remove("defaultProvider");
            object.remove("defaultModel");
        }
    }
    if models_removed {
        fs::write(&models_path, serde_json::to_string_pretty(&models).map_err(|e| e.to_string())? + "\n")
            .map_err(|e| format!("写入 Pi models.json 失败：{e}"))?;
    }
    if auth_removed {
        fs::write(&auth_path, serde_json::to_string_pretty(&auth).map_err(|e| e.to_string())? + "\n")
            .map_err(|e| format!("写入 Pi auth.json 失败：{e}"))?;
    }
    if store_removed { write_provider_store(&dir, &store)?; }
    if default_removed {
        fs::write(&settings_path, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n")
            .map_err(|e| format!("写入 Pi settings.json 失败：{e}"))?;
    }
    Ok(json!({"id": provider, "deleted": true}))
}

#[tauri::command]
pub async fn sync_provider_models(provider: String) -> Result<Value, String> {
    let catalog = list_provider_models(provider.clone()).await?;
    let remote = catalog
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if remote.is_empty() {
        return Err("模型目录缺少 data 数组或没有模型".into());
    }
    let dir = agent_dir()?;
    let path = dir.join("models.json");
    let mut config = read_json_file(path.clone(), "Pi models.json")?;
    let provider_config = config
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .and_then(|items| items.get_mut(&provider))
        .ok_or_else(|| format!("Pi 未配置 provider：{provider}"))?;
    let existing = provider_config
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let store = load_provider_store(&dir)?;
    let defaults = &store["providers"][&provider];
    let models = remote
        .iter()
        .filter_map(pi_model_from_meta)
        .map(|mut model| { apply_provider_defaults(&mut model, defaults); model })
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Err("模型目录没有可同步的模型".into());
    }
    provider_config["models"] = Value::Array(models.clone());
    let backup = path.with_extension("json.bak");
    let _ = fs::copy(&path, backup);
    let serialized = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n";
    fs::write(&path, serialized).map_err(|e| format!("写入 Pi models.json 失败：{e}"))?;
    let first_model_id = models
        .first()
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str);
    Ok(
        json!({"provider":provider,"count":models.len(),"previous":existing.len(),"firstModelId":first_model_id}),
    )
}

fn set_default_model_in(
    dir: &std::path::Path,
    provider: String,
    model_id: String,
) -> Result<Value, String> {
    if !valid_provider_id(&provider) || model_id.trim().is_empty() {
        return Err("Provider 和模型 ID 不能为空".into());
    }
    let models_path = dir.join("models.json");
    let mut models = read_json_file(models_path.clone(), "Pi models.json")?;
    let provider_config = models
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .and_then(|providers| providers.get_mut(&provider))
        .ok_or_else(|| format!("Pi 未配置 provider：{provider}"))?;
    if !provider_config.get("models").is_some_and(Value::is_array) {
        provider_config["models"] = Value::Array(Vec::new());
    }
    let model_list = provider_config
        .get_mut("models")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("Pi provider 没有模型列表：{provider}"))?;
    let exists = model_list
        .iter()
        .any(|model| model.get("id").and_then(Value::as_str) == Some(model_id.as_str()));
    if !exists {
        let store = load_provider_store(dir)?;
        let mut model = json!({"id": model_id, "input": ["text"]});
        apply_provider_defaults(&mut model, &store["providers"][&provider]);
        model_list.push(model);
        fs::write(
            &models_path,
            serde_json::to_string_pretty(&models).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("写入 Pi 自定义模型失败：{e}"))?;
    }

    let path = settings_path(dir);
    let mut settings = if path.exists() {
        read_json_file(path.clone(), "Pi settings.json")?
    } else {
        json!({})
    };
    if !settings.is_object() {
        settings = json!({});
    }
    settings["defaultProvider"] = Value::from(provider.clone());
    settings["defaultModel"] = Value::from(model_id.clone());
    fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Pi 默认模型失败：{e}"))?;
    let mut store = load_provider_store(dir)?;
    if let Some(entry) = store.get_mut("providers").and_then(Value::as_object_mut).and_then(|providers| providers.get_mut(&provider)) {
        entry["defaultModel"] = Value::from(model_id.clone());
        write_provider_store(dir, &store)?;
    }
    Ok(json!({"provider":provider,"id":model_id}))
}

#[tauri::command]
pub fn set_default_model(provider: String, model_id: String) -> Result<Value, String> {
    set_default_model_in(&agent_dir()?, provider, model_id)
}

#[cfg(test)]
mod default_model_tests {
    use super::*;

    #[test]
    fn persists_default_model_without_losing_other_settings() {
        let dir = std::env::temp_dir().join(format!("pi-gui-model-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("models.json"),
            r#"{"providers":{"llmgate":{"models":[{"id":"codex-auto-review"}]}}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"theme":"dark","defaultProvider":"jamerly","defaultModel":"old"}"#,
        )
        .unwrap();

        set_default_model_in(&dir, "llmgate".into(), "codex-auto-review".into()).unwrap();
        let settings = read_json_file(dir.join("settings.json"), "settings").unwrap();
        assert_eq!(settings["defaultProvider"], "llmgate");
        assert_eq!(settings["defaultModel"], "codex-auto-review");
        assert_eq!(settings["theme"], "dark");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn adds_a_manually_entered_default_model_to_the_provider() {
        let dir =
            std::env::temp_dir().join(format!("pi-gui-manual-model-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("models.json"),
            r#"{"providers":{"relay":{"baseUrl":"https://example.com/v1"}}}"#,
        )
        .unwrap();

        set_default_model_in(&dir, "relay".into(), "private-model-v2".into()).unwrap();
        let models = read_json_file(dir.join("models.json"), "models").unwrap();
        assert_eq!(
            models["providers"]["relay"]["models"][0]["id"],
            "private-model-v2"
        );
        let settings = read_json_file(dir.join("settings.json"), "settings").unwrap();
        assert_eq!(settings["defaultProvider"], "relay");
        assert_eq!(settings["defaultModel"], "private-model-v2");

        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod custom_model_cost_tests {
    use super::*;

    #[test]
    fn repairs_incomplete_costs_that_make_pi_reject_models_json() {
        let dir = std::env::temp_dir().join(format!("pi-gui-cost-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("models.json"), r#"{"providers":{"relay":{"models":[{"id":"a","input":["text","image"],"cost":{"input":1,"output":2}},{"id":"b","input":["text","image"],"cost":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4}}]}}}"#).unwrap();

        assert_eq!(repair_custom_model_costs(&dir).unwrap(), 2);
        let config = read_json_file(dir.join("models.json"), "models").unwrap();
        let models = config["providers"]["relay"]["models"].as_array().unwrap();
        assert_eq!(
            models[0]["cost"],
            json!({"input":1,"output":2,"cacheRead":0.0,"cacheWrite":0.0})
        );
        assert_eq!(
            models[1]["cost"],
            json!({"input":1,"output":2,"cacheRead":3,"cacheWrite":4})
        );
        assert!(dir.join("models.json.pi-gui.bak").exists());
        assert_eq!(repair_custom_model_costs(&dir).unwrap(), 0);

        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod metadata_tests {
    use super::*;

    #[test]
    fn effort_levels_are_configured_per_model() {
        let defaults = json!({
            "contextWindow": 200000,
            "modelEfforts": {
                "sol": {"levels": ["low", "xhigh"], "default": "xhigh"},
                "plain": {"levels": []}
            }
        });
        let mut configured = json!({"id": "sol"});
        apply_provider_defaults(&mut configured, &defaults);
        assert_eq!(configured["contextWindow"], json!(200000));
        assert_eq!(configured["thinkingLevelMap"]["low"], json!("low"));
        assert_eq!(configured["thinkingLevelMap"]["xhigh"], json!("xhigh"));
        assert!(configured["thinkingLevelMap"]["high"].is_null());

        // A model with no configured list keeps whatever it declared itself.
        let mut untouched = json!({"id": "other"});
        apply_provider_defaults(&mut untouched, &defaults);
        assert!(untouched.get("thinkingLevelMap").is_none());
        assert_eq!(untouched["contextWindow"], json!(200000));
    }

    fn dev_catalog() -> Value {
        json!({
            "zhipuai": {"api": "https://open.bigmodel.cn/api/paas/v4", "models": {
                "glm-5": {"name": "GLM-5", "limit": {"context": 204800, "output": 131072}, "modalities": {"input": ["text"], "output": ["text"]}, "reasoning": true, "cost": {"input": 1.0, "output": 3.2, "cache_read": 0.2, "cache_write": 0.0}}
            }},
            "zai": {"models": {"glm-4.6": {"limit": {"context": 204800}}}}
        })
    }

    #[test]
    fn lookup_uses_runtime_endpoint_and_provider_identity() {
        let catalog = dev_catalog();
        assert!(modelsdev_lookup(
            &catalog,
            "Zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5"
        )
        .is_some());
        assert!(
            modelsdev_lookup(&catalog, "z-ai", "https://api.z.ai/api/paas/v4", "glm-4.6").is_some()
        );
        assert!(
            modelsdev_lookup(&catalog, "whatever", "https://example.com/v1", "glm-5").is_none()
        );
        assert!(modelsdev_lookup(
            &catalog,
            "whatever",
            "https://example.com/v1",
            "glm-unknown"
        )
        .is_none());
    }

    #[test]
    fn lookup_resolves_prefixed_model_ids() {
        let catalog = json!({"zai": {"models": {"glm-4.6": {"limit": {"context": 204800}}}}});
        assert!(
            modelsdev_lookup(&catalog, "z-ai", "https://api.z.ai/v1", "z-ai/glm-4.6").is_some()
        );
    }

    #[test]
    fn normalizes_catalog_field_aliases() {
        // OpenRouter 风格：context_length、architecture.input_modalities、per-token 字符串价格
        let item = json!({
            "id": "z-ai/glm-4.6",
            "context_length": 204800,
            "pricing": {"prompt": "0.0000006", "completion": "0.0000022", "input_cache_read": "0.0000001"},
            "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
            "reasoning": {"supported_efforts": ["low", "high"]}
        });
        let meta = normalize_provider_model(&item);
        assert_eq!(meta.context_window, Some(204800));
        assert_eq!(
            meta.input_modalities.as_deref(),
            Some(["text".to_string(), "image".to_string()].as_slice())
        );
        assert_eq!(meta.reasoning, Some(true));
        let json = meta.to_json();
        assert_eq!(json["pricing"]["input"], 0.6);
        assert_eq!(json["pricing"]["output"], 2.2);
        assert_eq!(json["pricing"]["cacheRead"], 0.1);
        assert_eq!(json["thinking_levels"]["high"], "high");

        // Vercel Gateway 风格：context_window/max_tokens、modalities 对象
        let item = json!({
            "id": "glm-5.2",
            "context_window": 1000000,
            "max_tokens": 128000,
            "modalities": {"input": ["text", "image"], "output": ["text"]}
        });
        let meta = normalize_provider_model(&item);
        assert_eq!(meta.context_window, Some(1000000));
        assert_eq!(meta.max_output_tokens, Some(128000));
        assert_eq!(
            meta.input_modalities.as_deref(),
            Some(["text".to_string(), "image".to_string()].as_slice())
        );
    }

    #[test]
    fn merge_fills_only_missing_fields() {
        let item = json!({"id": "glm-5"});
        let mut meta = normalize_provider_model(&item);
        assert_eq!(meta.context_window, None);
        let dev = dev_catalog();
        let entry = modelsdev_lookup(
            &dev,
            "Zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5",
        )
        .unwrap();
        merge_meta(&mut meta, normalize_modelsdev_model(entry));
        assert_eq!(meta.context_window, Some(204800));
        assert_eq!(meta.max_output_tokens, Some(131072));
        assert_eq!(meta.reasoning, Some(true));
        assert_eq!(meta.name.as_deref(), Some("GLM-5"));
        assert_eq!(meta.pricing.as_ref().unwrap()["output"], 3.2);

        // 接口已有值不被覆盖；models.dev 未覆盖的字段保持 None
        let item =
            json!({"id": "glm-5", "context_length": 999, "input_modalities": ["text", "image"]});
        let mut meta = normalize_provider_model(&item);
        let dev = dev_catalog();
        let entry = modelsdev_lookup(
            &dev,
            "Zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5",
        )
        .unwrap();
        merge_meta(&mut meta, normalize_modelsdev_model(entry));
        assert_eq!(meta.context_window, Some(999));
        assert_eq!(
            meta.input_modalities.as_deref(),
            Some(["text".to_string(), "image".to_string()].as_slice())
        );
        assert_eq!(meta.max_output_tokens, Some(131072));
    }

    #[test]
    fn pi_model_from_meta_drives_pi_context() {
        let entry = json!({
            "id": "glm-5",
            "name": "GLM-5",
            "context_window": 204800,
            "max_output_tokens": 131072,
            "input_modalities": ["text"],
            "output_modalities": ["text"],
            "reasoning": true,
            "pricing": {"input": 1.0, "output": 3.2, "cacheRead": 0.2, "cacheWrite": 0.0}
        });
        let model = pi_model_from_meta(&entry).unwrap();
        assert_eq!(model["id"], "glm-5");
        assert_eq!(model["name"], "GLM-5");
        assert_eq!(model["contextWindow"], 204800);
        assert_eq!(model["maxTokens"], 131072);
        assert_eq!(model["input"], json!(["text"]));
        assert_eq!(model["reasoning"], true);
        assert_eq!(
            model["cost"],
            json!({"input": 1.0, "output": 3.2, "cacheRead": 0.2, "cacheWrite": 0.0})
        );
        // thinking_levels 非空时开启 reasoning 并写入映射
        let entry = json!({"id": "m", "reasoning": false, "thinking_levels": {"low": "low", "high": "high"}});
        let model = pi_model_from_meta(&entry).unwrap();
        assert_eq!(model["reasoning"], true);
        assert_eq!(model["thinkingLevelMap"]["high"], "high");
    }

    #[test]
    fn pi_model_from_meta_omits_non_positive_limits() {
        let entry = json!({
            "id": "image-model",
            "context_window": 0,
            "max_output_tokens": 0,
            "input_modalities": ["text", "image"]
        });
        let model = pi_model_from_meta(&entry).unwrap();
        assert!(model.get("contextWindow").is_none());
        assert!(model.get("maxTokens").is_none());
    }
}
