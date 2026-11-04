//! Local Pi process configuration, separate from model endpoints and accounts.
//! The webview receives only a redacted projection. Values are injected into
//! child processes, never into Orbit's global environment.
use crate::bridge::{home_dir, read_json_file, write_private_json, RuntimePaths};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::AppHandle;

static SETTINGS_WRITE: Mutex<()> = Mutex::new(());
fn sensitive_default() -> bool {
    true
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentVariable {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default = "sensitive_default")]
    pub sensitive: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub value_redacted: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRuntimeSettings {
    #[serde(default)]
    pub binary_path: String,
    #[serde(default)]
    pub launch_args: String,
    #[serde(default)]
    pub environment: Vec<EnvironmentVariable>,
}

pub(crate) fn settings_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".pi/orbit"))
}
fn read_optional(path: PathBuf) -> Result<Value, String> {
    if path.exists() {
        read_json_file(path, "Orbit Pi 运行配置")
    } else {
        Ok(json!({}))
    }
}

fn load_in(dir: &Path) -> Result<PiRuntimeSettings, String> {
    let mut settings: PiRuntimeSettings =
        serde_json::from_value(read_optional(dir.join("runtime.json"))?)
            .map_err(|e| format!("Pi 运行配置格式不正确：{e}"))?;
    let secrets = read_optional(dir.join("runtime-secrets.json"))?;
    for variable in &mut settings.environment {
        if variable.sensitive {
            variable.value = secrets[&variable.name]
                .as_str()
                .ok_or_else(|| format!("环境变量 {} 的密钥缺失，请重新填写", variable.name))?
                .to_string();
        }
        variable.value_redacted = false;
    }
    Ok(settings)
}

pub(crate) fn load() -> Result<PiRuntimeSettings, String> {
    load_in(&settings_dir()?)
}

impl PiRuntimeSettings {
    pub(crate) fn agent_dir(&self) -> Result<PathBuf, String> {
        self.value("PI_CODING_AGENT_DIR")
            .map(expand_absolute_path)
            .transpose()?
            .map(Ok)
            .unwrap_or_else(crate::sessions::ambient_agent_dir)
    }
    pub fn public_view(&self) -> Self {
        let mut public = self.clone();
        for variable in &mut public.environment {
            if variable.sensitive {
                variable.value.clear();
                variable.value_redacted = true;
            }
        }
        public
    }

    pub(crate) fn apply_environment(&self, command: &mut Command) {
        for variable in &self.environment {
            command.env(&variable.name, &variable.value);
        }
    }

    pub(crate) fn value(&self, name: &str) -> Option<&str> {
        self.environment
            .iter()
            .find(|variable| variable.name == name)
            .map(|variable| variable.value.as_str())
    }

    pub(crate) fn resolved_binary(&self) -> Result<Option<PathBuf>, String> {
        let value = self.binary_path.trim();
        if value.is_empty() {
            return Ok(None);
        }
        let path = if value.contains('/') || value.contains('\\') {
            expand_absolute_path(value)?
        } else {
            let configured = self.value("PATH").and_then(|path| {
                std::env::split_paths(path)
                    .map(|entry| entry.join(value))
                    .find(|entry| entry.is_file())
            });
            configured
                .or_else(|| crate::bridge::executable(value).ok())
                .ok_or("找不到配置的 Pi 可执行文件")?
        };
        if !path.is_file() {
            return Err("Pi 路径不是文件".into());
        }
        path.canonicalize().map(Some).map_err(|e| e.to_string())
    }

    pub(crate) fn arguments(&self) -> Result<Vec<String>, String> {
        parse_launch_args(&self.launch_args)
    }
}

