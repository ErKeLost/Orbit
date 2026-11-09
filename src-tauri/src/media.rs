//! Media preview metadata for the file pane. The bytes themselves stream to
//! the webview through Tauri's asset protocol (`convertFileSrc`), so images,
//! audio and video never cross the IPC bridge as base64.

use serde::Serialize;
use std::path::{Path, PathBuf};
use serde_json::Value;

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    if path == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

fn mime_for(name: &Path) -> Option<&'static str> {
    let ext = name.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    pub mime: String,
    pub size: u64,
}

/// `None`-like error text for non-media files; the caller decides the view.
#[tauri::command]
pub async fn media_meta(path: String) -> Result<Option<MediaMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = expand_home(&path);
        let Some(mime) = mime_for(&file) else { return Ok(None) };
        let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
        Ok(Some(MediaMeta { mime: mime.into(), size }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The largest file a phone will pull over the pairing socket.
///
/// `read_media_file` answers with base64, so the string on the wire is a third
/// larger than the file and lives in the webview's memory until the blob is
/// built. This is the ceiling that keeps a phone from being asked to hold a
/// video; past it the command fails with a message that says so, which is a
/// better answer than a preview that never appears. The desktop is unaffected:
/// it streams through the asset protocol and has no such limit.
pub const MAX_REMOTE_MEDIA_BYTES: u64 = 24 * 1024 * 1024;

/// Whether a file is too large to send to a phone.
///
/// Split out so the boundary is testable without a 24 MB fixture on disk.
fn over_remote_media_limit(size: u64) -> bool {
    size > MAX_REMOTE_MEDIA_BYTES
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaBytes {
    pub mime: String,
    /// base64 of the file's bytes. The phone decodes it into a `Blob` and hands
    /// the object URL to the same `<img>`/`<video>` markup the desktop uses.
    pub data: String,
}

/// `media_meta`'s counterpart for a device that cannot reach this disk.
///
/// The desktop webview streams media through the asset protocol, which is "this
/// webview reads this machine's disk" and therefore means nothing on a phone. A
/// paired phone asks for the bytes here instead, over the socket it already has.
#[tauri::command]
pub async fn read_media_file(path: String) -> Result<MediaBytes, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = expand_home(&path);
        let mime = mime_for(&file).ok_or_else(|| "不是可预览的媒体文件".to_string())?;
        let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
        if over_remote_media_limit(size) {
            return Err(format!(
                "文件 {:.1} MB，超过手机预览上限 {} MB；请在电脑上查看",
                size as f64 / (1024.0 * 1024.0),
                MAX_REMOTE_MEDIA_BYTES / (1024 * 1024)
            ));
        }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        Ok(MediaBytes {
            mime: mime.into(),
            data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ------------------------------------------------------------------ *
 * Session history images: from inline base64 to one file per image
 * ------------------------------------------------------------------ */

/// Where history images are materialised.
///
/// A session JSONL stores screenshots and attachments as base64 inside the
/// message. Shipping that to the webview means one 169 MB response, a JSON parse
/// of the same bytes, and a `data:` URL string for every image: in the session
/// that motivated this, 166.5 MB of 168.8 MB (98.5%) was image data. Here the
/// bytes are written once and the part keeps only a path; the webview streams it
/// through the asset protocol, which is the same route `media_meta` documents.
pub fn session_media_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|dir| dir.join("session-media"))
}

/// Keep the extracted-image cache bounded. A pruned image is extracted again the
/// next time its message is loaded, so dropping the oldest is safe.
const SESSION_MEDIA_CAP_BYTES: u64 = 512 * 1024 * 1024;

pub fn prune_session_media(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total = 0u64;
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        total += meta.len();
        files.push((entry.path(), meta.len(), meta.modified().unwrap_or(std::time::UNIX_EPOCH)));
    }
    if total <= SESSION_MEDIA_CAP_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, modified) in files {
        if total <= SESSION_MEDIA_CAP_BYTES {
            break;
        }
        // 最近一小时写的文件不删：活事件里的图片只有这一个副本（transcript 里存的
        // 是路径，没有回源偏移），删了就是一张打不开的缩略图。更早的文件属于别的
        // 会话，重新打开时会从会话 JSONL 里再抽一次。
        if now.duration_since(modified).map(|age| age.as_secs() < 3600).unwrap_or(true) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn image_extension(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

fn write_once(path: &Path, bytes: &[u8]) -> bool {
    if path.exists() {
        return true;
    }
    let Some(parent) = path.parent() else { return false };
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    // 同一张图可能被两条连接同时抽取：临时名带时间戳，避免两个写者踩同一个文件。
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temporary = path.with_extension(format!("tmp-{}-{unique}", std::process::id()));
    if std::fs::write(&temporary, bytes).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return false;
    }
    std::fs::rename(&temporary, path).is_ok()
}

/// 会话路径的稳定短标识：图片文件名要能跨重启命中同一张图。
///
/// FNV-1a：几行代码、不需要额外的哈希 crate，碰撞概率对「同一目录下的几十个
/// 会话」足够低（真撞了也只是多一次写文件）。
pub fn session_key(path: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 把一张历史图片落成文件（base64 只在这一侧出现）。
///
/// 桌面端不需要把几 MB 的 base64 走一遍 IPC 再留在 JS 堆里：一张 5MB 的截图
/// 在 JSON 里是 6.7MB 的字符串，到了 V8 里再乘 2（UTF-16），而它只是一张缩略图。
/// 写进 `session-media` 后由 asset 协议直接交给浏览器解码，内存归合成器管，也能被
/// `prune_session_media` 回收。
pub fn write_history_image(dir: &Path, stem: &str, mime: &str, data: &str) -> Option<PathBuf> {
    let path = dir.join(format!("{stem}.{}", image_extension(mime)));
    if path.exists() {
        return Some(path);
    }
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data.as_bytes()).ok()?;
    write_once(&path, &bytes).then_some(path)
}

/// 活事件（`tool_execution_*` / `message_*` / `agent_end`）里的内联图片落成文件。
///
/// 这里不按路径匹配，而是递归找 `{type:"image", mimeType, data}`：pi 的事件形状
/// 不止一种（tool 结果在 `partialResult`/`result`，消息在 `message.content`），
/// 按形状逐一维护迟早会漏一个，漏的那个就是一张几百 MB 的截图。
/// 图片名字用 base64 的 FNV 哈希：同一张图重复送来时只 stat 一次，不重复写盘。
pub fn offload_live_images(payload: &mut Value, dir: &Path) -> usize {
    let mut written = 0;
    walk_images(payload, dir, &mut written);
    if written > 0 {
        prune_occasionally(dir);
    }
    written
}

fn walk_images(node: &mut Value, dir: &Path, written: &mut usize) {
    match node {
        Value::Array(items) => {
            for item in items {
                walk_images(item, dir, written);
            }
        }
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("image") {
                let data = map.get("data").and_then(Value::as_str).map(str::to_owned);
                if let Some(data) = data {
                    let mime = map
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("image/png")
                        .to_string();
                    let stem = format!("live-{:016x}-{}", fnv1a(data.as_bytes()), data.len());
                    let path = dir.join(format!("{stem}.{}", image_extension(&mime)));
                    if path.exists() || write_history_image(dir, &stem, &mime, &data).is_some() {
                        map.insert("file".into(), Value::String(path.to_string_lossy().into_owned()));
                        map.remove("data");
                        *written += 1;
                    }
                    // 没写成功就保留原样的 base64：一张看不见的图比一个大响应更糟。
                }
                return;
            }
            for value in map.values_mut() {
                walk_images(value, dir, written);
            }
        }
        _ => {}
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 每隔一段时间清一次缓存：活事件的图片会持续写盘，不能只靠启动时算总量。
fn prune_occasionally(dir: &Path) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let last = LAST.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 300 {
        return;
    }
    if LAST.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_err() {
        return;
    }
    let dir = dir.to_path_buf();
    std::thread::spawn(move || prune_session_media(&dir));
}

/// Move images out of a `get_messages` / `get_entries` response.
///
/// Those two commands carry the whole history, and that is the only place an
/// image is worth moving out of the payload: live events carry one image at a
/// time, with no repeated cost. Anything unparseable is left exactly as it was —
/// a missing thumbnail is worse than a big response.
pub fn offload_history(payload: &mut Value, dir: &Path) -> usize {
    // `success` 不做硬性要求：失败响应本来就没有 `data.messages`，而一个不带
    // `success` 的成功响应同样值得抽图。
    if payload.get("type").and_then(Value::as_str) != Some("response") {
        return 0;
    }
    match payload.get("command").and_then(Value::as_str) {
        Some("get_messages") => payload
            .pointer_mut("/data/messages")
            .and_then(Value::as_array_mut)
            .map(|messages| messages.iter_mut().map(|message| offload_message(message, dir)).sum())
            .unwrap_or(0),
        Some("get_entries") => payload
            .pointer_mut("/data/entries")
            .and_then(Value::as_array_mut)
            .map(|entries| {
                entries
                    .iter_mut()
                    .map(|entry| {
                        // Entries wrap the message; the entry id is the stable name
                        // for anything the message itself cannot identify.
                        let id = entry.get("id").and_then(Value::as_str).map(str::to_owned);
                        match entry.get_mut("message") {
                            Some(message) => offload_message_with(message, id.as_deref(), dir),
                            None => 0,
                        }
                    })
                    .sum()
            })
            .unwrap_or(0),
        _ => 0,
    }
}

fn offload_message(message: &mut Value, dir: &Path) -> usize {
    offload_message_with(message, None, dir)
}

fn offload_message_with(message: &mut Value, fallback: Option<&str>, dir: &Path) -> usize {
    // `timestamp` is what Pi stamps on every message and what the renderer keys
    // its parts by; the base64 length and the part's ordinal make the file name
    // unique even when two entries share a millisecond.
    let stamp = message
        .get("timestamp")
        .and_then(Value::as_i64)
        .map(|millis| millis.to_string())
        .or_else(|| fallback.map(str::to_owned));
    let Some(stamp) = stamp else { return 0 };
    let Some(content) = message.get_mut("content") else { return 0 };
    let mut ordinal = 0usize;
    offload_content(content, &stamp, dir, &mut ordinal)
}

fn offload_content(node: &mut Value, stamp: &str, dir: &Path, ordinal: &mut usize) -> usize {
    match node {
        Value::Array(items) => items
            .iter_mut()
            .map(|item| offload_content(item, stamp, dir, ordinal))
            .sum(),
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("image") {
                let Some(data) = map.get("data").and_then(Value::as_str).map(str::to_owned) else {
                    return 0;
                };
                let mime = map.get("mimeType").and_then(Value::as_str).unwrap_or("image/png").to_string();
                let index = *ordinal;
                *ordinal += 1;
                // 名字只用消息标识、base64 长度和序号：第二次装载只 stat 一次，
                // 不重新解码 166MB。session JSONL 是不可变的，同一个位置不会换成
                // 另一张图。
                let name = format!("{stamp}-{}-{index}.{}", data.len(), image_extension(&mime));
                let path = dir.join(name);
                if !path.exists() {
                    let Ok(bytes) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data.as_bytes()) else {
                        return 0;
                    };
                    if !write_once(&path, &bytes) {
                        return 0;
                    }
                }
                map.insert("file".into(), Value::String(path.to_string_lossy().into_owned()));
                map.remove("data");
                1
            } else if let Some(content) = map.get_mut("content") {
                offload_content(content, stamp, dir, ordinal)
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// `save_media_file`'s counterpart for an image that already lives on disk.
#[tauri::command]
pub async fn copy_media_file(source: String, destination: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::copy(expand_home(&source), expand_home(&destination))
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_media() {
        assert_eq!(mime_for(Path::new("a/hero.JPG")), Some("image/jpeg"));
        assert_eq!(mime_for(Path::new("x/avicii.mp3")), Some("audio/mpeg"));
        assert_eq!(mime_for(Path::new("x/clip.mp4")), Some("video/mp4"));
        assert_eq!(mime_for(Path::new("x/main.ts")), None);
    }

    use serde_json::json;

    #[test]
    fn history_images_become_files_and_leave_no_base64() {
        let dir = std::env::temp_dir().join(format!("orbit-media-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG\r\n");
        let mut payload = json!({
            "type": "response",
            "command": "get_messages",
            "success": true,
            "data": {"messages": [{
                "role": "toolResult",
                "timestamp": 1_792_230_195_853i64,
                "content": [
                    {"type": "text", "text": "截图"},
                    {"type": "image", "mimeType": "image/png", "data": png}
                ]
            }]}
        });
        assert_eq!(offload_history(&mut payload, &dir), 1);
        let part = &payload["data"]["messages"][0]["content"][1];
        assert!(part.get("data").is_none(), "base64 must not survive the strip");
        let file = part["file"].as_str().expect("the part keeps a path");
        assert_eq!(std::fs::read(file).unwrap(), b"\x89PNG\r\n");
        // 第二次装载不重新写文件，只确认它还在。
        assert_eq!(offload_history(&mut payload, &dir), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "needs ORBIT_MEDIA_BENCH=<a get_messages response line>; prints the strip cost"]
    fn offload_bench_on_a_real_response() {
        let Ok(path) = std::env::var("ORBIT_MEDIA_BENCH") else { return };
        let raw = std::fs::read(&path).expect("response readable");
        let dir = std::env::temp_dir().join(format!("orbit-media-bench-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let parsed = std::time::Instant::now();
        let mut payload: Value = serde_json::from_slice(&raw).expect("response is JSON");
        let parse = parsed.elapsed();
        let cold = std::time::Instant::now();
        let extracted = offload_history(&mut payload, &dir);
        let first = cold.elapsed();
        let warm = std::time::Instant::now();
        let again = offload_history(&mut payload, &dir);
        let second = warm.elapsed();
        println!(
            "parse {} MB in {:?}; extracted {extracted} images in {:?}; re-stat {again} in {:?}",
            raw.len() / 1_000_000,
            parse,
            first,
            second
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_or_unrelated_response_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("orbit-media-noop-{}", std::process::id()));
        let mut payload = json!({"type": "event", "message": {"content": [{"type": "image", "mimeType": "image/png", "data": "AAAA"}]}});
        let before = payload.clone();
        assert_eq!(offload_history(&mut payload, &dir), 0);
        assert_eq!(payload, before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_phone_limit_is_inclusive_at_the_ceiling() {
        assert!(!over_remote_media_limit(MAX_REMOTE_MEDIA_BYTES));
        assert!(!over_remote_media_limit(0));
        assert!(over_remote_media_limit(MAX_REMOTE_MEDIA_BYTES + 1));
    }
}
