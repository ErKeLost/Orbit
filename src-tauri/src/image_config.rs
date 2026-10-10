//! The image-generation endpoint, as data instead of constants.
//!
//! `gui-extension.ts` registers the image provider, and Pi's own provider config
//! cannot hold one: `models.json`'s model schema has no `type` discriminant, and
//! an image model needs one plus an implementation keyed by `api`
//! (`docs/custom-provider.md` in the Pi package). So the endpoint, its models and
//! its size presets live in this file, and the extension merges them over its
//! built-in Ark defaults.
//!
//! Three properties are what make that safe, and all three are load-bearing:
//!
//! * **Every key is optional.** An absent key means "keep the built-in", so an
//!   unconfigured install behaves exactly as it did before this file could name a
//!   provider, and a half-filled one changes only what it names.
//! * **A write is a patch.** The settings page changes one field at a time, so
//!   saving a default model must not delete the endpoint that is stored beside
//!   it. Absent means "leave it", explicit `null` means "clear it".
//! * **Nothing here is a credential.** The key stays in Pi's `auth.json`, under
//!   the configured provider id, so Pi resolves it exactly as it does for every
//!   other provider. This file is plain config and is written unencrypted.

use serde_json::{json, Map, Value};
use std::path::PathBuf;

use crate::bridge;

/// Model ids, resolutions and aspects all end up in a tool schema the model
/// reads. These are the ceilings that keep a pasted list from producing a tool
/// description nobody can afford.
const MAX_MODELS: usize = 32;
const MAX_RESOLUTIONS: usize = 8;
const MAX_ASPECTS: usize = 16;
const MAX_PARAMS: usize = 32;

/// The provider the extension registers when the file names none.
///
/// Duplicated from `gui-extension.ts` on purpose and guarded by a test on each
/// side: both have to agree on which `auth.json` entry the unconfigured case
/// reads, and the page has to be able to answer that without a live Pi.
pub const DEFAULT_ARK_PROVIDER_ID: &str = "volcengine";

/// The provider id is a key in Pi's `auth.json`, so it follows the same grammar
/// the Providers page enforces.
fn valid_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn trimmed(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// A URL the image implementation can concatenate `/images/generations` onto.
fn http_url(value: &str) -> bool {
    match value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    {
        Some(rest) => !rest.is_empty() && !rest.starts_with('/') && !rest.contains(char::is_whitespace),
        None => false,
    }
}

pub fn image_config_path() -> Result<PathBuf, String> {
    Ok(bridge::agent_dir()?.join("image.json"))
}

/// Only the keys this module understands survive a read, so a hand-edited file
/// cannot smuggle a field the extension would then silently ignore.
fn normalized(stored: &Value) -> Value {
    let mut out = Map::new();
    let object = stored.as_object();
    for key in ["provider", "models", "sizes"] {
        if let Some(value) = object.and_then(|object| object.get(key)) {
            if value.is_object() || value.is_array() {
                out.insert(key.into(), value.clone());
            }
        }
    }
    // The flat form is what this file held before it could name a provider, and
    // what the settings page wrote until the file grew `defaults`. Read either
    // way; the next save moves it under `defaults`.
    let mut defaults = object
        .and_then(|object| object.get("defaults"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(object) = object {
        for key in ["model", "resolution", "aspect"] {
            if let Some(value) = object.get(key).and_then(trimmed) {
                defaults.entry(key).or_insert(Value::String(value));
            }
        }
    }
    defaults.retain(|_, value| trimmed(value).is_some());
    if !defaults.is_empty() {
        out.insert("defaults".into(), Value::Object(defaults));
    }
    // Always present, including for a file that is missing or unreadable: "no
    // file" is a fact the page needs, not an absent field to guess at.
    out.insert("configured".into(), Value::Bool(!out.is_empty()));
    Value::Object(out)
}

fn provider_for(stored: &Value) -> String {
    stored
        .get("provider")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_ARK_PROVIDER_ID)
        .to_owned()
}

/// What is stored, plus whether Pi can currently resolve a key for it.
///
/// The page needs both: the file says what was chosen, and `auth.json` says
/// whether that choice can generate anything yet.
#[tauri::command]
pub async fn image_config() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stored = image_config_path()
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| normalized(&value))
            .unwrap_or_else(|| normalized(&Value::Null));
        let provider = provider_for(&stored);
        let mut config = stored;
        config["defaultProviderId"] = Value::String(DEFAULT_ARK_PROVIDER_ID.into());
        config["hasApiKey"] = Value::Bool(provider_has_key(&provider));
        Ok(config)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_stored() -> Value {
    image_config_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| normalized(&value))
        .unwrap_or_else(|| normalized(&Value::Null))
}

