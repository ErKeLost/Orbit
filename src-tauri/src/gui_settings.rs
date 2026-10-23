//! The few Pi settings Orbit edits (`settings.json`), the per-project trust mode
//! and the request-budget knobs that decide how much history rides on a turn.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::bridge::{agent_dir, read_json_file, settings_path, write_private_json};

fn project_trust_mode(value: &Value) -> &'static str {
    match value.get("defaultProjectTrust").and_then(Value::as_str) {
        Some("always") => "always",
        Some("never") => "never",
        _ => "ask",
    }
}

#[tauri::command]
pub fn get_project_trust_mode() -> Result<String, String> {
    let dir = agent_dir()?;
    let path = settings_path(&dir);
    if !path.exists() {
        return Ok("ask".into());
    }
    Ok(project_trust_mode(&read_json_file(path, "Pi settings.json")?).into())
}

#[tauri::command]
pub fn set_project_trust_mode(mode: String) -> Result<String, String> {
    if !matches!(mode.as_str(), "ask" | "always" | "never") {
        return Err("无效的项目权限模式".into());
    }
    let dir = agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建 Pi 配置目录失败：{e}"))?;
    let path = settings_path(&dir);
    let mut settings = if path.exists() {
        read_json_file(path.clone(), "Pi settings.json")?
    } else {
        json!({})
    };
    if !settings.is_object() {
        settings = json!({});
    }
    settings["defaultProjectTrust"] = Value::from(mode.clone());
    fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Pi settings.json 失败：{e}"))?;
    Ok(mode)
}

/// Pi settings Orbit can edit. `cacheWarming`, `codemode` and `compaction` only
/// exist in the global settings file, so the GUI needs its own validated write
/// path.
const GUI_SETTING_KEYS: [&str; 3] = ["cacheWarming", "codemode", "compaction"];

/// Pi 1.4: `compaction.reserveTokens` only decides *when* compaction starts.
/// The summary itself now uses the model's output limit. Orbit keeps the two
/// token knobs editable so a 1M-token window can be tuned without hand-editing
/// settings.json, and leaves `modelOverrides` untouched.
const COMPACTION_TOKEN_MAX: u64 = 2_000_000;

fn validate_gui_setting(key: &str, value: &Value) -> Result<(), String> {
    match key {
        "cacheWarming" => match value.as_str() {
            Some("off" | "streaming" | "idle") => Ok(()),
            None if value.is_null() => Ok(()),
            Some(other) => Err(format!("不支持的 cacheWarming：{other}")),
            None => Err("cacheWarming 需要字符串或 null".into()),
        },
        "codemode" => {
            if value.is_null() {
                return Ok(());
            }
            let Some(object) = value.as_object() else {
                return Err("codemode 需要对象或 null".into());
            };
            if let Some(mode) = object.get("mode") {
                match mode.as_str() {
                    Some("on" | "only") => {}
                    _ => return Err("codemode.mode 只能是 on 或 only".into()),
                }
            }
            if let Some(budget) = object.get("inlineBudget") {
                let Some(budget) = budget.as_u64() else {
                    return Err("codemode.inlineBudget 需要非负整数".into());
                };
                if budget > 100_000 {
                    return Err("codemode.inlineBudget 不能超过 100000".into());
                }
            }
            Ok(())
        }
        "compaction" => {
            if value.is_null() {
                return Ok(());
            }
            let Some(object) = value.as_object() else {
                return Err("compaction 需要对象或 null".into());
            };
            for (key, value) in object {
                match key.as_str() {
                    "enabled" => {
                        if !value.is_boolean() {
                            return Err("compaction.enabled 需要 true 或 false".into());
                        }
                    }
                    "reserveTokens" | "keepRecentTokens" => {
                        let Some(tokens) = value.as_u64() else {
                            return Err(format!("compaction.{key} 需要非负整数"));
                        };
                        if tokens > COMPACTION_TOKEN_MAX {
                            return Err(format!("compaction.{key} 不能超过 {COMPACTION_TOKEN_MAX}"));
                        }
                    }
                    // 来源：用户自己的 settings.json。GUI 原样带回来，不解释也不改。
                    "modelOverrides" => {
                        if !value.is_object() {
                            return Err("compaction.modelOverrides 需要对象".into());
                        }
                    }
                    other => return Err(format!("不支持的 compaction 字段：{other}")),
                }
            }
            Ok(())
        }
        other => Err(format!("Orbit 不能修改 Pi 设置 {other}")),
    }
}