fn expand_absolute_path(value: &str) -> Result<PathBuf, String> {
    let path = if value == "~" {
        home_dir()?
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home_dir()?.join(rest)
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() {
        return Err("Pi 路径和配置目录请使用绝对路径或 ~ 前缀".into());
    }
    Ok(path)
}

pub(crate) fn configured_agent_dir() -> Result<Option<PathBuf>, String> {
    load()?
        .value("PI_CODING_AGENT_DIR")
        .map(expand_absolute_path)
        .transpose()
}

pub(crate) fn parse_launch_args(input: &str) -> Result<Vec<String>, String> {
    let words = shell_words::split(input).map_err(|_| "启动参数的引号未闭合".to_string())?;
    let with_values = [
        "--append-system-prompt",
        "--exclude-tools",
        "-xt",
        "--extension",
        "-e",
        "--model",
        "--models",
        "--name",
        "-n",
        "--prompt-template",
        "--provider",
        "--skill",
        "--system-prompt",
        "--theme",
        "--thinking",
        "--tools",
        "-t",
        "--tui-mode",
        "--use-theme",
    ];
    let flags = [
        "--approve",
        "-a",
        "--no-approve",
        "-na",
        "--no-builtin-tools",
        "-nbt",
        "--no-context-files",
        "-nc",
        "--no-extensions",
        "-ne",
        "--no-prompt-templates",
        "-np",
        "--no-skills",
        "-ns",
        "--no-themes",
        "--no-tools",
        "-nt",
        "--offline",
        "--verbose",
    ];
    let reserved = [
        "--continue",
        "-c",
        "--export",
        "--fork",
        "--help",
        "-h",
        "--list-models",
        "--mode",
        "--no-session",
        "--print",
        "-p",
        "--resume",
        "-r",
        "--session",
        "--session-id",
        "--session-dir",
        "--version",
        "-v",
    ];
    let mut args = Vec::new();
    for word in words {
        if let Some((key, value)) = word.split_once('=') {
            if with_values.contains(&key) {
                args.extend([key.to_string(), value.to_string()]);
                continue;
            }
        }
        args.push(word);
    }
    let mut index = 0;
    let mut provider = false;
    let mut model = false;
    while let Some(argument) = args.get(index) {
        let key = argument.split('=').next().unwrap_or(argument);
        if reserved.contains(&key) {
            return Err(format!("参数 {key} 由 Orbit 管理，不能覆盖"));
        }
        if key == "--api-key" {
            return Err("请将 API Key 放在敏感环境变量中".into());
        }
        if argument == "--" || !argument.starts_with('-') || argument.starts_with('@') {
            return Err("启动参数不能包含消息或附件".into());
        }
        if with_values.contains(&key) {
            if args.get(index + 1).is_none() {
                return Err(format!("参数 {key} 缺少值"));
            }
            provider |= key == "--provider";
            model |= key == "--model";
            index += 2;
        } else if flags.contains(&key) || argument.starts_with("--") && argument.contains('=') {
            index += 1;
        } else if argument.starts_with("--") {
            index += 1;
            if args
                .get(index)
                .is_some_and(|value| !value.starts_with(['-', '@']))
            {
                index += 1;
            }
        } else {
            return Err(format!("不支持的 Pi 参数：{key}"));
        }
    }
    if provider && !model {
        return Err("--provider 必须同时配置 --model".into());
    }
    Ok(args)
}

fn resolve_draft(
    mut draft: PiRuntimeSettings,
    current: &PiRuntimeSettings,
) -> Result<PiRuntimeSettings, String> {
    draft.binary_path = draft.binary_path.trim().to_string();
    draft.arguments()?;
    let mut names = BTreeSet::new();
    for variable in &mut draft.environment {
        variable.name = variable.name.trim().to_string();
        let name = &variable.name;
        if name.is_empty()
            || name.len() > 128
            || !name.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphabetic() || byte == b'_' || index > 0 && byte.is_ascii_digit()
            })
        {
            return Err("环境变量名只能包含字母、数字、下划线，且不能以数字开头".into());
        }
        if !names.insert(name.clone()) {
            return Err(format!("环境变量 {name} 重复"));
        }
        if name.starts_with("ORBIT_")
            || name.starts_with("PI_GUI_")
            || ["HOME", "USERPROFILE", "NODE_PATH", "PI_SESSION_DIR"].contains(&name.as_str())
        {
            return Err(format!("环境变量 {name} 由 Orbit 管理"));
        }
        if variable.value_redacted {
            if !variable.sensitive {
                return Err("已保存的密钥需要重新输入后才能改成明文".into());
            }
            variable.value = current
                .environment
                .iter()
                .find(|item| item.name == *name && item.sensitive)
                .ok_or("已保存的密钥不存在，请重新输入")?
                .value
                .clone();
        }
        if variable.value.contains('\0') {
            return Err(format!("环境变量 {name} 包含无效字符"));
        }
        if name == "PI_CODING_AGENT_DIR" {
            variable.value = expand_absolute_path(&variable.value)?
                .to_string_lossy()
                .into_owned();
        }
        variable.value_redacted = false;
    }
    Ok(draft)
}

fn write_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    write_private_json(&temporary, value)?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(temporary);
        return Err(error.to_string());
    }
    Ok(())
}

