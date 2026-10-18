//! Session history commands: the project index, the JSONL projection the chat
//! renders from, single images out of it, and rename/delete/clear.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, State};

use crate::bridge::{project, sessions_dir, Bridge};

pub(crate) fn remove_jsonl_files(root: &Path) -> Result<usize, String> {
    if !root.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in fs::read_dir(root).map_err(|error| format!("读取 Pi 会话目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取 Pi 会话目录失败：{error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取 Pi 会话条目失败：{error}"))?;
        if file_type.is_dir() {
            removed += remove_jsonl_files(&path)?;
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            fs::remove_file(&path).map_err(|error| format!("删除 Pi 会话失败：{error}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn collect_project_files(
    root: &std::path::Path,
    current: &std::path::Path,
    output: &mut Vec<String>,
) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env.example"
            || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build")
        {
            continue;
        }
        if path.is_dir() {
            collect_project_files(root, &path, output);
        } else if path.is_file() {
            if let Ok(relative) = path.strip_prefix(root) {
                output.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
        if output.len() >= 10000 {
            return;
        }
    }
}

#[tauri::command]
pub async fn list_sessions(app: AppHandle, cwd: String) -> Result<Value, String> {
    // 原生会话索引：不再 spawn Node + 全量跑两遍 SDK，直接单遍扫 JSONL +
    // (mtime, size) 增量缓存。新建/切换会话后的刷新从秒级降到毫秒级。
    let _ = &app;
    tauri::async_runtime::spawn_blocking(move || {
        let path = project(&cwd)?;
        let sessions = crate::sessions::list_project_sessions(&path)?;
        Ok(Value::Array(sessions.iter().map(crate::sessions::summary_to_value).collect()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_project_files(cwd: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = project(&cwd)?;
        let mut files = Vec::new();
        collect_project_files(&root, &root, &mut files);
        files.sort_unstable();
        Ok(json!(files))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_session(session_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = sessions_dir()?
            .canonicalize()
            .map_err(|_| "Pi 会话目录不可用".to_string())?;
        let target = PathBuf::from(&session_path)
            .canonicalize()
            .map_err(|_| "会话文件不存在".to_string())?;
        if target.extension().and_then(|value| value.to_str()) != Some("jsonl")
            || !target.starts_with(&root)
        {
            return Err("只能删除 Pi 会话目录中的 JSONL 文件".into());
        }
        fs::remove_file(target).map_err(|e| format!("删除会话失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重命名会话：只往会话 JSONL 末尾追加一条 `session_info`（pi 的 setSessionName
/// 写的也是这条），所以历史、树和缓存都不需要重建。
#[tauri::command]
pub async fn rename_session(session_path: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = sessions_dir()?
            .canonicalize()
            .map_err(|_| "Pi 会话目录不可用".to_string())?;
        let target = PathBuf::from(&session_path)
            .canonicalize()
            .map_err(|_| "会话文件不存在".to_string())?;
        if target.extension().and_then(|value| value.to_str()) != Some("jsonl")
            || !target.starts_with(&root)
        {
            return Err("只能重命名 Pi 会话目录中的 JSONL 文件".into());
        }
        crate::sessions::rename_session_file(&target, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_sessions(state: State<'_, Bridge>) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        let _ = state;
        return Err("清空会话历史请在电脑端执行".into());
    }
    #[cfg(desktop)]
    {
        // Stop every project worker first so no process keeps an open session
        // file while the history directory is being cleared.
        state.stop();
        tauri::async_runtime::spawn_blocking(|| {
            let removed = remove_jsonl_files(&sessions_dir()?)?;
            Ok(json!({ "removed": removed }))
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

/// 直接读会话 JSONL 生成显示消息（`history::project`）。
///
/// `get_messages` 会让 pi 把整段历史（含 base64 图片）重新序列化一遍；这里读同一份
/// 文件、只解析叶路径上的条目，图片换成 `{session, at, ordinal}` 引用。调用方用
/// `count` 和 `get_state.messageCount` 对比，只有一致且 `exact` 才采用。
#[tauri::command]
pub async fn session_project(session_path: String, leaf: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::sessions::sessions_root()?
            .canonicalize()
            .map_err(|_| "Pi 会话目录不可用".to_string())?;
        let target = PathBuf::from(&session_path)
            .canonicalize()
            .map_err(|_| "会话文件不存在".to_string())?;
        if target.extension().and_then(|value| value.to_str()) != Some("jsonl") || !target.starts_with(&root) {
            return Err("只能读取 Pi 会话目录中的 JSONL 文件".into());
        }
        let projection = crate::history::project(&target, leaf.as_deref())?;
        Ok(json!({
            "messages": projection.messages,
            "count": projection.count,
            "exact": projection.exact,
            "leaf": projection.leaf,
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 一条历史消息里的一张图片（按字节偏移 + 图片序号），给桌面渲染用。
#[tauri::command]
pub async fn session_image(session_path: String, at: u64, ordinal: usize) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::sessions::sessions_root()?
            .canonicalize()
            .map_err(|_| "Pi 会话目录不可用".to_string())?;
        let target = PathBuf::from(&session_path)
            .canonicalize()
            .map_err(|_| "会话文件不存在".to_string())?;
        if target.extension().and_then(|value| value.to_str()) != Some("jsonl") || !target.starts_with(&root) {
            return Err("只能读取 Pi 会话目录中的 JSONL 文件".into());
        }
        let (mime, data) = crate::history::read_image(&target, at, ordinal)?;
        Ok(json!({ "mimeType": mime, "data": data }))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 会话文件当前的大小与修改时间。
///
/// 切换会话时用它判断内存里的 transcript 缓存还能不能直接用：文件没动过就不必让
/// pi 把整段历史重新序列化一遍（大会话这一步要 1.1s、169 MB）。
#[tauri::command]
pub async fn session_stamp(session_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::sessions::sessions_root()?
            .canonicalize()
            .map_err(|_| "Pi 会话目录不可用".to_string())?;
        let target = PathBuf::from(&session_path)
            .canonicalize()
            .map_err(|_| "会话文件不存在".to_string())?;
        if target.extension().and_then(|value| value.to_str()) != Some("jsonl") || !target.starts_with(&root) {
            return Err("只能读取 Pi 会话目录中的 JSONL 文件".into());
        }
        let meta = std::fs::metadata(&target).map_err(|error| error.to_string())?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        Ok(json!({ "size": meta.len(), "mtimeMs": mtime_ms }))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn session_turn_durations(app: AppHandle, session_path: String) -> Result<Value, String> {
    let _ = &app;
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::sessions::sessions_root()
            ?.canonicalize()
            .map_err(|_| "Pi 会话目录不可用".to_string())?;
        let target = PathBuf::from(&session_path)
            .canonicalize()
            .map_err(|_| "会话文件不存在".to_string())?;
        if target.extension().and_then(|value| value.to_str()) != Some("jsonl") || !target.starts_with(&root) { return Err("只能读取 Pi 会话目录中的 JSONL 文件".into()); }
        crate::sessions::turn_durations(&target)
    }).await.map_err(|error| error.to_string())?
}
