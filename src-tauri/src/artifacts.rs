//! Artifacts: 一个 agent 写得出来、用户读得进去的「东西」——一份文档，或者
//! 一页能跑的 HTML。
//!
//! 存储和笔记同一套做法（`app_data/artifacts/<id>.json`，写临时文件再 rename），
//! 因为它们是同一类东西：一段由 agent 产生、被 app 保管的文本。分开目录是为了
//! 让「删掉一个产物」不影响笔记本，也让 html 沙箱只可能读到产物。
//!
//! html 产物由一个**自定义 scheme** 供给沙箱 iframe：`orbitartifact://localhost/<id>`。
//! 它只返回 `kind == Html` 的内容，响应里带 CSP（`sandbox allow-scripts`），
//! 所以页面跑在 opaque origin 里，够不到应用，也发不出请求。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const HTML_SCHEME: &str = "orbitartifact";
pub const ARTIFACTS_CHANGED_EVENT: &str = "orbit:artifacts-changed";
const BODY_MAX: usize = 2_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Document,
    Html,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub kind: ArtifactKind,
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactUpsert {
    pub id: String,
    pub kind: ArtifactKind,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_cwd: Option<String>,
}

pub fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("Invalid {label} id"));
    }
    Ok(())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn artifacts_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("artifacts");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn artifact_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn read_artifact_file(path: &Path) -> Option<Artifact> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_artifact_file(dir: &Path, artifact: &Artifact) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(artifact).map_err(|error| error.to_string())?;
    let path = artifact_file(dir, &artifact.id);
    let tmp = dir.join(format!("{}.tmp", artifact.id));
    std::fs::write(&tmp, raw).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, path).map_err(|error| error.to_string())
}

fn stored_artifact<R: tauri::Runtime>(app: &AppHandle<R>, id: &str) -> Option<Artifact> {
    let dir = artifacts_dir(app).ok()?;
    read_artifact_file(&artifact_file(&dir, id))
}

#[tauri::command(async)]
pub fn artifacts_list(app: AppHandle) -> Result<Vec<Artifact>, String> {
    let dir = artifacts_dir(&app)?;
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            if let Some(artifact) = read_artifact_file(&path) {
                found.push(artifact);
            }
        }
    }
    // 最近改过的在前：读的时候这就是「我上次看的那份」。
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    Ok(found)
}

#[tauri::command(async)]
pub fn artifacts_get(app: AppHandle, id: String) -> Result<Option<Artifact>, String> {
    validate_id(&id, "artifact")?;
    Ok(stored_artifact(&app, &id))
}

#[tauri::command(async)]
pub fn artifacts_upsert(app: AppHandle, artifact: ArtifactUpsert) -> Result<Artifact, String> {
    validate_id(&artifact.id, "artifact")?;
    let source_session_id = match artifact.source_session_id {
        Some(session) => Some(check_source_session(session)?),
        None => None,
    };
    if artifact.body.len() > BODY_MAX {
        return Err("Artifact body is too large".into());
    }
    let title = if artifact.title.trim().is_empty() {
        "Untitled".to_string()
    } else {
        artifact.title.trim().to_string()
    };
    let dir = artifacts_dir(&app)?;
    let previous = read_artifact_file(&artifact_file(&dir, &artifact.id));
    let now = now_millis();
    let saved = Artifact {
        id: artifact.id,
        kind: artifact.kind,
        title,
        body: artifact.body,
        source_session_id,
        source_cwd: artifact.source_cwd,
        // 第一版的时间不动：它是这份东西「什么时候出现」的记录。
        created_at: previous.map(|old| old.created_at).unwrap_or(now),
        updated_at: now,
    };
    write_artifact_file(&dir, &saved)?;
    let _ = app.emit(ARTIFACTS_CHANGED_EVENT, &saved.id);
    Ok(saved)
}

#[tauri::command(async)]
pub fn artifacts_delete(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id, "artifact")?;
    let dir = artifacts_dir(&app)?;
    let path = artifact_file(&dir, &id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    let _ = app.emit(ARTIFACTS_CHANGED_EVENT, &id);
    Ok(())
}

/// 会话身份在我们这里是**路径**（`.../sessions/<file>.jsonl`），不是 uuid。
///
/// 这个字段只用于「从产物回到哪次对话」，永远不进文件名，所以不该拿 id 的规则
/// 去卡它——那会把每一次合法调用都打成失败，而失败又是静默的。
fn check_source_session(value: String) -> Result<String, String> {
    if value.is_empty() || value.len() > 512 || value.contains('\0') {
        return Err("Invalid source session".into());
    }
    Ok(value)
}