fn provider_has_key(provider: &str) -> bool {
    let Ok(dir) = bridge::agent_dir() else {
        return false;
    };
    std::fs::read_to_string(dir.join("auth.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|auth| bridge::stored_api_key(&auth, provider))
        .is_some()
}

/// Apply a patch to the image endpoint and persist the result.
///
/// The order matters and is the whole design: validate the shape of what was
/// sent, merge it over what is stored, and only then check the cross-field rules
/// — because a patch that sets one default can only be judged against the models
/// and sizes that are already on disk.
#[tauri::command]
pub async fn save_image_config(config: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let patch = validate_patch(&config)?;
        let merged = merge(&read_stored(), &patch);
        check_consistency(&merged)?;
        let path = image_config_path()?;
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

/// Store the key for the configured provider where Pi reads keys.
///
/// Extracted so the image page and the Providers page cannot disagree about the
/// shape of an `auth.json` entry; the file mode is part of that shape.
#[tauri::command]
pub async fn save_image_api_key(provider: String, api_key: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let provider = provider.trim().to_owned();
        if !valid_provider_id(&provider) {
            return Err("Provider ID 只能包含字母、数字、-、_、.".into());
        }
        bridge::store_provider_api_key(&provider, api_key.as_deref())?;
        Ok(json!({"provider": provider, "hasApiKey": provider_has_key(&provider)}))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Structural validation of one patch. Nothing here looks at what is stored.
///
/// A key whose value is `null` is a request to clear it and survives as `null`,
/// which is what keeps "clear the endpoint" distinguishable from "I did not
/// mention the endpoint".
fn validate_patch(input: &Value) -> Result<Value, String> {
    let object = input
        .as_object()
        .ok_or_else(|| "图片配置必须是一个对象".to_string())?;
    let mut out = Map::new();

    if let Some(value) = object.get("provider") {
        if value.is_null() {
            out.insert("provider".into(), Value::Null);
        } else {
            let provider = value
                .as_object()
                .ok_or_else(|| "provider 必须是对象".to_string())?;
            let id = provider
                .get("id")
                .and_then(trimmed)
                .ok_or_else(|| "provider.id 不能为空".to_string())?;
            if !valid_provider_id(&id) {
                return Err("Provider ID 只能包含字母、数字、-、_、.".into());
            }
            let mut clean = Map::new();
            clean.insert("id".into(), Value::String(id));
            if let Some(name) = provider.get("name").and_then(trimmed) {
                clean.insert("name".into(), Value::String(name));
            }
            if let Some(base) = provider.get("baseUrl").and_then(trimmed) {
                let base = base.trim_end_matches('/').to_owned();
                if !http_url(&base) {
                    return Err("provider.baseUrl 必须是 http(s) 地址".into());
                }
                clean.insert("baseUrl".into(), Value::String(base));
            }
            out.insert("provider".into(), Value::Object(clean));
        }
    }

    if let Some(value) = object.get("models") {
        if value.is_null() {
            out.insert("models".into(), Value::Null);
        } else {
            out.insert("models".into(), validated_models(value)?);
        }
    }

    if let Some(value) = object.get("sizes") {
        if value.is_null() {
            out.insert("sizes".into(), Value::Null);
        } else {
            out.insert("sizes".into(), validated_sizes(value)?);
        }
    }

    // The flat form is accepted on write as well as on read: it is what the
    // settings page sends for a single default, and folding it here is what lets
    // the next save migrate the file instead of dropping the value.
    let mut defaults = object
        .get("defaults")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if object.get("defaults").is_some_and(Value::is_null) {
        out.insert("defaults".into(), Value::Null);
        return Ok(Value::Object(out));
    }
    for key in ["model", "resolution", "aspect"] {
        if let Some(value) = object.get(key).and_then(trimmed) {
            defaults.insert(key.into(), Value::String(value));
        }
    }
    if !defaults.is_empty() {
        let mut clean = Map::new();
        for key in ["model", "resolution", "aspect"] {
            if let Some(value) = defaults.get(key).and_then(trimmed) {
                clean.insert(key.into(), Value::String(value));
            }
        }
        out.insert("defaults".into(), Value::Object(clean));
    }

    Ok(Value::Object(out))
}

fn validated_models(value: &Value) -> Result<Value, String> {
    let models = value.as_array().ok_or_else(|| "models 必须是数组".to_string())?;
    if models.is_empty() {
        return Err("models 不能为空数组；传 null 表示恢复内置模型".into());
    }
    if models.len() > MAX_MODELS {
        return Err(format!("models 最多 {MAX_MODELS} 个"));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut clean = Vec::new();
    for entry in models {
        let entry = entry
            .as_object()
            .ok_or_else(|| "models 的每一项必须是对象".to_string())?;
        let id = entry
            .get("id")
            .and_then(trimmed)
            .ok_or_else(|| "models[].id 不能为空".to_string())?;
        if seen.contains(&id) {
            return Err(format!("模型 id 重复：{id}"));
        }
        let mut item = Map::new();
        item.insert("id".into(), Value::String(id.clone()));
        if let Some(name) = entry.get("name").and_then(trimmed) {
            item.insert("name".into(), Value::String(name));
        }
        // A model may carry its own size table and its own extra parameters. The
        // endpoint has no way to describe either — OpenAI's `/models` has no
        // "parameter schema" concept at all — so the file is where they live.
        // Unknown keys are still dropped: a hand-edited file must not smuggle in
        // a field the extension would then silently ignore.
        if let Some(sizes) = entry.get("sizes") {
            item.insert("sizes".into(), validated_sizes(sizes)?);
        }
        if let Some(params) = entry.get("params") {
            item.insert("params".into(), validated_params(params)?);
        }
        // What the endpoint said about this model, cached so the tool schema can
        // use it without a request. Not authoritative — `catalog` is.
        for key in ["taskTypes", "inputModalities"] {
            if let Some(values) = entry.get(key) {
                item.insert(key.into(), validated_string_list(values, &format!("models[].{key}"))?);
            }
        }
        seen.push(id);
        clean.push(Value::Object(item));
    }
    Ok(Value::Array(clean))
}

/// One model's extra parameters.
///
/// The shape is `{ type, enum, min, max, default, description }` and the extension
/// is the only consumer, so this is a whitelist rather than a schema: anything it
/// does not understand is dropped instead of being passed on to be ignored.
fn validated_params(value: &Value) -> Result<Value, String> {
    let params = value
        .as_object()
        .ok_or_else(|| "models[].params 必须是对象".to_string())?;
    if params.len() > MAX_PARAMS {
        return Err(format!("models[].params 最多 {MAX_PARAMS} 个"));
    }
    let mut clean = Map::new();
    for (name, spec) in params {
        let name = name.trim();
        if name.is_empty() {
            return Err("models[].params 的参数名不能为空".into());
        }
        let spec = spec
            .as_object()
            .ok_or_else(|| format!("models[].params.{name} 必须是对象"))?;
        let mut item = Map::new();
        if let Some(kind) = spec.get("type").and_then(trimmed) {
            if !["string", "integer", "number", "boolean"].contains(&kind.as_str()) {
                return Err(format!("models[].params.{name}.type 不支持：{kind}"));
            }
            item.insert("type".into(), Value::String(kind));
        }
        if let Some(values) = spec.get("enum") {
            item.insert(
                "enum".into(),
                validated_string_list(values, &format!("models[].params.{name}.enum"))?,
            );
        }
        for bound in ["min", "max"] {
            if let Some(number) = spec.get(bound).and_then(Value::as_f64) {
                item.insert(bound.into(), json!(number));
            }
        }
        if let Some(default) = spec.get("default") {
            if default.is_string() || default.is_number() || default.is_boolean() {
                item.insert("default".into(), default.clone());
            }
        }
        if let Some(description) = spec.get("description").and_then(trimmed) {
            item.insert("description".into(), Value::String(description));
        }
        clean.insert(name.into(), Value::Object(item));
    }
    Ok(Value::Object(clean))
}

/// A non-empty list of distinct non-empty strings.
///
/// Empty is refused rather than kept: `[]` reads as "this model has no
/// capabilities", which is never what someone meant to write, and the way to clear
/// the field is `null`.
fn validated_string_list(value: &Value, what: &str) -> Result<Value, String> {
    let items = value.as_array().ok_or_else(|| format!("{what} 必须是数组"))?;
    let mut seen: Vec<&str> = Vec::new();
    for item in items {
        let item = item
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| format!("{what} 的每一项必须是非空字符串"))?;
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    if seen.is_empty() {
        return Err(format!("{what} 不能为空数组；传 null 表示清除"));
    }
    Ok(Value::Array(
        seen.into_iter().map(|item| Value::String(item.to_owned())).collect(),
    ))
}

fn validated_sizes(value: &Value) -> Result<Value, String> {
    let sizes = value.as_object().ok_or_else(|| "sizes 必须是对象".to_string())?;
    if sizes.is_empty() || sizes.len() > MAX_RESOLUTIONS {
        return Err(format!("sizes 需要 1 到 {MAX_RESOLUTIONS} 档分辨率"));
    }
    let mut clean = Map::new();
    for (resolution, aspects) in sizes {
        let resolution = resolution.trim();
        if resolution.is_empty() {
            return Err("sizes 的分辨率名不能为空".into());
        }
        let aspects = aspects
            .as_object()
            .ok_or_else(|| format!("sizes.{resolution} 必须是对象"))?;
        if aspects.is_empty() || aspects.len() > MAX_ASPECTS {
            return Err(format!("sizes.{resolution} 需要 1 到 {MAX_ASPECTS} 个画幅"));
        }
        let mut clean_aspects = Map::new();
        for (aspect, size) in aspects {
            let aspect = aspect.trim();
            let size = trimmed(size).ok_or_else(|| format!("sizes.{resolution}.{aspect} 不能为空"))?;
            clean_aspects.insert(aspect.to_owned(), Value::String(size));
        }
        clean.insert(resolution.to_owned(), Value::Object(clean_aspects));
    }
    Ok(Value::Object(clean))
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
    out.retain(|_, value| !value.as_object().is_some_and(Map::is_empty));
    Value::Object(out)
}

/// The rules that only make sense once the patch and the file are one thing.
///
/// A default pointing at a model or a resolution that does not exist fails at
/// generation time with a message about no available model, which is a worse
/// place to find out than the form that typed it.
fn check_consistency(config: &Value) -> Result<(), String> {
    let defaults = config.get("defaults").and_then(Value::as_object);
    let Some(defaults) = defaults else {
        return Ok(());
    };
    if let (Some(model), Some(models)) = (
        defaults.get("model").and_then(Value::as_str),
        config.get("models").and_then(Value::as_array),
    ) {
        let known = models
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(model));
        if !known {
            return Err(format!("defaults.model 不在 models 里：{model}"));
        }
    }
    let Some(sizes) = config.get("sizes").and_then(Value::as_object) else {
        return Ok(());
    };
    if let Some(resolution) = defaults.get("resolution").and_then(Value::as_str) {
        let Some(aspects) = sizes.get(resolution) else {
            return Err(format!("defaults.resolution 不是 sizes 里的一档：{resolution}"));
        };
        if let Some(aspect) = defaults.get("aspect").and_then(Value::as_str) {
            if !aspects.as_object().is_some_and(|map| map.contains_key(aspect)) {
                return Err(format!("defaults.aspect 不是 {resolution} 里的一个画幅：{aspect}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_with_provider() -> Value {
        normalized(&json!({
            "provider": {"id": "my-endpoint", "name": "我的出图", "baseUrl": "https://img.test/v1"},
            "models": [{"id": "a", "name": "A"}, {"id": "b"}],
        }))
    }

    fn saved(stored: &Value, patch: Value) -> Value {
        let merged = merge(stored, &validate_patch(&patch).expect("patch should validate"));
        check_consistency(&merged).expect("merged config should be consistent");
        normalized(&merged)
    }

    fn refused(patch: Value) -> String {
        validate_patch(&patch).expect_err("patch should be refused")
    }

    #[test]
    fn an_empty_patch_changes_nothing() {
        let stored = stored_with_provider();
        assert_eq!(saved(&stored, json!({})), stored);
    }

    #[test]
    fn a_write_is_a_patch_so_one_field_cannot_delete_another() {
        // The settings page sends one field at a time. Saving a default model
        // must not delete the endpoint stored beside it — which is exactly what
        // a whole-file replacement would have done.
        let stored = stored_with_provider();
        let after = saved(&stored, json!({"model": "b"}));
        assert_eq!(after["provider"]["id"], json!("my-endpoint"));
        assert_eq!(after["models"].as_array().map(Vec::len), Some(2));
        assert_eq!(after["defaults"], json!({"model": "b"}));
    }

    #[test]
    fn null_clears_and_absence_keeps() {
        let stored = saved(&stored_with_provider(), json!({"model": "b"}));
        let cleared = saved(&stored, json!({"provider": null}));
        assert!(cleared.get("provider").is_none());
        assert_eq!(cleared["models"].as_array().map(Vec::len), Some(2));
        // …and clearing a default the models no longer have to match.
        let cleared = saved(&cleared, json!({"models": null, "defaults": null}));
        assert!(cleared.get("models").is_none());
        assert!(cleared.get("defaults").is_none());
    }

    #[test]
    fn an_empty_list_is_refused_because_null_is_how_you_ask_for_the_builtins() {
        assert_eq!(refused(json!({"models": []})), "models 不能为空数组；传 null 表示恢复内置模型");
    }

    #[test]
    fn the_flat_form_the_settings_page_sends_migrates_into_defaults() {
        let after = saved(&stored_with_provider(), json!({"model": "a", "resolution": "2K"}));
        assert_eq!(after["defaults"], json!({"model": "a", "resolution": "2K"}));
        assert!(after.get("model").is_none());
    }

    #[test]
    fn an_existing_flat_file_is_read_as_defaults() {
        let stored = normalized(&json!({"model": "doubao-seedream-4-5-251128", "resolution": "4K", "aspect": "16:9"}));
        assert_eq!(
            stored["defaults"],
            json!({"model": "doubao-seedream-4-5-251128", "resolution": "4K", "aspect": "16:9"})
        );
        assert_eq!(stored["configured"], json!(true));
    }

    #[test]
    fn unknown_keys_never_survive_a_read_or_a_write() {
        assert!(normalized(&json!({"apiKey": "nope"})).get("apiKey").is_none());
        assert!(saved(&json!({}), json!({"apiKey": "nope"})).get("apiKey").is_none());
    }

    #[test]
    fn a_provider_id_is_a_key_in_auth_json_so_it_is_checked() {
        assert!(valid_provider_id("volcengine"));
        assert!(valid_provider_id("my-images.v2"));
        assert!(!valid_provider_id(""));
        assert!(!valid_provider_id("has space"));
        assert!(!valid_provider_id("has/slash"));
        assert!(!valid_provider_id(&"x".repeat(65)));
        assert_eq!(refused(json!({"provider": {"id": "has space"}})), "Provider ID 只能包含字母、数字、-、_、.");
        assert_eq!(refused(json!({"provider": {}})), "provider.id 不能为空");
    }

    #[test]
    fn a_base_url_must_be_reachable_by_a_plain_fetch() {
        assert!(http_url("https://ark.cn-beijing.volces.com/api/v3"));
        assert!(http_url("http://127.0.0.1:8080/v1"));
        assert!(!http_url("ark.example.com"));
        assert!(!http_url("ftp://example.com"));
        assert!(!http_url("https://"));
        assert!(!http_url("https:///path"));
        assert!(!http_url("https://img.test/a b"));
        assert_eq!(refused(json!({"provider": {"id": "a", "baseUrl": "ark.example.com"}})), "provider.baseUrl 必须是 http(s) 地址");
    }

    #[test]
    fn a_base_url_is_stored_without_its_trailing_slash() {
        let after = saved(&json!({}), json!({"provider": {"id": "a", "baseUrl": "https://img.test/v1//"}}));
        assert_eq!(after["provider"]["baseUrl"], json!("https://img.test/v1"));
    }

    #[test]
    fn a_duplicate_model_id_would_make_the_tool_ambiguous() {
        assert_eq!(refused(json!({"models": [{"id": "a"}, {"id": "a"}]})), "模型 id 重复：a");
    }

    #[test]
    fn the_lists_are_bounded_because_they_reach_a_tool_schema() {
        let models: Vec<Value> = (0..MAX_MODELS + 1).map(|index| json!({"id": format!("m{index}")})).collect();
        assert_eq!(refused(json!({ "models": models })), format!("models 最多 {MAX_MODELS} 个"));
        assert!(refused(json!({"sizes": {}})).contains("1 到 8 档分辨率"));
        assert!(refused(json!({"sizes": {"2K": {}}})).contains("1 到 16 个画幅"));
        assert_eq!(refused(json!({"sizes": {"2K": {"1:1": "  "}}})), "sizes.2K.1:1 不能为空");
    }

    #[test]
    fn consistency_is_checked_against_the_merged_file_not_the_patch() {
        // The patch names only a default; the models it has to match are already
        // on disk, so this rule cannot live in the patch validator.
        let stored = stored_with_provider();
        let merged = merge(&stored, &validate_patch(&json!({"model": "gone"})).unwrap());
        assert_eq!(check_consistency(&merged).unwrap_err(), "defaults.model 不在 models 里：gone");
        // …and with no model list stored, any default stands: it is the built-in
        // case, where the extension decides what exists.
        let merged = merge(&json!({}), &validate_patch(&json!({"model": "anything"})).unwrap());
        assert!(check_consistency(&merged).is_ok());
    }

    /// 一个模型的私有尺寸表与私有参数必须活过一次保存。
    ///
    /// 它们没有别的地方可去：OpenAI 的 `/models` 根本没有「参数 schema」这个概念，
    /// 所以文件就是它们唯一的家。而 `validated_models` 是个白名单 —— 在白名单里漏掉
    /// 一个键，它的表现不是报错，是**配置存进去就被静默抹掉**。
    #[test]
    fn a_models_own_sizes_and_params_survive_a_save() {
        let stored = normalized(&json!({
            "provider": {"id": "my-endpoint", "baseUrl": "https://img.test/v1"},
            "models": [{"id": "a"}],
        }));
        let after = saved(
            &stored,
            json!({"models": [{
                "id": "a",
                "name": "A",
                "sizes": {"1K": {"1:1": "1024x1024"}, "4K": {"1:1": "4096x4096", "21:9": "6240x2656"}},
                "params": {
                    "sequential_image_generation": {"enum": ["disabled", "auto"], "default": "disabled"},
                    "max_images": {"type": "integer", "min": 1, "max": 15},
                },
                "taskTypes": ["TextToImage", "ImageToImage"],
                "inputModalities": ["text", "image"],
            }]}),
        );
        let model = &after["models"][0];
        assert_eq!(model["sizes"]["4K"]["21:9"], "6240x2656");
        assert_eq!(model["params"]["max_images"]["max"], 15.0);
        assert_eq!(model["params"]["sequential_image_generation"]["enum"][1], "auto");
        assert_eq!(model["taskTypes"][1], "ImageToImage");
        assert_eq!(model["inputModalities"][0], "text");
    }

    /// 白名单以两种方式生效，而它们不同：看不懂的**类型**要响亮地拒绝（写它的人
    /// 显然想表达什么），看不懂的**字段**则丢掉（它可能只是更早/更晚版本的残留）。
    #[test]
    fn an_unsupported_param_type_is_refused_but_an_unknown_field_is_dropped() {
        assert!(refused(json!({"models": [{"id": "a", "params": {"p": {"type": "not-a-type"}}}]}))
            .contains("不支持：not-a-type"));

        let after = saved(
            &stored_with_provider(),
            json!({"models": [{"id": "a", "params": {"p": {"type": "integer", "extra": 1}}}]}),
        );
        let params = &after["models"][0]["params"]["p"];
        assert_eq!(params["type"], "integer");
        assert!(params["extra"].is_null(), "an unknown field must not survive");
    }

    /// 空数组会被读成「这个模型没有任何能力」，那不是任何人的本意 —— 清除字段用 null。
    #[test]
    fn an_empty_capability_list_is_refused() {
        assert!(refused(json!({"models": [{"id": "a", "taskTypes": []}]})).contains("不能为空数组"));
    }

    #[test]
    fn a_default_aspect_has_to_belong_to_its_resolution() {
        let stored = normalized(&json!({"sizes": {"2K": {"1:1": "2048x2048"}, "4K": {"3:4": "3520x4704"}}}));
        let merged = merge(&stored, &validate_patch(&json!({"resolution": "4K", "aspect": "1:1"})).unwrap());
        assert_eq!(check_consistency(&merged).unwrap_err(), "defaults.aspect 不是 4K 里的一个画幅：1:1");
    }

    #[test]
    fn a_cleared_provider_is_not_reported_as_configured() {
        assert_eq!(normalized(&Value::Null)["configured"], json!(false));
        assert_eq!(normalized(&json!({"provider": {"id": "volcengine"}}))["configured"], json!(true));
    }

    #[test]
    fn the_builtin_provider_id_matches_the_extension() {
        // Both sides decide which `auth.json` entry the unconfigured case reads.
        let extension = std::fs::read_to_string("resources/gui-extension.ts")
            .expect("gui-extension.ts is a bundled resource");
        assert!(
            extension.contains(&format!("id:'{DEFAULT_ARK_PROVIDER_ID}'"))
                || extension.contains(&format!("id: \"{DEFAULT_ARK_PROVIDER_ID}\"")),
            "gui-extension.ts no longer registers {DEFAULT_ARK_PROVIDER_ID}"
        );
    }

    #[test]
    fn the_merge_never_leaves_an_empty_object_behind() {
        assert_eq!(saved(&stored_with_provider(), json!({"defaults": {}})).get("defaults"), None);
    }
}
