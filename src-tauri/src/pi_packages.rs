//! 扩展包（Pi packages）的本机管理。
//!
//! 设置里的「技能」页之前只有一个禁用按钮，写着「在终端运行 pi install 后刷新」——
//! 安装扩展必须离开应用去开终端。Pi 本身已经有 `install` / `remove` / `update`
//! / `list` 四个命令，这里把它们包成命令：装、卸、更新都走同一个 runtime，
//! 也就是会话用的那一个。
//!
//! 安装会执行 npm/git，可能很久，所以：
//! - 统一超时上限，超时杀进程并返回已有输出；
//! - 输出原样带回界面，失败时用户能看见 npm/git 说了什么；
//! - `pi update --extensions` 的输出被解析成结构化变更（1.6 起逐包给出
//!   `npm:foo 1.2.0 -> 1.3.0`，1.5 只有一行总结），两种格式都接受。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// 装一个 npm 包 + 跑一次 git clone 的合理上限；到点就杀掉，别让界面一直转圈。
const PACKAGE_TIMEOUT: Duration = Duration::from_secs(270);
const MAX_SOURCE_LENGTH: usize = 512;

/// 一次命令的结果：退出码、输出、是否超时。
struct Run {
    ok: bool,
    timed_out: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    elapsed_ms: u64,
}

impl Run {
    fn value(&self) -> Value {
        json!({
            "ok": self.ok,
            "timedOut": self.timed_out,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "elapsedMs": self.elapsed_ms,
        })
    }
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(crate::sessions::agent_dir()?.join("settings.json"))
}

fn read_settings() -> Value {
    settings_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}))
}

/// `settings.json` 的 `packages` 既可以是字符串，也可以是 `{source, autoload, ...}`。
/// 统一成 `{source, autoload}` 再交给界面。
fn packages_from_settings(settings: &Value) -> Vec<Value> {
    settings
        .get("packages")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(source) => Some(json!({ "source": source, "autoload": true })),
                    Value::Object(object) => object
                        .get("source")
                        .and_then(Value::as_str)
                        .map(|source| {
                            json!({
                                "source": source,
                                "autoload": object.get("autoload").and_then(Value::as_bool).unwrap_or(true),
                                "extensions": object.get("extensions"),
                                "skills": object.get("skills"),
                                "prompts": object.get("prompts"),
                                "themes": object.get("themes"),
                            })
                        }),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 把 `pi update --extensions` 的文本变成结构化变更。
///
/// 1.6.0：
/// ```text
/// npm:foo 1.2.0 -> 1.3.0
/// Packages are already up to date
/// ```
/// 1.5.x 只有总结行，所以 `changes` 可能是空的，`status` 仍然可用。
fn parse_update_lines(text: &str) -> (Vec<Value>, String) {
    let mut changes = Vec::new();
    let mut status = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((name, versions)) = line.split_once(' ') {
            if let Some((from, to)) = versions.split_once("->") {
                changes.push(json!({
                    "name": name.trim(),
                    "from": from.trim(),
                    "to": to.trim(),
                }));
                continue;
            }
        }
        if line.starts_with("Packages are already up to date")
            || line.starts_with("No packages were updated")
            || line.starts_with("Skipped package updates")
            || line.starts_with("Updated ")
            || line.starts_with("Installed ")
        {
            status = line.to_string();
        }
    }
    (changes, status)
}

fn validate_source(source: &str) -> Result<String, String> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return Err("请填写扩展源，例如 npm:@foo/bar 或 git:github.com/user/repo".into());
    }
    if source.len() > MAX_SOURCE_LENGTH {
        return Err("扩展源太长".into());
    }
    if source.contains(['\n', '\r', '\0']) {
        return Err("扩展源不能包含换行".into());
    }
    if source.starts_with('-') {
        return Err("扩展源不能以 - 开头".into());
    }
    Ok(source)
}