fn save_in(dir: &Path, settings: &PiRuntimeSettings) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let secrets: BTreeMap<_, _> = settings
        .environment
        .iter()
        .filter(|item| item.sensitive)
        .map(|item| (&item.name, &item.value))
        .collect();
    write_atomic(&dir.join("runtime-secrets.json"), &json!(secrets))?;
    write_atomic(&dir.join("runtime.json"), &json!(settings.public_view()))
}

#[tauri::command]
pub fn get_pi_runtime_settings() -> Result<Value, String> {
    Ok(json!({"driver":"pi", "environment":"local", "config":load()?.public_view()}))
}

#[tauri::command]
pub fn save_pi_runtime_settings(config: PiRuntimeSettings) -> Result<Value, String> {
    let _guard = SETTINGS_WRITE.lock().map_err(|e| e.to_string())?;
    let config = resolve_draft(config, &load()?)?;
    config.resolved_binary()?;
    save_in(&settings_dir()?, &config)?;
    Ok(json!({"driver":"pi", "environment":"local", "config":config.public_view()}))
}

#[tauri::command]
pub async fn probe_pi_runtime(app: AppHandle, config: PiRuntimeSettings) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = resolve_draft(config, &load()?)?;
        let runtime = RuntimePaths::resolve_with_settings(&app, &home_dir()?, config)?;
        Ok(json!({"ok":true,"pi":runtime.pi,"version":runtime.pi_version,"source":runtime.pi_source}))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_secrets_redacted_and_accepts_literal_launch_parameters() {
        let current = PiRuntimeSettings {
            environment: vec![EnvironmentVariable {
                name: "API_KEY".into(),
                value: "test-secret".into(),
                sensitive: true,
                value_redacted: false,
            }],
            ..Default::default()
        };
        let public = current.public_view();
        assert_eq!(public.environment[0].value, "");
        assert!(public.environment[0].value_redacted);
        let mut draft = public;
        draft.launch_args = "--model='provider/model id' --thinking=high".into();
        let resolved = resolve_draft(draft, &current).unwrap();
        assert_eq!(resolved.environment[0].value, "test-secret");
        assert_eq!(
            resolved.arguments().unwrap(),
            ["--model", "provider/model id", "--thinking", "high"]
        );
        let dir = std::env::temp_dir().join(format!("orbit-pi-config-{}", uuid::Uuid::new_v4()));
        save_in(&dir, &resolved).unwrap();
        assert!(!fs::read_to_string(dir.join("runtime.json"))
            .unwrap()
            .contains("test-secret"));
        assert_eq!(load_in(&dir).unwrap().environment[0].value, "test-secret");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_mode_overrides_messages_and_ambiguous_secret_edits() {
        for args in [
            "--mode=rpc",
            "--session old.jsonl",
            "hello",
            "--plan @file",
            "--provider openai",
            "--api-key abc",
        ] {
            assert!(parse_launch_args(args).is_err(), "{args}");
        }
        assert!(parse_launch_args("--provider openai --model gpt").is_ok());
        assert!(parse_launch_args("--system-prompt '$(touch /tmp/never)' --plan").is_ok());
        let duplicate = PiRuntimeSettings {
            environment: vec![
                EnvironmentVariable {
                    name: "KEY".into(),
                    ..Default::default()
                };
                2
            ],
            ..Default::default()
        };
        assert!(resolve_draft(duplicate, &PiRuntimeSettings::default()).is_err());
    }

    #[test]
    fn private_environment_is_applied_to_the_child_only() {
        let settings = PiRuntimeSettings {
            environment: vec![EnvironmentVariable {
                name: "ORBIT_TEST_PRIVATE_VALUE".into(),
                value: "test-only-secret".into(),
                sensitive: true,
                value_redacted: false,
            }],
            ..Default::default()
        };
        let mut command = Command::new("test-binary");
        let before = std::env::var_os("ORBIT_TEST_PRIVATE_VALUE");
        settings.apply_environment(&mut command);
        assert_eq!(std::env::var_os("ORBIT_TEST_PRIVATE_VALUE"), before);
        assert_eq!(
            command.get_envs().next().unwrap().1.unwrap(),
            "test-only-secret"
        );
        let mut illegal = settings.public_view();
        illegal.environment[0].name = "RENAMED_SECRET".into();
        assert!(resolve_draft(illegal, &settings).is_err());
    }
}
