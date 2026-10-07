//! Inbox backend: GitHub pull requests / issues through the GitHub CLI, and
//! GitLab merge requests through the REST API with a personal access token.
//! The token is stored in Orbit's app-data directory with owner-only
//! permissions on Unix, mirroring how provider keys are handled.

use serde::Serialize;
use std::path::PathBuf;

use tauri::Manager;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn gitlab_secret_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位 Orbit 应用目录：{error}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("gitlab-token");
    #[cfg(unix)]
    {
        if let Ok(meta) = std::fs::metadata(&path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }
    Ok(path)
}

fn run_gh(args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("gh");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .output()
        .map_err(|_| "GitHub CLI（gh）不可用".to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.trim().is_empty() {
            format!("gh {} 失败", args.first().unwrap_or(&""))
        } else {
            stderr.lines().next().unwrap_or_default().to_string()
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub installed: bool,
    pub connected: bool,
}

/// Whether `gh` exists and is authenticated.
#[tauri::command]
pub async fn github_status() -> Result<GithubStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let probe = std::process::Command::new("gh")
            .arg("--version")
            .output();
        let installed = matches!(&probe, Ok(out) if out.status.success());
        if !installed {
            return GithubStatus { installed: false, connected: false };
        }
        let connected = matches!(
            std::process::Command::new("gh").args(["auth", "status"]).output(),
            Ok(out) if out.status.success()
        );
        GithubStatus { installed: true, connected }
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub repo: String,
    pub url: String,
    pub state: String,
    pub author: String,
    pub updated: String,
}

fn push_item(list: &mut Vec<InboxItem>, kind: &str, state: &str, value: &serde_json::Value) {
    let number = value.get("number").and_then(|v| v.as_i64()).unwrap_or(0);
    let repo = value
        .get("repository")
        .and_then(|v| v.get("nameWithOwner"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default();
    let url = value.get("url").and_then(|v| v.as_str()).unwrap_or_default();
    if url.is_empty() {
        return;
    }
    list.push(InboxItem {
        id: format!("{repo}#{number}"),
        kind: kind.into(),
        title: value.get("title").and_then(|v| v.as_str()).unwrap_or("无标题").into(),
        repo,
        url: url.into(),
        state: state.into(),
        author: value
            .get("author")
            .and_then(|v| v.get("login"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        updated: value.get("updatedAt").and_then(|v| v.as_str()).unwrap_or("").into(),
    });
}

fn parse_gh_array(text: &str) -> Vec<serde_json::Value> {
    serde_json::from_str(text).unwrap_or_default()
}

/// Open pull requests that need the user (review-requested) or by the user.
#[tauri::command]
pub async fn github_inbox() -> Result<Vec<InboxItem>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let fields = "--json=number,title,url,updatedAt,author,repository";
        let mut items: Vec<InboxItem> = Vec::new();
        if let Ok(text) = run_gh(&["search", "prs", "--review-requested=@me", "--state=open", "--limit=30", fields]) {
            for value in parse_gh_array(&text) {
                push_item(&mut items, "pr", "review-requested", &value);
            }
        }
        if let Ok(text) = run_gh(&["search", "prs", "--author=@me", "--state=open", "--limit=30", fields]) {
            for value in parse_gh_array(&text) {
                push_item(&mut items, "pr", "authored", &value);
            }
        }
        if let Ok(text) = run_gh(&["search", "issues", "--assignee=@me", "--state=open", "--limit=30", fields]) {
            for value in parse_gh_array(&text) {
                push_item(&mut items, "issue", "assigned", &value);
            }
        }
        items.sort_by(|a, b| b.updated.cmp(&a.updated));
        items.dedup_by(|a, b| a.id == b.id);
        Ok(items)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn gitlab_request(host: &str, token: &str, path: &str) -> Result<Vec<serde_json::Value>, String> {
    let host = host.trim().trim_end_matches('/');
    let api = if host.contains("/api/v") {
        format!("{host}{path}")
    } else {
        format!("{host}/api/v4{path}")
    };
    let url = if api.starts_with("http") { api } else { format!("https://{api}") };
    let mut cmd = std::process::Command::new("curl");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd
        .args([
            "-sS",
            "--max-time",
            "20",
            "-H",
            &format!("PRIVATE-TOKEN: {token}"),
            &url,
        ])
        .output()
        .map_err(|_| "curl 不可用".to_string())?;
    let body = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if body.starts_with('{') {
        let value: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let status = value.get("message").and_then(|v| v.as_str()).unwrap_or("请求失败");
        return Err(format!("GitLab：{status}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("GitLab 返回无法解析：{e}"))
}

fn gitlab_items(host: &str, token: &str) -> Vec<InboxItem> {
    let mut items = Vec::new();
    for (scope, kind, state) in [
        ("assigned_to_me", "mr", "review-requested"),
        ("created_by_me", "mr", "authored"),
    ] {
        let path = format!("/merge_requests?state=opened&scope={scope}&order_by=updated_at&per_page=30");
        let Ok(list) = gitlab_request(host, token, &path) else { continue };
        for value in list {
            let url = value.get("web_url").and_then(|v| v.as_str()).unwrap_or_default();
            if url.is_empty() {
                continue;
            }
            let repo = url
                .split("/-/merge_requests")
                .next()
                .unwrap_or("")
                .split("://")
                .last()
                .unwrap_or("")
                .split('/')
                .skip(1)
                .collect::<Vec<_>>()
                .join("/");
            items.push(InboxItem {
                id: url.to_string(),
                kind: kind.into(),
                title: value.get("title").and_then(|v| v.as_str()).unwrap_or("无标题").into(),
                repo,
                url: url.into(),
                state: state.into(),
                author: value
                    .get("author")
                    .and_then(|v| v.get("username"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .into(),
                updated: value.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").into(),
            });
        }
    }
    items.sort_by(|a, b| b.updated.cmp(&a.updated));
    items
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitlabStatus {
    pub connected: bool,
    #[serde(rename = "host")]
    pub stored_host: Option<String>,
}

/// Stored GitLab connection, without the token.
#[tauri::command]
pub async fn gitlab_status(app: tauri::AppHandle) -> Result<GitlabStatus, String> {
    let path = gitlab_secret_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let (host, token) = text.split_once('\n').ok_or("GitLab 凭据损坏")?;
            Ok(GitlabStatus {
                connected: !token.trim().is_empty(),
                stored_host: Some(host.trim().to_string()),
            })
        }
        Err(_) => Ok(GitlabStatus::default()),
    }
}

/// Verify a GitLab token and store it for the Inbox.
#[tauri::command]
pub async fn gitlab_connect(app: tauri::AppHandle, host: String, token: String) -> Result<String, String> {
    let host = host.trim().trim_end_matches('/').to_string();
    let token = token.trim().to_string();
    if host.is_empty() || token.is_empty() {
        return Err("请填写 GitLab 地址和 Access Token".into());
    }
    let user = gitlab_request(&host, &token, "/user")?;
    let username = user
        .first()
        .and_then(|v| v.get("username"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let path = gitlab_secret_path(&app)?;
    std::fs::write(&path, format!("{host}\n{token}")).map_err(|e| e.to_string())?;
    Ok(username)
}

#[tauri::command]
pub async fn gitlab_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    let path = gitlab_secret_path(&app)?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Open merge requests for the stored GitLab connection.
#[tauri::command]
pub async fn gitlab_inbox(app: tauri::AppHandle) -> Result<Vec<InboxItem>, String> {
    let path = gitlab_secret_path(&app)?;
    let text = std::fs::read_to_string(&path).map_err(|_| "尚未连接 GitLab".to_string())?;
    let (host, token) = text
        .split_once('\n')
        .map(|(host, token)| (host.trim().to_string(), token.trim().to_string()))
        .ok_or("GitLab 凭据损坏")?;
    tauri::async_runtime::spawn_blocking(move || Ok(gitlab_items(&host, &token)))
        .await
        .map_err(|e| e.to_string())?
}