fn run_pi(app: &tauri::AppHandle, cwd: &Path, args: &[&str]) -> Result<Run, String> {
    let runtime = crate::bridge::RuntimePaths::resolve(app, cwd)?;
    let mut command = runtime.command();
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Pi：{error}"))?;
    let deadline = Instant::now() + PACKAGE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                return Err(format!("等待 Pi 失败：{error}"));
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(Run {
                ok: false,
                timed_out: true,
                exit_code: None,
                stdout: String::new(),
                stderr: format!(
                    "命令在 {} 秒内没有结束（npm/git 可能卡住了）",
                    PACKAGE_TIMEOUT.as_secs()
                ),
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
        std::thread::sleep(Duration::from_millis(60));
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("读取 Pi 输出失败：{error}"))?;
    let limit = 6000;
    Ok(Run {
        ok: output.status.success(),
        timed_out: false,
        exit_code: output.status.code(),
        stdout: crate::bridge::clip_output(&String::from_utf8_lossy(&output.stdout), limit),
        stderr: crate::bridge::clip_output(&String::from_utf8_lossy(&output.stderr), limit),
        elapsed_ms,
    })
}

/// 已安装的扩展：`settings.json` 的结构化条目 + `pi list` 的原始文本
/// （后者是真相，装了但没写进 settings 时会在那里出现）。
#[cfg(desktop)]
#[tauri::command]
pub async fn list_pi_packages(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = read_settings();
        let cwd = crate::bridge::home_dir()?;
        let listing = run_pi(&app, &cwd, &["list"]).ok();
        Ok(json!({
            "packages": packages_from_settings(&settings),
            "skills": settings.get("skills").cloned().unwrap_or_else(|| json!([])),
            "settingsPath": settings_path().ok().map(|path| path.display().to_string()),
            "listing": listing.as_ref().map(|run| run.value()),
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(desktop)]
#[tauri::command]
pub async fn install_pi_package(
    app: tauri::AppHandle,
    source: String,
    local: Option<bool>,
) -> Result<Value, String> {
    let source = validate_source(&source)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::bridge::home_dir()?;
        let mut args = vec!["install", source.as_str()];
        if local.unwrap_or(false) {
            args.push("-l");
        }
        let run = run_pi(&app, &cwd, &args)?;
        Ok(json!({
            "source": source,
            "run": run.value(),
            "packages": packages_from_settings(&read_settings()),
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(desktop)]
#[tauri::command]
pub async fn remove_pi_package(
    app: tauri::AppHandle,
    source: String,
    local: Option<bool>,
) -> Result<Value, String> {
    let source = validate_source(&source)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::bridge::home_dir()?;
        let mut args = vec!["remove", source.as_str()];
        if local.unwrap_or(false) {
            args.push("-l");
        }
        let run = run_pi(&app, &cwd, &args)?;
        Ok(json!({
            "source": source,
            "run": run.value(),
            "packages": packages_from_settings(&read_settings()),
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `pi update --extensions`：只更新已装的扩展，不动 Pi 自己（内置 runtime 由安装包管理）。
#[cfg(desktop)]
#[tauri::command]
pub async fn update_pi_packages(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = crate::bridge::home_dir()?;
        let run = run_pi(&app, &cwd, &["update", "--extensions"])?;
        let text = if run.stderr.is_empty() { &run.stdout } else { &run.stderr };
        let (changes, status) = parse_update_lines(text);
        Ok(json!({
            "run": run.value(),
            "changes": changes,
            "status": status,
            "packages": packages_from_settings(&read_settings()),
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{packages_from_settings, parse_update_lines, validate_source};

    #[test]
    fn accepts_both_package_shapes_from_settings() {
        let settings = serde_json::json!({
            "packages": [
                "npm:@foo/bar",
                {"source": "git:github.com/user/repo", "autoload": false, "skills": ["skills"]},
                42
            ]
        });
        let packages = packages_from_settings(&settings);
        assert_eq!(packages.len(), 2);
        assert_eq!(packages[0]["source"], "npm:@foo/bar");
        assert_eq!(packages[0]["autoload"], true);
        assert_eq!(packages[1]["autoload"], false);
    }

    #[test]
    fn parses_per_package_update_lines_and_summaries() {
        let (changes, status) = parse_update_lines(
            "npm:foo 1.2.0 -> 1.3.0\nnpm:bar 0.1.0 -> 0.2.0\nPackages are already up to date\n",
        );
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0]["name"], "npm:foo");
        assert_eq!(changes[0]["from"], "1.2.0");
        assert_eq!(changes[0]["to"], "1.3.0");
        assert_eq!(status, "Packages are already up to date");
    }

    #[test]
    fn rejects_empty_or_flag_like_sources() {
        assert!(validate_source("  ").is_err());
        assert!(validate_source("--force").is_err());
        assert!(validate_source("npm:a\nnpm:b").is_err());
        assert_eq!(validate_source(" npm:@foo/bar ").unwrap(), "npm:@foo/bar");
    }
}
