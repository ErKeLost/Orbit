//! Pi owns OAuth, token refresh and the cross-process credential lock. This
//! module owns only the lifetime of its UI-neutral login helper and a redacted
//! state projection, shared by desktop IPC and remote commands.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, State};

use crate::bridge::{home_dir, RuntimePaths};

pub struct Attempt {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    snapshot: Mutex<Value>,
}

impl Drop for Attempt {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
pub struct ProviderAuthHost(Mutex<Option<Arc<Attempt>>>);

impl Drop for ProviderAuthHost {
    fn drop(&mut self) {
        if let Ok(Some(attempt)) = self.0.get_mut() {
            if let Ok(mut child) = attempt.child.lock() {
                let _ = child.kill();
            }
        }
    }
}

fn helper_command(
    app: &AppHandle,
    operation: &str,
    provider: Option<&str>,
) -> Result<Command, String> {
    let runtime = RuntimePaths::resolve(app, &home_dir()?)?;
    let helper = runtime.resources_dir.join("pi-runtime/provider-auth.js");
    if !helper.is_file() {
        return Err("Orbit 订阅登录组件缺失，请重新打包 Pi runtime".into());
    }
    let mut command = Command::new(&runtime.node);
    runtime.apply_environment(&mut command);
    command.arg(helper).arg(operation).arg(&runtime.agent_dir);
    if let Some(provider) = provider {
        command.arg(provider);
    }
    crate::hide_window_console(&mut command);
    // stderr can contain upstream token endpoint bodies. It is never surfaced
    // in the UI or logs; the helper emits a bounded redacted error on stdout.
    command.stderr(Stdio::null());
    Ok(command)
}

pub(crate) async fn query(
    app: AppHandle,
    operation: &'static str,
    provider: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = helper_command(&app, operation, provider.as_deref())?
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .output()
            .map_err(|e| format!("无法启动 Pi 凭据组件：{e}"))?;
        for line in String::from_utf8_lossy(&output.stdout).lines().rev() {
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match event["type"].as_str() {
                Some("result") => return Ok(event["data"].clone()),
                Some("error") => {
                    return Err(event["message"]
                        .as_str()
                        .unwrap_or("Pi 凭据操作失败")
                        .to_string())
                }
                _ => {}
            }
        }
        Err(format!("Pi 凭据组件退出，未返回结果（{}）", output.status))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_provider_auth(app: AppHandle) -> Result<Value, String> {
    Ok(query(app, "list", None).await?["auth"].clone())
}

#[tauri::command]
pub async fn logout_provider(app: AppHandle, provider: String) -> Result<Value, String> {
    query(app, "logout", Some(provider)).await
}

fn attempt(host: &ProviderAuthHost, id: &str) -> Result<Arc<Attempt>, String> {
    host.0
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .filter(|attempt| attempt.snapshot.lock().is_ok_and(|state| state["id"] == id))
        .cloned()
        .ok_or_else(|| "登录会话已失效，请重新登录".into())
}

fn reduce(state: &mut Value, event: Value) {
    if state["status"] != "running" {
        return;
    }
    match event["type"].as_str() {
        Some("prompt") => {
            state["prompt"] = event;
        }
        Some("prompt_closed") => {
            if state["prompt"]["id"] == event["id"] {
                state["prompt"] = Value::Null;
            }
        }
        Some("auth_url" | "device_code" | "info" | "progress") => {
            // The authorization URL/device code must remain available while a
            // progress event or manual fallback prompt follows it.
            let kind = event["type"].as_str().unwrap().to_string();
            state[&kind] = event;
        }
        Some("done") => {
            state["status"] = json!("done");
            state["prompt"] = Value::Null;
        }
        Some("error") => {
            state["status"] = json!("error");
            state["error"] = event["message"].clone();
            state["prompt"] = Value::Null;
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn start_provider_login(
    app: AppHandle,
    host: State<'_, ProviderAuthHost>,
    provider: String,
) -> Result<Value, String> {
    let mut slot = host.0.lock().map_err(|e| e.to_string())?;
    if slot.as_ref().is_some_and(|attempt| {
        attempt
            .snapshot
            .lock()
            .is_ok_and(|state| state["status"] == "running")
    }) {
        return Err("已有订阅登录正在进行，请先完成或取消".into());
    }
    let mut child = helper_command(&app, "login", Some(&provider))?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动订阅登录：{e}"))?;
    let stdin = child.stdin.take().ok_or("Pi 登录输入不可用")?;
    let stdout = child.stdout.take().ok_or("Pi 登录输出不可用")?;
    let snapshot =
        json!({"id": uuid::Uuid::new_v4().to_string(), "provider": provider, "status": "running"});
    let attempt = Arc::new(Attempt {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        snapshot: Mutex::new(snapshot.clone()),
    });
    *slot = Some(attempt.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(event) = serde_json::from_str(&line) {
                if let Ok(mut state) = attempt.snapshot.lock() {
                    reduce(&mut state, event);
                }
            }
        }
        if let Ok(mut child) = attempt.child.lock() {
            let _ = child.wait();
        }
        if let Ok(mut state) = attempt.snapshot.lock() {
            if state["status"] == "running" {
                state["status"] = json!("error");
                state["error"] = json!("登录进程已退出，请重试");
            }
        }
    });
    Ok(snapshot)
}

#[tauri::command]
pub fn provider_login_status(
    host: State<'_, ProviderAuthHost>,
    id: String,
) -> Result<Value, String> {
    let attempt = attempt(&host, &id)?;
    let snapshot = attempt.snapshot.lock().map_err(|e| e.to_string())?.clone();
    Ok(snapshot)
}

#[tauri::command]
pub fn answer_provider_login(
    host: State<'_, ProviderAuthHost>,
    id: String,
    prompt_id: String,
    value: String,
) -> Result<(), String> {
    let attempt = attempt(&host, &id)?;
    let state = attempt.snapshot.lock().map_err(|e| e.to_string())?;
    if state["status"] != "running" || state["prompt"]["id"] != prompt_id {
        return Err("登录步骤已结束，请等待下一步".into());
    }
    let message = json!({"type": "answer", "id": prompt_id, "value": value});
    let mut stdin = attempt.stdin.lock().map_err(|e| e.to_string())?;
    writeln!(stdin, "{message}")
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_provider_login(host: State<'_, ProviderAuthHost>, id: String) -> Result<(), String> {
    let attempt = attempt(&host, &id)?;
    let mut state = attempt.snapshot.lock().map_err(|e| e.to_string())?;
    if state["status"] == "running" {
        state["status"] = json!("cancelled");
        state["prompt"] = Value::Null;
        if let Ok(mut child) = attempt.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_closes_only_its_prompt_and_terminal_state_is_final() {
        let mut state = json!({"status":"running"});
        reduce(
            &mut state,
            json!({"type":"auth_url","url":"https://example.com/auth"}),
        );
        reduce(&mut state, json!({"type":"prompt","id":"1"}));
        reduce(&mut state, json!({"type":"prompt","id":"2"}));
        reduce(&mut state, json!({"type":"prompt_closed","id":"1"}));
        assert_eq!(state["prompt"]["id"], "2");
        assert_eq!(state["auth_url"]["url"], "https://example.com/auth");
        reduce(&mut state, json!({"type":"done"}));
        reduce(&mut state, json!({"type":"error","message":"late"}));
        assert_eq!(state["status"], "done");
        assert!(state["prompt"].is_null());
    }
}