/// 页面自己带的 CSP。放在响应头和 `<meta>` 两处：自定义 scheme 的响应头不是
/// 每个 WebView 都会执行，`<meta>` 一定执行。
const HTML_CSP: &str = "sandbox allow-scripts; default-src 'none'; \
    script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; \
    img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; \
    worker-src blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// 每个页面最先跑的一段：接应用发来的主题、把自身高度报回去、把外链交给应用。
const HTML_BOOTSTRAP: &str = r#"<script>(function(){var s=document.createElement("style"),c=document.currentScript,h;c.parentNode.insertBefore(s,c.nextSibling);var base="html{background:var(--background);color:var(--foreground);font-family:var(--font-sans)}body{margin:0}";s.textContent=base;function post(m){if(parent!==window)parent.postMessage(m,"*");}window.addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!=="orbit:theme"||!d.vars)return;var css=":root{color-scheme:"+(d.scheme==="light"?"light":"dark")+";";for(var k in d.vars)if(/^--[a-z0-9-]+$/.test(k))css+=k+":"+String(d.vars[k]).replace(/[;{}<>]/g,"")+";";s.textContent=css+"}"+base;});document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null,u;if(!a)return;try{u=new URL(a.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();if(e.isTrusted)post({type:"orbit:open-link",url:u.href});},true);function size(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;post({type:"orbit:height",height:v});}if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);});}window.addEventListener("load",size);document.addEventListener("DOMContentLoaded",size);post({type:"orbit:ready"});})();</script>"#;

/// 服务 `<scheme>://localhost/<id>`。只给 `Html` 类型，所以文档永远当不成页面。
pub fn serve_html<R: tauri::Runtime>(
    app: &AppHandle<R>,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    if request.method() != tauri::http::Method::GET {
        return not_found();
    }
    let id = request.uri().path().trim_start_matches('/');
    if validate_id(id, "artifact").is_err() {
        return not_found();
    }
    let Some(artifact) = stored_artifact(app, id) else {
        return not_found();
    };
    if artifact.kind != ArtifactKind::Html {
        return not_found();
    }
    let page = with_bootstrap(&artifact.body);
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", HTML_CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(page.into_bytes())
        .unwrap_or_else(|_| not_found())
}

/// 把 bootstrap 插到 `<head>` 开头；没有 head 就插在 `<html>` 之后，再没有就
/// 插在 doctype 之后（绝不插在它前面，那会切到怪异模式）。
fn with_bootstrap(body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let at = tag_end(&lower, "<head")
        .or_else(|| tag_end(&lower, "<html"))
        .or_else(|| {
            let start = lower.len() - lower.trim_start().len();
            lower[start..]
                .starts_with("<!doctype")
                .then(|| lower[start..].find('>').map(|end| start + end + 1))
                .flatten()
        })
        .unwrap_or(0);
    let mut page = String::with_capacity(body.len() + HTML_BOOTSTRAP.len());
    page.push_str(&body[..at]);
    page.push_str(HTML_BOOTSTRAP);
    page.push_str(&body[at..]);
    page
}

/// 第一个 `name` 开标签之后的位置，跳过 `<header>` 这类更长的名字。
fn tag_end(lower: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let start = from + found;
        let next = start + name.len();
        match lower.as_bytes().get(next) {
            Some(b'>' | b'/') | Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c') => {
                return lower[next..].find('>').map(|end| next + end + 1);
            }
            _ => from = next,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_lands_inside_head() {
        let page = with_bootstrap("<!doctype html><html><head><title>x</title></head></html>");
        let head = page.find("<head>").unwrap();
        let script = page.find("<script>").unwrap();
        assert!(script > head);
        assert!(page.starts_with("<!doctype html>"));
    }

    #[test]
    fn bootstrap_after_html_when_there_is_no_head() {
        let page = with_bootstrap("<html><body>hi</body></html>");
        let html = page.find("<html>").unwrap();
        assert!(page.find("<script>").unwrap() > html);
    }

    #[test]
    fn bootstrap_never_precedes_the_doctype() {
        let page = with_bootstrap("<!DOCTYPE html><p>hi");
        assert!(page.starts_with("<!DOCTYPE html>"));
    }

    #[test]
    fn a_session_path_is_not_an_id() {
        // 真实值长这样：路径 + 点号，`validate_id` 一定拒，但它完全合法。
        let path = "2026-10-25T10-48-07-374Z_01a172ac.jsonl";
        assert!(check_source_session(path.to_string()).is_ok());
        assert!(validate_id(path, "session").is_err());
        assert!(check_source_session(String::new()).is_err());
        assert!(check_source_session("x".repeat(600)).is_err());
    }

    #[test]
    fn ids_stay_safe() {
        assert!(validate_id("pr-review", "artifact").is_ok());
        assert!(validate_id("../escape", "artifact").is_err());
        assert!(validate_id("", "artifact").is_err());
    }
}