#[tauri::command]
pub fn get_gui_settings() -> Result<Value, String> {
    let dir = agent_dir()?;
    let path = settings_path(&dir);
    let settings = path
        .exists()
        .then(|| read_json_file(path.clone(), "Pi settings.json"))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    let mut view = serde_json::Map::new();
    for key in GUI_SETTING_KEYS {
        view.insert(
            key.to_string(),
            settings.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    Ok(json!({"path": path, "settings": Value::Object(view)}))
}

#[tauri::command]
pub fn set_gui_setting(key: String, value: Value) -> Result<Value, String> {
    validate_gui_setting(&key, &value)?;
    let dir = agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建 Pi 配置目录失败：{e}"))?;
    let path = settings_path(&dir);
    let mut settings = if path.exists() {
        read_json_file(path.clone(), "Pi settings.json")?
    } else {
        json!({})
    };
    if !settings.is_object() {
        settings = json!({});
    }
    if value.is_null() {
        settings.as_object_mut().unwrap().remove(&key);
    } else {
        settings[&key] = value.clone();
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Pi settings.json 失败：{e}"))?;
    Ok(json!({"key": key, "value": value}))
}

// --- 请求预算（历史图片上限） ---------------------------------------------
//
// 由 Pi 会话里的 `resources/request-budget.ts` 在每次请求前读取：每张历史图片都会
// 跟着下一轮一起重传，所以「只带最近几张」是首字延迟的设置，不只是网关的体积防线。
const REQUEST_BUDGET_MIN_BYTES: u64 = 512 * 1024;

const REQUEST_BUDGET_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// 非负整数字段及其上限：`maxImages` 是「带几张图」，`keepRecentImages` 是下限。
const REQUEST_BUDGET_COUNTS: [(&str, u64); 2] = [("maxImages", 64), ("keepRecentImages", 32)];

fn request_budget_path(dir: &Path) -> PathBuf {
    dir.join("request-budget.json")
}

/// 可选的非负整数字段：不在就交给 Pi 的默认值，在就必须是 0..=max。
fn request_budget_count(object: &serde_json::Map<String, Value>, key: &str, max: u64) -> Result<(), String> {
    match object.get(key) {
        None => Ok(()),
        Some(value) => match value.as_u64() {
            Some(number) if number <= max => Ok(()),
            Some(_) => Err(format!("{key} 不能超过 {max}")),
            None => Err(format!("{key} 需要非负整数")),
        },
    }
}

fn validate_request_budget(settings: &Value) -> Result<(), String> {
    let Some(object) = settings.as_object() else {
        return Err("请求预算需要是一个对象".into());
    };
    if object.get("enabled").is_some_and(|value| !value.is_boolean()) {
        return Err("enabled 需要 true 或 false".into());
    }
    if let Some(bytes) = object.get("maxRequestBytes") {
        let bytes = bytes.as_u64().ok_or("maxRequestBytes 需要正整数")?;
        if !(REQUEST_BUDGET_MIN_BYTES..=REQUEST_BUDGET_MAX_BYTES).contains(&bytes) {
            return Err("maxRequestBytes 超出可用范围".into());
        }
    }
    for (key, max) in REQUEST_BUDGET_COUNTS {
        request_budget_count(object, key, max)?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_request_budget() -> Result<Value, String> {
    let dir = agent_dir()?;
    let path = request_budget_path(&dir);
    let settings = path
        .exists()
        .then(|| read_json_file(path.clone(), "请求预算 request-budget.json"))
        .transpose()?
        .unwrap_or_else(|| json!({}));
    Ok(json!({ "path": path, "settings": settings }))
}

#[tauri::command]
pub fn save_request_budget(settings: Value) -> Result<Value, String> {
    validate_request_budget(&settings)?;
    let dir = agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 Pi 配置目录：{e}"))?;
    let path = request_budget_path(&dir);
    write_private_json(&path, &settings)?;
    Ok(json!({ "path": path, "settings": settings }))
}

#[cfg(test)]
mod gui_settings_tests {
    use super::*;

    #[test]
    fn cache_warming_accepts_only_the_modes_pi_understands() {
        for mode in ["off", "streaming", "idle"] {
            assert!(validate_gui_setting("cacheWarming", &json!(mode)).is_ok());
        }
        assert!(validate_gui_setting("cacheWarming", &Value::Null).is_ok());
        assert!(validate_gui_setting("cacheWarming", &json!("always")).is_err());
        assert!(validate_gui_setting("cacheWarming", &json!(2)).is_err());
    }

    #[test]
    fn codemode_settings_are_range_checked() {
        assert!(validate_gui_setting("codemode", &json!({"mode":"on","inlineBudget":3000})).is_ok());
        assert!(validate_gui_setting("codemode", &json!({"mode":"only"})).is_ok());
        assert!(validate_gui_setting("codemode", &json!({})).is_ok());
        assert!(validate_gui_setting("codemode", &Value::Null).is_ok());
        assert!(validate_gui_setting("codemode", &json!({"mode":"both"})).is_err());
        assert!(validate_gui_setting("codemode", &json!({"inlineBudget":-1})).is_err());
        assert!(validate_gui_setting("codemode", &json!({"inlineBudget":200000})).is_err());
        assert!(validate_gui_setting("codemode", &json!("only")).is_err());
    }

    #[test]
    fn compaction_settings_keep_only_token_knobs_and_passthrough_overrides() {
        assert!(validate_gui_setting("compaction", &Value::Null).is_ok());
        assert!(validate_gui_setting("compaction", &json!({"reserveTokens":8192,"keepRecentTokens":12000})).is_ok());
        assert!(validate_gui_setting("compaction", &json!({"enabled":false})).is_ok());
        // 0 合法：立刻压缩 / 不保留最近内容。
        assert!(validate_gui_setting("compaction", &json!({"reserveTokens":0,"keepRecentTokens":0})).is_ok());
        assert!(validate_gui_setting("compaction", &json!({"modelOverrides":{"anthropic/claude":{"reserveTokens":1000}}})).is_ok());
        assert!(validate_gui_setting("compaction", &json!({"reserveTokens":-1})).is_err());
        assert!(validate_gui_setting("compaction", &json!({"keepRecentTokens":3000000})).is_err());
        assert!(validate_gui_setting("compaction", &json!({"enabled":"yes"})).is_err());
        assert!(validate_gui_setting("compaction", &json!({"modelOverrides":[]})).is_err());
        assert!(validate_gui_setting("compaction", &json!({"threshold":1})).is_err());
        assert!(validate_gui_setting("compaction", &json!(16384)).is_err());
    }

    #[test]
    fn unknown_settings_are_rejected_instead_of_written() {
        assert!(validate_gui_setting("deviceId", &json!("x")).is_err());
        assert!(validate_gui_setting("defaultProjectTrust", &json!("always")).is_err());
    }

    #[test]
    fn request_budget_ranges_are_checked_before_writing() {
        assert!(validate_request_budget(&json!({})).is_ok());
        assert!(validate_request_budget(&json!({"enabled":false,"maxImages":10,"keepRecentImages":2})).is_ok());
        // 0 是合法的：不按张数裁剪。
        assert!(validate_request_budget(&json!({"maxImages":0})).is_ok());
        assert!(validate_request_budget(&json!({"maxImages":-1})).is_err());
        assert!(validate_request_budget(&json!({"maxImages":1000})).is_err());
        assert!(validate_request_budget(&json!({"keepRecentImages":40})).is_err());
        assert!(validate_request_budget(&json!({"maxRequestBytes":1024})).is_err());
        assert!(validate_request_budget(&json!({"enabled":"yes"})).is_err());
        assert!(validate_request_budget(&json!([])).is_err());
    }
}
