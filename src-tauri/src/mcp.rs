//! MCP servers as Pi stores them in `~/.pi/agent/mcp.json`. The list view masks
//! every secret; only key names ever leave this module.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::bridge::{agent_dir, read_json_file};

fn mcp_config_path(dir: &std::path::Path) -> PathBuf {
    dir.join("mcp.json")
}

fn valid_mcp_server_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

/// List view of one `mcpServers` entry. Secrets stay on disk: only the keys of
/// `env` and `headers` leave this function.
fn mcp_server_view(name: &str, config: &Value) -> Value {
    let command = config.get("command").and_then(Value::as_str);
    let url = config.get("url").and_then(Value::as_str);
    let transport = if command.is_some() {
        "stdio"
    } else if url.is_some() {
        "http"
    } else {
        "invalid"
    };
    let keys = |field: &str| {
        config
            .get(field)
            .and_then(Value::as_object)
            .map(|map| map.keys().cloned().collect::<Vec<String>>())
            .unwrap_or_default()
    };
    json!({
        "name": name,
        "transport": transport,
        "command": command,
        "args": config.get("args").and_then(Value::as_array).cloned().unwrap_or_default(),
        "url": url,
        "envKeys": keys("env"),
        "headerKeys": keys("headers"),
        "enabled": config.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "exposure": config.get("exposure").and_then(Value::as_str),
        "description": config.get("description").and_then(Value::as_str),
        "timeout": config.get("timeout").and_then(Value::as_f64),
    })
}

fn read_mcp_config(path: &Path) -> Result<Value, String> {
    let config = read_json_file(path.to_path_buf(), "Pi mcp.json")?;
    if !config.is_object() {
        return Err("Pi mcp.json 不是有效配置对象".into());
    }
    Ok(config)
}

fn write_mcp_config(path: &Path, config: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 Pi 配置目录失败：{e}"))?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(config).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Pi mcp.json 失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// `autoEnableCodemode` from an `mcp.json` root. Pi defaults it to `true`, which
/// activates the `codemode` tool as soon as a server with `codemode` exposure
/// connects; Orbit's default is off so codemode is opt-in through the
/// Capabilities switch instead of appearing in every session.
fn mcp_auto_codemode(config: &Value) -> bool {
    config
        .get("autoEnableCodemode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Write Orbit's default into an existing `mcp.json` that does not set
/// `autoEnableCodemode`. An explicit user value is kept, and a missing file is
/// left alone (no servers means nothing would be auto-activated). Returns
/// whether the file changed.
pub(crate) fn ensure_mcp_auto_codemode_default(dir: &Path) -> Result<bool, String> {
    let path = mcp_config_path(dir);
    if !path.exists() {
        return Ok(false);
    }
    let mut root = read_mcp_config(&path)?;
    let object = root.as_object_mut().ok_or("Pi mcp.json 不是有效配置对象")?;
    if object.contains_key("autoEnableCodemode") {
        return Ok(false);
    }
    object.insert("autoEnableCodemode".into(), Value::Bool(false));
    let _ = fs::copy(&path, dir.join("mcp.json.pi-gui.bak"));
    write_mcp_config(&path, &root)?;
    Ok(true)
}

/// Server names with stored OAuth credentials, from Pi's `mcp-auth.json`.
fn mcp_authenticated_servers(dir: &Path) -> Vec<String> {
    read_json_file(dir.join("mcp-auth.json"), "Pi mcp-auth.json")
        .ok()
        .and_then(|value| value.as_object().map(|map| map.keys().cloned().collect()))
        .unwrap_or_default()
}

#[tauri::command]
pub fn list_mcp_servers() -> Result<Value, String> {
    let dir = agent_dir()?;
    let path = mcp_config_path(&dir);
    let config = path.exists().then(|| read_mcp_config(&path)).transpose()?;
    let servers = config
        .as_ref()
        .and_then(|value| value.get("mcpServers"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut views: Vec<Value> = servers
        .iter()
        .map(|(name, entry)| mcp_server_view(name, entry))
        .collect();
    views.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(right.get("name").and_then(Value::as_str).unwrap_or_default())
    });
    Ok(json!({
        "path": path,
        "servers": views,
        "authenticated": mcp_authenticated_servers(&dir),
        "autoEnableCodemode": config.as_ref().map(mcp_auto_codemode).unwrap_or(false),
    }))
}

#[tauri::command]
pub fn save_mcp_server(name: String, config: Value) -> Result<Value, String> {
    if !valid_mcp_server_name(&name) {
        return Err("MCP 服务器名只能包含字母、数字、-、_".into());
    }
    let Some(entry) = config.as_object() else {
        return Err("MCP 服务器配置必须是对象".into());
    };
    if entry.get("command").and_then(Value::as_str).is_none()
        && entry.get("url").and_then(Value::as_str).is_none()
    {
        return Err("MCP 服务器需要 command（stdio）或 url（HTTP）".into());
    }
    if let Some(server_type) = entry.get("type").and_then(Value::as_str) {
        if !matches!(server_type, "stdio" | "http" | "streamable-http") {
            return Err(format!("不支持的 MCP type：{server_type}"));
        }
    }
    if entry.get("sse").is_some() {
        return Err("Pi 不支持旧版 SSE 传输，请改用 streamable HTTP 的 url".into());
    }
    let dir = agent_dir()?;
    let path = mcp_config_path(&dir);
    let mut root = if path.exists() {
        read_mcp_config(&path)?
    } else {
        json!({})
    };
    if path.exists() {
        let _ = fs::copy(&path, dir.join("mcp.json.pi-gui.bak"));
    }
    if !root.is_object() {
        root = json!({});
    }
    {
        let object = root.as_object_mut().unwrap();
        // Orbit 的默认值跟着第一次写入落地，之后由设置面板显式开关。
        object
            .entry("autoEnableCodemode")
            .or_insert(Value::Bool(false));
    }
    let servers = root
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    servers[name.as_str()] = Value::Object(entry.clone());
    write_mcp_config(&path, &root)?;
    Ok(mcp_server_view(&name, &config))
}

#[tauri::command]
pub fn delete_mcp_server(name: String) -> Result<Value, String> {
    if !valid_mcp_server_name(&name) {
        return Err("MCP 服务器名只能包含字母、数字、-、_".into());
    }
    let dir = agent_dir()?;
    let path = mcp_config_path(&dir);
    if !path.exists() {
        return Err(format!("MCP 服务器不存在：{name}"));
    }
    let mut root = read_mcp_config(&path)?;
    let removed = root
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .and_then(|servers| servers.remove(&name))
        .is_some();
    if !removed {
        return Err(format!("MCP 服务器不存在：{name}"));
    }
    let _ = fs::copy(&path, dir.join("mcp.json.pi-gui.bak"));
    write_mcp_config(&path, &root)?;
    Ok(json!({"name": name, "deleted": true}))
}

#[tauri::command]
pub fn set_mcp_auto_codemode(enabled: bool) -> Result<Value, String> {
    let dir = agent_dir()?;
    let path = mcp_config_path(&dir);
    let mut root = if path.exists() {
        let _ = fs::copy(&path, dir.join("mcp.json.pi-gui.bak"));
        read_mcp_config(&path)?
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }
    root.as_object_mut()
        .unwrap()
        .insert("autoEnableCodemode".into(), Value::Bool(enabled));
    write_mcp_config(&path, &root)?;
    Ok(json!({"autoEnableCodemode": enabled}))
}

#[tauri::command]
pub fn mcp_config_location() -> Result<Value, String> {
    let dir = agent_dir()?;
    Ok(json!({
        "path": mcp_config_path(&dir),
        "authPath": dir.join("mcp-auth.json"),
        "logPath": dir.join("mcp.log"),
    }))
}

#[cfg(test)]
mod mcp_config_tests {
    use super::*;

    fn temporary_dir(label: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("pi-gui-{label}-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn server_names_match_the_pi_grammar() {
        for name in ["filesystem", "my-server", "my_server", "mcp2"] {
            assert!(valid_mcp_server_name(name), "{name} must be accepted");
        }
        for name in ["", "my server", "my/server", "mcp.server", "\u{5de5}\u{5177}"] {
            assert!(!valid_mcp_server_name(name), "{name} must be rejected");
        }
    }

    #[test]
    fn list_views_mask_env_and_header_values() {
        let view = mcp_server_view(
            "filesystem",
            &json!({"command":"npx","args":["-y","server"],"env":{"API_KEY":"secret"},"headers":{"Authorization":"Bearer secret"},"description":"files"}),
        );
        assert_eq!(view["transport"], "stdio");
        assert_eq!(view["envKeys"][0], "API_KEY");
        assert_eq!(view["headerKeys"][0], "Authorization");
        // \u503c\u4e0d\u80fd\u51fa\u73b0\u5728\u5217\u8868\u91cc\uff1a\u754c\u9762\u53ea\u9700\u8981\u77e5\u9053\u6709\u54ea\u4e9b\u5bc6\u94a5\u3002
        assert!(!view.to_string().contains("secret"));
        assert_eq!(mcp_server_view("remote", &json!({"url":"https://example.com/mcp"}))["transport"], "http");
        assert_eq!(mcp_server_view("broken", &json!({"args":[]}))["transport"], "invalid");
        assert_eq!(mcp_server_view("off", &json!({"command":"x","enabled":false}))["enabled"], false);
    }

    #[test]
    fn codemode_is_off_unless_the_config_explicitly_opts_in() {
        let dir = temporary_dir("mcp-codemode");
        let path = mcp_config_path(&dir);
        // 没有 mcp.json 就不写文件：没有服务器就没有东西会被自动激活。
        assert!(!ensure_mcp_auto_codemode_default(&dir).unwrap());
        assert!(!path.exists());
        write_mcp_config(&path, &json!({"mcpServers":{"tempad-dev":{"command":"npx"}}})).unwrap();
        assert!(ensure_mcp_auto_codemode_default(&dir).unwrap());
        assert_eq!(read_mcp_config(&path).unwrap()["autoEnableCodemode"], false);
        // 已经写过就不再改，用户显式打开的值更不会被覆盖。
        assert!(!ensure_mcp_auto_codemode_default(&dir).unwrap());
        write_mcp_config(&path, &json!({"autoEnableCodemode":true,"mcpServers":{}})).unwrap();
        assert!(!ensure_mcp_auto_codemode_default(&dir).unwrap());
        assert!(mcp_auto_codemode(&read_mcp_config(&path).unwrap()));
        assert!(!mcp_auto_codemode(&json!({"mcpServers":{}})));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn config_round_trip_keeps_unrelated_servers() {
        let dir = temporary_dir("mcp-config");
        let path = mcp_config_path(&dir);
        write_mcp_config(&path, &json!({"mcpServers":{"filesystem":{"command":"npx"}}})).unwrap();
        let mut root = read_mcp_config(&path).unwrap();
        root["mcpServers"]["docs"] = json!({"url":"https://example.com/mcp"});
        write_mcp_config(&path, &root).unwrap();
        let stored = read_mcp_config(&path).unwrap();
        assert_eq!(stored["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(stored["mcpServers"]["docs"]["url"], "https://example.com/mcp");
        assert_eq!(mcp_authenticated_servers(&dir), Vec::<String>::new());
        fs::write(dir.join("mcp-auth.json"), r#"{"sentry":{"access":"token"}}"#).unwrap();
        assert_eq!(mcp_authenticated_servers(&dir), vec!["sentry".to_string()]);
        fs::remove_dir_all(dir).unwrap();
    }
}
